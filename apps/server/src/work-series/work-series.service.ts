import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { type Actor, permissionsFor } from "../common/access.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma, type WorkSeries } from "../generated/prisma/client.js";
import type {
  AddWorkSeriesEntriesDto,
  CreateWorkSeriesDto,
  UpdateWorkSeriesDto,
  UpdateWorkSeriesEntryDto,
  WorkSeriesEntriesQueryDto,
  WorkSeriesImportIntentDto,
  WorkSeriesQueryDto,
  WorkSeriesRevisionDto,
  WorkSeriesSummaryDto,
} from "./work-series.dto.js";

type Tx = Prisma.TransactionClient;
type Intent =
  | { seriesId: string; expectedRevision: number; label: string | null }
  | { createTitle: string; requestId: string; label: string | null };
export interface LockedWorkSeriesImportIntent {
  intent: Intent;
  actorId: string;
  authorId: string;
}
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_MEMBERS = 10_000;
const visibleWork: Prisma.WorkWhereInput = {
  workflowStatus: { not: "archived" },
  discardedReviewCaseId: null,
};
const entryInclude = {
  work: {
    select: {
      id: true,
      workNumber: true,
      title: true,
      workflowStatus: true,
      reviewStatus: true,
      discardedReviewCaseId: true,
      images: {
        orderBy: { orderIndex: "asc" as const },
        take: 1,
        select: { id: true },
      },
      _count: { select: { images: true } },
    },
  },
} satisfies Prisma.WorkSeriesEntryInclude;
type Entry = Prisma.WorkSeriesEntryGetPayload<{ include: typeof entryInclude }>;
const summaryInclude = {
  author: { select: { displayName: true } },
  _count: { select: { entries: true } },
  entries: {
    where: { work: { ...visibleWork, images: { some: {} } } },
    orderBy: [{ orderIndex: "asc" as const }, { id: "asc" as const }],
    take: 3,
    select: {
      workId: true,
      work: {
        select: {
          images: {
            orderBy: { orderIndex: "asc" as const },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  },
} satisfies Prisma.WorkSeriesInclude;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function label(value: string | null | undefined) {
  return value?.trim() || null;
}
/** The persisted value is the original request, never current membership. Omitted legacy intent is null. */
export function normalizeWorkSeriesImportIntent(
  input?: WorkSeriesImportIntentDto | null,
): Intent | null {
  if (input == null) return null;
  if (
    input.label != null &&
    (typeof input.label !== "string" || input.label.trim().length > 100)
  )
    throw new BadRequestException("系列条目名称无效");
  if (input.seriesId !== undefined) {
    if (
      !UUID.test(input.seriesId) ||
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision! < 0 ||
      input.createTitle !== undefined ||
      input.requestId !== undefined
    )
      throw new BadRequestException("请选择系列及其当前版本，或提供新系列名称");
    return {
      seriesId: input.seriesId,
      expectedRevision: input.expectedRevision!,
      label: label(input.label),
    };
  }
  const title = input.createTitle?.trim();
  if (
    !title ||
    title.length > 200 ||
    !input.requestId ||
    !UUID.test(input.requestId) ||
    input.expectedRevision !== undefined
  )
    throw new BadRequestException("新系列需要名称和稳定的保存标识");
  return {
    createTitle: title,
    requestId: input.requestId,
    label: label(input.label),
  };
}
function entryDto(entry: Entry) {
  const { work } = entry;
  return {
    id: entry.id,
    workId: entry.workId,
    workNumber: work.workNumber,
    title: work.title,
    workflowStatus: work.workflowStatus,
    reviewStatus: work.reviewStatus,
    archived:
      work.workflowStatus === "archived" || work.discardedReviewCaseId !== null,
    orderIndex: entry.orderIndex,
    label: entry.label,
    imageCount: work._count.images,
    coverImageId: work.images[0]?.id ?? null,
  };
}
function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decodeCursor(
  cursor: string | undefined,
  binding: unknown,
): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as Record<string, unknown>;
    if (
      value.binding !== hash(binding) ||
      typeof value.id !== "string" ||
      !UUID.test(value.id)
    )
      throw Error();
    return value;
  } catch {
    throw new BadRequestException("分页标识已失效，请刷新列表");
  }
}

@Injectable()
export class WorkSeriesService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  private async authorize(
    tx: Tx,
    actor: Actor,
    required: "works:metadata" | "candidates:manage" = "works:metadata",
  ) {
    // This is the same account administration barrier used by UsersService.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock_shared(20260905, 2)`;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.userId}::uuid FOR UPDATE`;
    const now = new Date();
    const session = await tx.authSession.findFirst({
      where: {
        id: actor.sessionId,
        userId: actor.userId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: {
          gt: new Date(
            now.getTime() - this.environment.authSessionIdleSeconds * 1000,
          ),
        },
        user: { isActive: true },
      },
      include: { user: { include: { roles: true } } },
    });
    if (!session) throw new UnauthorizedException("登录已失效，请重新登录");
    const permissions = permissionsFor(
      session.user.roles.map(({ role }) => role),
      session.user.mustChangePassword,
    );
    if (!permissions.includes(required))
      throw new ForbiddenException("没有维护作品系列的权限");
    return permissions.includes("works:admin");
  }
  /** Candidate imports use the same account/session fence before locking author,
   * series and candidate rows. Never authorize a new series write from an ID alone. */
  async authorizeImport(tx: Tx, actor: Actor) {
    await this.authorize(tx, actor, "candidates:manage");
  }
  private async authorLock(tx: Tx, authorId: string) {
    await tx.$queryRaw`SELECT id FROM authors WHERE id = ${authorId}::uuid FOR SHARE`;
    if (
      !(await tx.author.findUnique({
        where: { id: authorId },
        select: { id: true },
      }))
    )
      throw new NotFoundException("作者不存在");
  }
  private async seriesLock(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM work_series WHERE id = ${id}::uuid FOR UPDATE`;
    const series = await tx.workSeries.findUnique({ where: { id } });
    if (!series) throw new NotFoundException("系列不存在");
    return series;
  }
  private revision(series: WorkSeries, expected: number) {
    if (series.revision !== expected)
      throw new ConflictException("系列已更新，请刷新后重试");
  }
  private async lockWorks(
    tx: Tx,
    authorId: string,
    ids: string[],
    admin: boolean,
  ) {
    if (!ids.length) return;
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM works WHERE id IN (${Prisma.join([...ids].sort().map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
    );
    const works = await tx.work.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        authorId: true,
        workflowStatus: true,
        discardedReviewCaseId: true,
      },
    });
    if (
      works.length !== ids.length ||
      works.some((work) => work.authorId !== authorId)
    )
      throw new ConflictException("系列只能包含同一作者的现有作品");
    if (
      !admin &&
      works.some(
        (work) =>
          work.workflowStatus === "archived" ||
          work.discardedReviewCaseId !== null,
      )
    )
      throw new ForbiddenException("归档或舍弃作品的系列纠错需要管理员权限");
  }
  private async summary(tx: Tx, id: string): Promise<WorkSeriesSummaryDto> {
    const series = await tx.workSeries.findUnique({
      where: { id },
      include: summaryInclude,
    });
    if (!series) throw new NotFoundException("系列不存在");
    return this.summaryDto(series);
  }
  private summaryDto(
    series: Prisma.WorkSeriesGetPayload<{ include: typeof summaryInclude }>,
  ): WorkSeriesSummaryDto {
    return {
      id: series.id,
      title: series.title,
      authorId: series.authorId,
      authorName: series.author.displayName,
      revision: series.revision,
      memberCount: series._count.entries,
      updatedAt: series.updatedAt.toISOString(),
      coverImages: series.entries.flatMap((entry) =>
        entry.work.images.map((image) => ({
          workId: entry.workId,
          imageId: image.id,
        })),
      ),
    };
  }
  private async audit(
    tx: Tx,
    seriesId: string,
    actorId: string,
    action: string,
    detail: Prisma.InputJsonObject,
    increment = true,
  ) {
    const series = increment
      ? await tx.workSeries.update({
          where: { id: seriesId },
          data: { revision: { increment: 1 } },
        })
      : await tx.workSeries.findUniqueOrThrow({ where: { id: seriesId } });
    await tx.workSeriesAudit.create({
      data: { seriesId, actorId, revision: series.revision, action, detail },
    });
  }
  private async receipt(
    tx: Tx,
    actorId: string,
    requestId: string,
    payload: unknown,
  ) {
    const found = await tx.workSeriesMutationReceipt.findUnique({
      where: { actorId_requestId: { actorId, requestId } },
    });
    if (found && found.payloadHash !== hash(payload))
      throw new ConflictException("保存标识已用于其他系列操作，请刷新后重试");
    return found;
  }
  private async mutate(
    actor: Actor,
    requestId: string,
    payload: unknown,
    authorId: string,
    action: (tx: Tx, admin: boolean) => Promise<WorkSeriesSummaryDto>,
  ) {
    try {
      return await this.db.$transaction(
        async (tx) => {
          const admin = await this.authorize(tx, actor);
          const previous = await this.receipt(
            tx,
            actor.userId,
            requestId,
            payload,
          );
          if (previous)
            return previous.result as unknown as WorkSeriesSummaryDto;
          await this.authorLock(tx, authorId);
          const result = await action(tx, admin);
          await tx.workSeriesMutationReceipt.create({
            data: {
              actorId: actor.userId,
              requestId,
              payloadHash: hash(payload),
              result: result as unknown as Prisma.InputJsonObject,
            },
          });
          return result;
        },
        { timeout: 15_000, maxWait: 15_000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "作品已关联其他系列，或保存请求发生冲突，请刷新后重试",
        );
      throw error;
    }
  }
  private async authorOf(id: string) {
    const series = await this.db.workSeries.findUnique({
      where: { id },
      select: { authorId: true },
    });
    if (!series) throw new NotFoundException("系列不存在");
    return series.authorId;
  }
  private async capacity(tx: Tx, seriesId: string, added: number) {
    if (
      (await tx.workSeriesEntry.count({ where: { seriesId } })) + added >
      MAX_MEMBERS
    )
      throw new ConflictException("系列最多包含10000部作品");
  }
  private async positions(
    tx: Tx,
    seriesId: string,
    afterEntryId: string | null | undefined,
    count: number,
    excludeId?: string,
  ): Promise<number[]> {
    const where = {
      seriesId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    };
    const anchor = afterEntryId
      ? await tx.workSeriesEntry.findFirst({
          where: { ...where, id: afterEntryId },
        })
      : null;
    if (afterEntryId && !anchor)
      throw new ConflictException("排序锚点已更新或不属于该系列，请刷新");
    const before =
      afterEntryId === undefined
        ? await tx.workSeriesEntry.findFirst({
            where,
            orderBy: [{ orderIndex: "desc" }, { id: "desc" }],
          })
        : anchor;
    const after = await tx.workSeriesEntry.findFirst({
      where: {
        ...where,
        ...(before ? { orderIndex: { gt: before.orderIndex } } : {}),
      },
      orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
    });
    const start = before?.orderIndex ?? 0;
    const end = after?.orderIndex ?? start + (count + 1) * 1024;
    const values = Array.from(
      { length: count },
      (_, index) => start + ((end - start) * (index + 1)) / (count + 1),
    );
    if (
      values.every(
        (value, index) =>
          Number.isFinite(value) &&
          value > (values[index - 1] ?? start) &&
          value < end,
      )
    )
      return values;
    // Sparse keys make ordinary moves O(1). Only exhausted floating precision causes
    // a bounded (max 10k members), single SQL rebalance under the series row lock.
    await tx.$executeRaw`UPDATE work_series_entries AS entry SET order_index = ranked.position * 1024 FROM (SELECT id, row_number() OVER (ORDER BY order_index, id) AS position FROM work_series_entries WHERE series_id = ${seriesId}::uuid) AS ranked WHERE entry.id = ranked.id`;
    return this.positions(tx, seriesId, afterEntryId, count, excludeId);
  }
  async list(query: WorkSeriesQueryDto) {
    const limit = query.limit ?? 20;
    const binding = {
      authorId: query.authorId ?? null,
      search: query.search?.trim() ?? "",
      includeArchived: query.includeArchived ?? false,
      limit,
    };
    const cursor = decodeCursor(query.cursor, binding);
    const where: Prisma.WorkSeriesWhereInput = {
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(!query.includeArchived ? { archived: false } : {}),
      ...(binding.search
        ? { title: { contains: binding.search, mode: "insensitive" } }
        : {}),
    };
    if (
      cursor &&
      (typeof cursor.updatedAt !== "string" ||
        !Number.isFinite(new Date(cursor.updatedAt).getTime()))
    )
      throw new BadRequestException("分页标识无效");
    const [total, items] = await Promise.all([
      this.db.workSeries.count({ where }),
      this.db.workSeries.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { updatedAt: { lt: new Date(cursor.updatedAt as string) } },
                  {
                    updatedAt: new Date(cursor.updatedAt as string),
                    id: { lt: cursor.id as string },
                  },
                ],
              }
            : {}),
        },
        include: summaryInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
    ]);
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((series) => this.summaryDto(series)),
      total,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              binding: hash(binding),
              id: last.id,
              updatedAt: last.updatedAt.toISOString(),
            })
          : null,
    };
  }
  async detail(id: string, query: WorkSeriesEntriesQueryDto) {
    return this.db.$transaction((tx) => this.detailSnapshot(tx, id, query), {
      isolationLevel: "RepeatableRead",
    });
  }
  private async detailSnapshot(
    tx: Tx,
    id: string,
    query: WorkSeriesEntriesQueryDto,
  ) {
    const series = await tx.workSeries.findUnique({
      where: { id },
      select: { revision: true, archived: true },
    });
    if (!series) throw new NotFoundException("系列不存在");
    const limit = query.limit ?? 50;
    const binding = {
      seriesId: id,
      revision: series.revision,
      includeHistory: query.includeHistory ?? false,
      limit,
    };
    const cursor = decodeCursor(query.cursor, binding);
    if (
      cursor &&
      (typeof cursor.orderIndex !== "number" ||
        !Number.isFinite(cursor.orderIndex))
    )
      throw new BadRequestException("分页标识无效");
    const where: Prisma.WorkSeriesEntryWhereInput = {
      seriesId: id,
      ...(!query.includeHistory ? { work: visibleWork } : {}),
    };
    const [summary, visibleTotal, entries] = await Promise.all([
      this.summary(tx, id),
      tx.workSeriesEntry.count({ where }),
      tx.workSeriesEntry.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { orderIndex: { gt: cursor.orderIndex as number } },
                  {
                    orderIndex: cursor.orderIndex as number,
                    id: { gt: cursor.id as string },
                  },
                ],
              }
            : {}),
        },
        include: entryInclude,
        orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
    ]);
    const page = entries.slice(0, limit),
      last = page.at(-1);
    return {
      ...summary,
      archived: series.archived,
      visibleTotal,
      entries: page.map(entryDto),
      nextCursor:
        entries.length > limit && last
          ? encodeCursor({
              binding: hash(binding),
              id: last.id,
              orderIndex: last.orderIndex,
            })
          : null,
    };
  }
  async context(workId: string, includeHistory = false) {
    return this.db.$transaction(
      (tx) => this.contextSnapshot(tx, workId, includeHistory),
      {
        isolationLevel: "RepeatableRead",
      },
    );
  }
  private async contextSnapshot(
    tx: Tx,
    workId: string,
    includeHistory: boolean,
  ) {
    if (
      !(await tx.work.findUnique({
        where: { id: workId },
        select: { id: true },
      }))
    )
      throw new NotFoundException("作品不存在");
    const current = await tx.workSeriesEntry.findUnique({
      where: { workId },
      include: entryInclude,
    });
    if (!current)
      return { series: null, currentEntry: null, previous: null, next: null };
    const where: Prisma.WorkSeriesEntryWhereInput = {
      seriesId: current.seriesId,
      ...(!includeHistory ? { work: visibleWork } : {}),
    };
    const [series, previous, next] = await Promise.all([
      this.summary(tx, current.seriesId),
      tx.workSeriesEntry.findFirst({
        where: {
          ...where,
          OR: [
            { orderIndex: { lt: current.orderIndex } },
            { orderIndex: current.orderIndex, id: { lt: current.id } },
          ],
        },
        include: entryInclude,
        orderBy: [{ orderIndex: "desc" }, { id: "desc" }],
      }),
      tx.workSeriesEntry.findFirst({
        where: {
          ...where,
          OR: [
            { orderIndex: { gt: current.orderIndex } },
            { orderIndex: current.orderIndex, id: { gt: current.id } },
          ],
        },
        include: entryInclude,
        orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
      }),
    ]);
    return {
      series,
      currentEntry: entryDto(current),
      previous: previous ? entryDto(previous) : null,
      next: next ? entryDto(next) : null,
    };
  }
  async create(actor: Actor, input: CreateWorkSeriesDto) {
    return this.mutate(
      actor,
      input.requestId,
      { action: "create", ...input },
      input.authorId,
      async (tx, admin) => {
        const workIds = input.workIds ?? [];
        const series = await tx.workSeries.create({
          data: { authorId: input.authorId, title: input.title.trim() },
        });
        await this.lockWorks(tx, series.authorId, workIds, admin);
        await tx.workSeriesEntry.createMany({
          data: workIds.map((workId, index) => ({
            seriesId: series.id,
            workId,
            orderIndex: (index + 1) * 1024,
          })),
        });
        await this.audit(
          tx,
          series.id,
          actor.userId,
          "created",
          { title: series.title, workIds },
          false,
        );
        return this.summary(tx, series.id);
      },
    );
  }
  async update(actor: Actor, id: string, input: UpdateWorkSeriesDto) {
    return this.mutate(
      actor,
      input.requestId,
      { action: "update", id, ...input },
      await this.authorOf(id),
      async (tx, admin) => {
        const series = await this.seriesLock(tx, id);
        this.revision(series, input.expectedRevision);
        if (input.archived !== undefined && !admin)
          throw new ForbiddenException("归档系列需要管理员权限");
        if (input.title !== undefined || input.archived !== undefined) {
          await tx.workSeries.update({
            where: { id },
            data: {
              ...(input.title !== undefined
                ? { title: input.title.trim() }
                : {}),
              ...(input.archived !== undefined
                ? { archived: input.archived }
                : {}),
            },
          });
          await this.audit(tx, id, actor.userId, "updated", {
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.archived !== undefined
              ? { archived: input.archived }
              : {}),
          });
        }
        return this.summary(tx, id);
      },
    );
  }
  async add(actor: Actor, id: string, input: AddWorkSeriesEntriesDto) {
    return this.mutate(
      actor,
      input.requestId,
      { action: "add", id, ...input },
      await this.authorOf(id),
      async (tx, admin) => {
        const series = await this.seriesLock(tx, id);
        this.revision(series, input.expectedRevision);
        if (series.archived)
          throw new ConflictException("系列已归档，无法新增条目");
        await this.lockWorks(tx, series.authorId, input.workIds, admin);
        await this.capacity(tx, id, input.workIds.length);
        const positions = await this.positions(
          tx,
          id,
          input.afterEntryId,
          input.workIds.length,
        );
        await tx.workSeriesEntry.createMany({
          data: input.workIds.map((workId, index) => ({
            seriesId: id,
            workId,
            orderIndex: positions[index],
          })),
        });
        await this.audit(tx, id, actor.userId, "entries_added", {
          workIds: input.workIds,
          afterEntryId: input.afterEntryId ?? null,
        });
        return this.summary(tx, id);
      },
    );
  }
  async updateEntry(
    actor: Actor,
    id: string,
    entryId: string,
    input: UpdateWorkSeriesEntryDto,
  ) {
    return this.mutate(
      actor,
      input.requestId,
      { action: "entry_update", id, entryId, ...input },
      await this.authorOf(id),
      async (tx, admin) => {
        const series = await this.seriesLock(tx, id);
        this.revision(series, input.expectedRevision);
        const entry = await tx.workSeriesEntry.findFirst({
          where: { id: entryId, seriesId: id },
        });
        if (!entry) throw new NotFoundException("系列条目不存在");
        await this.lockWorks(tx, series.authorId, [entry.workId], admin);
        if (input.afterEntryId === entryId)
          throw new BadRequestException("条目不能放到自身之后");
        if (input.label !== undefined || input.afterEntryId !== undefined) {
          const orderIndex =
            input.afterEntryId !== undefined
              ? (
                  await this.positions(tx, id, input.afterEntryId, 1, entryId)
                )[0]
              : entry.orderIndex;
          await tx.workSeriesEntry.update({
            where: { id: entryId },
            data: {
              orderIndex,
              ...(input.label !== undefined
                ? { label: label(input.label) }
                : {}),
            },
          });
          await this.audit(tx, id, actor.userId, "entry_updated", {
            entryId,
            workId: entry.workId,
            ...(input.label !== undefined ? { label: label(input.label) } : {}),
            ...(input.afterEntryId !== undefined
              ? { afterEntryId: input.afterEntryId }
              : {}),
          });
        }
        return this.summary(tx, id);
      },
    );
  }
  async remove(
    actor: Actor,
    id: string,
    entryId: string,
    input: WorkSeriesRevisionDto,
  ) {
    return this.mutate(
      actor,
      input.requestId,
      { action: "entry_remove", id, entryId, ...input },
      await this.authorOf(id),
      async (tx, admin) => {
        const series = await this.seriesLock(tx, id);
        this.revision(series, input.expectedRevision);
        const entry = await tx.workSeriesEntry.findFirst({
          where: { id: entryId, seriesId: id },
        });
        if (!entry) throw new NotFoundException("系列条目不存在");
        await this.lockWorks(tx, series.authorId, [entry.workId], admin);
        await tx.workSeriesEntry.delete({ where: { id: entryId } });
        await this.audit(tx, id, actor.userId, "entry_removed", {
          entryId,
          workId: entry.workId,
          label: entry.label,
        });
        return this.summary(tx, id);
      },
    );
  }

  /** Caller holds the actor/account barrier then Author lock. Invoke BEFORE Candidate lock.
   * No revision check or creation here: a waiter may discover an already-imported candidate.
   * Replays compare immutable Work.candidateImportSeriesIntent and never call attach again. */
  async lockImportIntent(
    tx: Tx,
    actorId: string,
    authorId: string,
    input?: WorkSeriesImportIntentDto | null,
  ): Promise<LockedWorkSeriesImportIntent | null> {
    const intent = normalizeWorkSeriesImportIntent(input);
    if (!intent) return null;
    if ("seriesId" in intent) {
      const series = await this.seriesLock(tx, intent.seriesId);
      if (series.authorId !== authorId)
        throw new ConflictException("系列与候选作者不一致");
    } else {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`work-series-import:${actorId}:${intent.requestId}`}, 0))`;
      // Existing create-intent receipt can target an already populated series; lock
      // it before Candidate, exactly like a directly selected existing series.
      const receipt = await this.receipt(tx, actorId, intent.requestId, {
        action: "import_create",
        authorId,
        title: intent.createTitle,
      });
      if (receipt) {
        const seriesId = (receipt.result as Prisma.JsonObject).seriesId;
        if (typeof seriesId !== "string")
          throw new ConflictException("系列创建记录无效");
        await this.seriesLock(tx, seriesId);
      }
    }
    return { intent, actorId, authorId };
  }
  /** Caller has verified a first pending candidate, created its Work in this same transaction,
   * and holds Candidate (and all prior) locks. Does not change Work revisions or events. */
  async attachImportedWork(
    tx: Tx,
    actorId: string,
    authorId: string,
    workId: string,
    locked: LockedWorkSeriesImportIntent | null,
  ): Promise<void> {
    if (!locked) return;
    if (locked.actorId !== actorId || locked.authorId !== authorId)
      throw new ConflictException("系列入库锁与当前请求不匹配");
    const { intent } = locked;
    let series: WorkSeries;
    if ("seriesId" in intent) {
      series = await tx.workSeries.findUniqueOrThrow({
        where: { id: intent.seriesId },
      });
      this.revision(series, intent.expectedRevision);
    } else {
      const payload = {
        action: "import_create",
        authorId,
        title: intent.createTitle,
      };
      const receipt = await this.receipt(
        tx,
        actorId,
        intent.requestId,
        payload,
      );
      if (receipt)
        series = await tx.workSeries.findUniqueOrThrow({
          where: {
            id: (receipt.result as Prisma.JsonObject).seriesId as string,
          },
        });
      else {
        series = await tx.workSeries.create({
          data: { authorId, title: intent.createTitle },
        });
        await this.audit(
          tx,
          series.id,
          actorId,
          "created",
          { title: series.title, candidateImport: true },
          false,
        );
        await tx.workSeriesMutationReceipt.create({
          data: {
            actorId,
            requestId: intent.requestId,
            payloadHash: hash(payload),
            result: { seriesId: series.id },
          },
        });
      }
    }
    if (series.authorId !== authorId || series.archived)
      throw new ConflictException("系列作者不一致或已归档");
    const work = await tx.work.findUnique({
      where: { id: workId },
      select: { authorId: true, candidateImportSeriesIntent: true },
    });
    if (
      !work ||
      work.authorId !== authorId ||
      canonical(work.candidateImportSeriesIntent) !== canonical(intent)
    )
      throw new ConflictException("作品与首次系列入库意图不一致");
    await this.capacity(tx, series.id, 1);
    const [orderIndex] = await this.positions(tx, series.id, undefined, 1);
    await tx.workSeriesEntry.create({
      data: { seriesId: series.id, workId, orderIndex, label: intent.label },
    });
    await this.audit(tx, series.id, actorId, "candidate_imported", {
      workId,
      label: intent.label,
    });
  }
}
