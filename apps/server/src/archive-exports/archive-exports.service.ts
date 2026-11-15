import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Actor } from "../common/access.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma, type ArchiveExportRun } from "../generated/prisma/client.js";
import { JobsService } from "../jobs/jobs.service.js";
import {
  ARCHIVE_DELETE,
  ARCHIVE_PACKAGE,
  ARCHIVE_PREPARE,
  ARCHIVE_SCOPE,
  archiveHash,
  assertArchiveAdministrator,
  decodeArchiveCursor,
  encodeArchiveCursor,
  terminalArchiveStatuses,
} from "./archive-common.js";
import { ARCHIVE_STORAGE, type ArchiveStorage } from "./archive-storage.js";
import { visitArchiveMonth } from "./archive-selection.js";
import type {
  ArchiveExportDownloadDto,
  ArchiveExportScopeDto,
  ArchiveExportMutationDto,
  ArchiveExportPageQueryDto,
  ArchiveExportPreviewDto,
  ArchiveExportRunDto,
  ArchiveExportSettingsInputDto,
  CreateArchiveExportDto,
  DeleteArchiveExportFilesDto,
  ArchiveExportSettingsDto,
  ArchiveExportListDto,
  ArchiveExportPackageListDto,
  ArchiveExportIssueListDto,
} from "./archive-exports.dto.js";

export function archiveRunDto(run: ArchiveExportRun): ArchiveExportRunDto {
  return {
    id: run.id,
    revision: run.revision,
    status: run.status as ArchiveExportRunDto["status"],
    year: run.year,
    month: run.month,
    content: run.content as ArchiveExportRunDto["content"],
    includeArchived: run.includeArchived,
    includeDiscarded: run.includeDiscarded,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    expiresAt: run.expiresAt?.toISOString() ?? null,
    workCount: run.workCount,
    imageCount: run.imageCount,
    textCount: run.textCount,
    missingRenderedCount: run.missingRenderedCount,
    warningCount: run.warningCount,
    failureCount: run.failureCount,
    estimatedBytes: String(run.estimatedBytes),
    completedBytes: String(run.completedBytes),
    packageCount: run.packageCount,
    completedPackageCount: run.completedPackageCount,
    capturedMonthCount: run.capturedMonthCount,
    error: run.error,
    filesStatus: run.filesStatus as ArchiveExportRunDto["filesStatus"],
    filesDeletedAt: run.filesDeletedAt?.toISOString() ?? null,
    deletionError: run.deletionError,
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const archiveScope = (input: ArchiveExportScopeDto) => ({
  year: input.year,
  month: input.month ?? null,
  content: input.content,
  includeArchived: input.includeArchived ?? false,
  includeDiscarded: input.includeDiscarded ?? false,
});

@Injectable()
export class ArchiveExportsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(ARCHIVE_STORAGE) private readonly storage: ArchiveStorage | null,
  ) {}
  get enabled() {
    return this.environment.archiveExports.enabled && this.storage !== null;
  }
  private requireEnabled() {
    if (!this.enabled)
      throw new ServiceUnavailableException("归档导出尚未启用或存储不可用");
  }
  private async requireRun(tx: Prisma.TransactionClient, id: string) {
    const run = await tx.archiveExportRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException("归档任务不存在");
    return run;
  }
  async settings(actor: Actor): Promise<ArchiveExportSettingsDto> {
    return this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      const settings = await tx.archiveExportSettings.findUnique({
        where: { id: "global" },
      });
      return {
        enabled: this.enabled,
        revision: settings?.revision ?? 0,
        bandwidthLimitMiB: settings?.bandwidthLimitMiB ?? 0,
        packageTargetBytes: String(
          this.environment.archiveExports.packageTargetBytes,
        ),
        retentionDays: this.environment.archiveExports.retentionDays,
      };
    });
  }
  async updateSettings(
    actor: Actor,
    input: ArchiveExportSettingsInputDto,
  ): Promise<ArchiveExportSettingsDto> {
    await this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:archive-settings'))`;
      const settings = await tx.archiveExportSettings.upsert({
        where: { id: "global" },
        create: { id: "global" },
        update: {},
      });
      if (settings.revision !== input.expectedRevision)
        throw new ConflictException("归档设置已变化，请刷新后重试");
      if (settings.bandwidthLimitMiB !== input.bandwidthLimitMiB) {
        await tx.archiveExportSettings.update({
          where: { id: "global" },
          data: {
            bandwidthLimitMiB: input.bandwidthLimitMiB,
            revision: { increment: 1 },
          },
        });
        await tx.accountAudit.create({
          data: {
            actorId: actor.userId,
            action: "archive.settings.update",
            detail: { bandwidthLimitMiB: input.bandwidthLimitMiB },
          },
        });
      }
    });
    return this.settings(actor);
  }
  async preview(
    actor: Actor,
    input: ArchiveExportScopeDto,
  ): Promise<ArchiveExportPreviewDto> {
    this.requireEnabled();
    const result = {
      workCount: 0,
      imageCount: 0,
      textCount: 0,
      missingRenderedCount: 0,
      estimatedBytes: "0",
      warningCount: 0,
      failureCount: 0,
    };
    let bytes = 0n;
    for (const month of input.month
      ? [input.month]
      : Array.from({ length: 12 }, (_, i) => i + 1)) {
      await this.db.$transaction((tx) =>
        assertArchiveAdministrator(tx, actor, this.environment),
      );
      await this.db.$transaction(
        async (tx) => {
          await visitArchiveMonth(tx, input, month, async (work) => {
            result.workCount++;
            result.imageCount += work.entries.filter(
              (e) => e.kind === "raw" || e.kind === "rendered",
            ).length;
            result.textCount += work.entries.filter(
              (e) => e.kind === "text",
            ).length;
            result.missingRenderedCount += Number(work.missingRendered);
            result.warningCount += work.issues.length;
            result.failureCount += Number(work.failedText);
            bytes += work.entries.reduce(
              (sum, e) =>
                sum + e.size + BigInt(256 + 2 * Buffer.byteLength(e.path)),
              0n,
            );
            if (bytes > BigInt(this.environment.archiveExports.maxRunBytes))
              throw new BadRequestException("所选范围超过单任务容量上限");
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 120_000,
        },
      );
    }
    await this.db.$transaction((tx) =>
      assertArchiveAdministrator(tx, actor, this.environment),
    );
    result.estimatedBytes = String(bytes);
    return result;
  }
  async create(
    actor: Actor,
    input: CreateArchiveExportDto,
  ): Promise<ArchiveExportRunDto> {
    this.requireEnabled();
    const scope = archiveScope(input);
    const payloadHash = archiveHash(JSON.stringify(scope));
    const replay = await this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      return tx.archiveExportRun.findUnique({
        where: {
          actorId_idempotencyKey: {
            actorId: actor.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
    });
    if (replay) {
      if (replay.payloadHash !== payloadHash)
        throw new ConflictException("幂等键已用于其他归档范围");
      return archiveRunDto(replay);
    }
    const preview = await this.preview(actor, input);
    return this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      await this.jobs.lockScope(tx, "heavy", ARCHIVE_SCOPE);
      const previous = await tx.archiveExportRun.findUnique({
        where: {
          actorId_idempotencyKey: {
            actorId: actor.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (previous) {
        if (previous.payloadHash !== payloadHash)
          throw new ConflictException("幂等键已用于其他归档范围");
        return archiveRunDto(previous);
      }
      if (
        await tx.archiveExportRun.count({
          where: { status: { notIn: terminalArchiveStatuses }, payloadHash },
        })
      )
        throw new ConflictException("相同范围已有活动归档任务");
      if (
        (await tx.archiveExportRun.count({
          where: { status: { notIn: terminalArchiveStatuses } },
        })) >= this.environment.archiveExports.maxActiveRuns
      )
        throw new ConflictException("活动归档任务已达上限");
      const cache = await tx.archiveExportRun.aggregate({
        where: { filesStatus: { not: "deleted" } },
        _sum: { estimatedBytes: true },
      });
      if (
        (cache._sum.estimatedBytes ?? 0n) + BigInt(preview.estimatedBytes) >
        BigInt(this.environment.archiveExports.maxCacheBytes)
      )
        throw new ConflictException("归档缓存容量不足，请先删除旧归档文件");
      const run = await tx.archiveExportRun.create({
        data: {
          ...scope,
          actorId: actor.userId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          estimatedBytes: BigInt(preview.estimatedBytes),
          deadlineAt: new Date(
            Date.now() +
              this.environment.archiveExports.deadlineHours * 3_600_000,
          ),
        },
      });
      await this.jobs.enqueue(
        {
          kind: ARCHIVE_PREPARE,
          resourceId: run.id,
          actorId: actor.userId,
          executionScope: ARCHIVE_SCOPE,
          idempotencyKey: `archive:prepare:${run.id}:1`,
          payload: { runId: run.id, generation: 1 },
        },
        tx,
      );
      await tx.accountAudit.create({
        data: {
          actorId: actor.userId,
          action: "archive.create",
          detail: { runId: run.id, ...scope },
        },
      });
      return archiveRunDto(run);
    });
  }
  async list(
    actor: Actor,
    query: ArchiveExportPageQueryDto,
  ): Promise<ArchiveExportListDto> {
    const cursor = decodeArchiveCursor<{ id: string; createdAt: string }>(
      query.cursor,
      (v): v is { id: string; createdAt: string } =>
        !!v &&
        typeof v === "object" &&
        "id" in v &&
        typeof v.id === "string" &&
        uuid.test(v.id) &&
        "createdAt" in v &&
        typeof v.createdAt === "string" &&
        Number.isFinite(Date.parse(v.createdAt)),
    );
    return this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      const limit = query.limit ?? 10;
      const rows = await tx.archiveExportRun.findMany({
        where: cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                {
                  createdAt: new Date(cursor.createdAt),
                  id: { lt: cursor.id },
                },
              ],
            }
          : {},
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      return {
        items: items.map(archiveRunDto),
        nextCursor:
          rows.length > limit
            ? encodeArchiveCursor({
                id: items.at(-1)!.id,
                createdAt: items.at(-1)!.createdAt.toISOString(),
              })
            : null,
      };
    });
  }
  async get(actor: Actor, id: string): Promise<ArchiveExportRunDto> {
    return this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      return archiveRunDto(await this.requireRun(tx, id));
    });
  }
  async packages(
    actor: Actor,
    id: string,
    query: ArchiveExportPageQueryDto,
  ): Promise<ArchiveExportPackageListDto> {
    const cursor = decodeArchiveCursor<number>(
      query.cursor,
      (v): v is number => Number.isInteger(v) && Number(v) > 0,
    );
    return this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      const run = await this.requireRun(tx, id);
      const limit = query.limit ?? 20;
      const rows = await tx.archiveExportPackage.findMany({
        where: { runId: id, ...(cursor ? { ordinal: { gt: cursor } } : {}) },
        orderBy: { ordinal: "asc" },
        take: limit + 1,
      });
      const items = rows.slice(0, limit);
      return {
        items: items.map((p) => ({
          id: p.id,
          ordinal: p.ordinal,
          status: p.status,
          fileName: p.fileName,
          bytes: p.bytes === null ? null : String(p.bytes),
          checksum: p.checksum,
          error: p.error,
          downloadable:
            this.enabled &&
            p.status === "succeeded" &&
            !!p.fileObjectId &&
            run.filesStatus === "available" &&
            (!run.expiresAt || run.expiresAt > new Date()),
        })),
        nextCursor:
          rows.length > limit
            ? encodeArchiveCursor(items.at(-1)!.ordinal)
            : null,
      };
    });
  }
  async issues(
    actor: Actor,
    id: string,
    query: ArchiveExportPageQueryDto,
  ): Promise<ArchiveExportIssueListDto> {
    const cursor = decodeArchiveCursor<{ workNumber: number; id: string }>(
      query.cursor,
      (v): v is { workNumber: number; id: string } =>
        !!v &&
        typeof v === "object" &&
        "id" in v &&
        typeof v.id === "string" &&
        uuid.test(v.id) &&
        "workNumber" in v &&
        Number.isInteger(v.workNumber),
    );
    return this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      await this.requireRun(tx, id);
      const limit = query.limit ?? 20;
      const rows = await tx.archiveExportWorkSnapshot.findMany({
        where: {
          runId: id,
          NOT: { issues: { equals: [] } },
          ...(cursor
            ? {
                OR: [
                  { workNumber: { gt: cursor.workNumber } },
                  { workNumber: cursor.workNumber, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ workNumber: "asc" }, { id: "asc" }],
        take: limit + 1,
      });
      const items = rows.slice(0, limit).map((s) => ({
        id: s.id,
        workId: s.workId,
        workNumber: s.workNumber,
        codes: Array.isArray(s.issues)
          ? s.issues.filter((v): v is string => typeof v === "string")
          : [],
      }));
      return {
        items,
        nextCursor:
          rows.length > limit
            ? encodeArchiveCursor({
                workNumber: items.at(-1)!.workNumber,
                id: items.at(-1)!.id,
              })
            : null,
      };
    });
  }
  async download(
    actor: Actor,
    id: string,
    packageId: string,
  ): Promise<ArchiveExportDownloadDto> {
    this.requireEnabled();
    // Sign inside the short locked authorization transaction. No key comes from
    // the request; deletion takes the same run lock before changing availability.
    return this.db.$transaction(async (tx) => {
      await assertArchiveAdministrator(tx, actor, this.environment);
      await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${id}::uuid FOR SHARE`;
      const run = await this.requireRun(tx, id);
      const pkg = await tx.archiveExportPackage.findFirst({
        where: { id: packageId, runId: id },
        include: { fileObject: true },
      });
      if (!pkg) throw new NotFoundException("归档分包不存在");
      if (
        run.filesStatus !== "available" ||
        (run.expiresAt && run.expiresAt <= new Date()) ||
        pkg.status !== "succeeded" ||
        !pkg.fileObject
      )
        throw new ConflictException("归档分包不可下载或已经到期");
      return {
        url: await this.storage!.signedDownload(
          pkg.fileObject.objectKey,
          300,
          pkg.fileName,
        ),
        expiresInSeconds: 300,
        fileName: pkg.fileName,
      };
    });
  }
  async mutate(
    actor: Actor,
    id: string,
    operation: "cancel" | "retry" | "delete-files",
    input: ArchiveExportMutationDto | DeleteArchiveExportFilesDto,
  ): Promise<ArchiveExportRunDto> {
    this.requireEnabled();
    if (
      operation === "delete-files" &&
      (!("confirmedDownloaded" in input) || input.confirmedDownloaded !== true)
    )
      throw new BadRequestException("请先确认已下载并核对归档文件");
    const payloadHash = archiveHash(
      JSON.stringify({
        id,
        operation,
        expectedRevision: input.expectedRevision,
        ...(operation === "delete-files" ? { confirmedDownloaded: true } : {}),
      }),
    );
    return this.db.$transaction(
      async (tx) => {
        await assertArchiveAdministrator(tx, actor, this.environment);
        await this.jobs.lockScope(tx, "heavy", ARCHIVE_SCOPE);
        // Jobs precede run locks, matching admission/execution/settlement order.
        await tx.$queryRaw`SELECT j.id FROM background_jobs j WHERE j.execution_scope=${ARCHIVE_SCOPE} AND (j.resource_id=${id}::uuid OR j.resource_id IN (SELECT p.id FROM archive_export_packages p WHERE p.run_id=${id}::uuid)) ORDER BY j.id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM archive_export_runs WHERE id=${id}::uuid FOR UPDATE`;
        let run = await this.requireRun(tx, id);
        const replay = await tx.archiveExportMutation.findUnique({
          where: {
            actorId_idempotencyKey: {
              actorId: actor.userId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (replay) {
          if (replay.runId !== id || replay.payloadHash !== payloadHash)
            throw new ConflictException("幂等键已用于其他操作");
          return archiveRunDto(run);
        }
        if (run.revision !== input.expectedRevision)
          throw new ConflictException("归档任务已变化，请刷新后重试");
        if (operation === "cancel") {
          if (terminalArchiveStatuses.includes(run.status))
            throw new ConflictException("归档任务已经结束");
          await tx.backgroundJob.updateMany({
            where: {
              executionScope: ARCHIVE_SCOPE,
              status: "queued",
              OR: [
                { resourceId: id },
                {
                  resourceId: {
                    in: (
                      await tx.archiveExportPackage.findMany({
                        where: { runId: id },
                        select: { id: true },
                      })
                    ).map((p) => p.id),
                  },
                },
              ],
            },
            data: {
              status: "failed",
              completedAt: new Date(),
              lastError: "archive_cancelled",
            },
          });
          await tx.archiveExportPackage.updateMany({
            where: { runId: id, status: { in: ["queued", "failed"] } },
            data: { status: "cancelled" },
          });
          run = await tx.archiveExportRun.update({
            where: { id },
            data: { status: "cancelling", revision: { increment: 1 } },
          });
        } else if (operation === "retry") {
          if (
            !["failed", "partial", "cancelled"].includes(run.status) ||
            run.filesStatus !== "available" ||
            (run.expiresAt && run.expiresAt <= new Date())
          )
            throw new ConflictException("此归档不可重试，请新建任务");
          if (run.deadlineAt <= new Date())
            throw new ConflictException(
              "此归档已经超过任务截止时间，请新建任务",
            );
          if (
            await tx.archiveExportAttempt.count({
              where: { package: { runId: id }, settledAt: null },
            })
          )
            throw new ConflictException("旧执行尚未确认停止，不能重试");
          const generation = run.generation + 1;
          if (
            (await tx.archiveExportRun.count({
              where: {
                id: { not: id },
                status: { notIn: terminalArchiveStatuses },
              },
            })) >= this.environment.archiveExports.maxActiveRuns
          )
            throw new ConflictException("活动归档任务已达上限");
          // Prepared snapshots/pins are reused. A failed prepare resumes uncaptured
          // months; successfully completed packages are never regenerated.
          const packageRows = await tx.archiveExportPackage.findMany({
            where: { runId: id, status: { not: "succeeded" } },
            select: { id: true },
          });
          for (const pkg of packageRows) {
            const job = await this.jobs.enqueue(
              {
                kind: ARCHIVE_PACKAGE,
                resourceId: pkg.id,
                actorId: actor.userId,
                executionScope: ARCHIVE_SCOPE,
                idempotencyKey: `archive:package:${pkg.id}:${generation}`,
                payload: { runId: id, packageId: pkg.id, generation },
              },
              tx,
            );
            await tx.archiveExportPackage.update({
              where: { id: pkg.id },
              data: { status: "queued", error: null, jobId: job.id },
            });
          }
          const prepared =
            run.capturedMonthCount === (run.month ? 1 : 12) &&
            run.packageCount > 0;
          if (!prepared)
            await this.jobs.enqueue(
              {
                kind: ARCHIVE_PREPARE,
                resourceId: id,
                actorId: actor.userId,
                executionScope: ARCHIVE_SCOPE,
                idempotencyKey: `archive:prepare:${id}:${generation}`,
                payload: { runId: id, generation },
              },
              tx,
            );
          run = await tx.archiveExportRun.update({
            where: { id },
            data: {
              status: prepared ? "generating" : "queued",
              generation,
              error: null,
              completedAt: null,
              expiresAt: null,
              revision: { increment: 1 },
            },
          });
        } else {
          if (!terminalArchiveStatuses.includes(run.status))
            throw new ConflictException(
              "任务结束并确认执行停止后才能删除归档文件",
            );
          if (
            await tx.archiveExportAttempt.count({
              where: { package: { runId: id }, settledAt: null },
            })
          )
            throw new ConflictException("旧执行尚未确认停止，不能删除归档文件");
          if (run.filesStatus === "deleted")
            throw new ConflictException("归档文件已经删除");
          const job = await this.jobs.enqueue(
            {
              kind: ARCHIVE_DELETE,
              resourceId: id,
              actorId: actor.userId,
              executionScope: ARCHIVE_SCOPE,
              idempotencyKey: `archive:delete:${id}:${input.idempotencyKey}`,
              payload: { runId: id, generation: run.generation },
            },
            tx,
          );
          void job;
          run = await tx.archiveExportRun.update({
            where: { id },
            data: {
              filesStatus: "deleting",
              deletionError: null,
              revision: { increment: 1 },
            },
          });
        }
        await tx.archiveExportMutation.create({
          data: {
            actorId: actor.userId,
            runId: id,
            operation,
            idempotencyKey: input.idempotencyKey,
            payloadHash,
          },
        });
        await tx.accountAudit.create({
          data: {
            actorId: actor.userId,
            action: `archive.${operation}`,
            detail: {
              runId: id,
              ...(operation === "delete-files"
                ? { confirmedDownloaded: true }
                : {}),
            },
          },
        });
        return archiveRunDto(run);
      },
      { timeout: 30_000 },
    );
  }
}
