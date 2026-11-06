import {
  lockAuthorTagCatalog,
  normalizeAuthorTagName,
  normalizeAuthorTagSelection,
  resolveAuthorTagSelections,
} from "./author-tags.js";
import { createHash } from "node:crypto";
import { DirectUploadsService } from "../transfers/direct-uploads.service.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { ProfileProofs } from "./profile-proof.js";
import {
  profileAvatarDiagnostic,
  type ProfileAvatarStage,
} from "./profile-avatar-diagnostic.js";
import { sourceDiagnostic } from "../source-ingestion/source-diagnostics.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AuthorizationStatus,
  Prisma,
  SourceLanguage,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import {
  inspectImage,
  type ManualUploadFile,
} from "../candidates/manual-candidate-upload.js";
import {
  MEDIA_DOWNLOADER,
  type MediaDownloader,
} from "../source-ingestion/media-downloader.js";
import { SourceFetchService } from "../source-ingestion/source-fetch.service.js";
import {
  ContentSourceRegistry,
  normalizePlatform,
} from "../source-ingestion/source-registry.js";
import type {
  AuthorDto,
  AuthorEvidenceDto,
  AuthorImportPreviewDto,
  AuthorImportRowDto,
  AuthorImportResultDto,
  AuthorPageDto,
  AuthorQueryDto,
  CreateAuthorDto,
  CreateExternalAccountDto,
  CreateTagDto,
  ExternalAccountDto,
  ExternalAccountSummaryDto,
  ManagedAuthorDto,
  ResolvedXProfileDto,
  ResolvedPixivProfileDto,
  SourceCapabilityDto,
  TagDto,
  UpdateAuthorDto,
  UpdateExternalAccountDto,
  UpdateSourceAdapterStateDto,
  UpdateTagDto,
} from "./authors.dto.js";
import {
  AUTHOR_IMPORT_TEMPLATE,
  parseAuthorImportCsv,
} from "./author-import.js";

import {
  authorQuery,
  authorCursor,
  type AuthorPosition,
} from "./author-query.js";

const authorListDetails = {
  id: true,
  displayName: true,
  sourceLanguage: true,
  authorizationStatus: true,
  revision: true,
  avatarFileObjectId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  tags: {
    select: { tag: { select: { id: true, name: true, revision: true } } },
  },
  externalAccounts: {
    where: { deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      platform: true,
      externalUserId: true,
      handle: true,
      profileUrl: true,
      displayNameSnapshot: true,
      avatarFileObjectId: true,
      fetchEnabled: true,
    },
  },
} satisfies Prisma.AuthorSelect;
type AuthorListRow = Prisma.AuthorGetPayload<{
  select: typeof authorListDetails;
}>;

const authorDetails = {
  tags: { include: { tag: true } },
  externalAccounts: {
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      adapterStates: {
        omit: { discoveryCheckpointJson: true },
        orderBy: { adapterKey: "asc" },
      },
    },
  },
} as const;
type AuthorWithDetails = Prisma.AuthorGetPayload<{
  include: typeof authorDetails;
}>;
const accountDetails = {
  adapterStates: {
    omit: { discoveryCheckpointJson: true },
    orderBy: { adapterKey: "asc" },
  },
} as const;
type ExternalAccount = Prisma.AuthorExternalAccountGetPayload<{
  include: typeof accountDetails;
}>;

@Injectable()
export class AuthorsService {
  onModuleInit() {
    this.directUploads?.register("author_avatar", (session, files) =>
      this.uploadAvatar(
        session.actorId,
        session.resourceId,
        session.expectedRevision,
        files[0],
        session.id,
      ),
    );
    this.directUploads?.register("author_evidence", (session, files) =>
      this.uploadEvidence(
        session.actorId,
        session.resourceId,
        session.expectedRevision,
        files,
        session.id,
      ),
    );
  }

  private async assertUploadActor(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT user_id FROM user_roles WHERE user_id = ${id}::uuid FOR SHARE`;
    if (
      !(await tx.user.count({
        where: {
          id,
          isActive: true,
          mustChangePassword: false,
          roles: { some: { role: { in: ["source", "admin"] } } },
        },
      }))
    )
      throw new ForbiddenException("当前职务不能维护作者附件");
  }

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ContentSourceRegistry)
    private readonly sources: ContentSourceRegistry,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(MEDIA_DOWNLOADER) private readonly downloader: MediaDownloader,
    @Inject(SourceFetchService)
    private readonly sourceFetch: SourceFetchService,
    @Optional()
    @Inject(DirectUploadsService)
    private readonly directUploads?: DirectUploadsService,
    @Optional() @Inject(ENVIRONMENT) private readonly environment?: Environment,
  ) {}

  private get profileProofs() {
    return new ProfileProofs(this.environment?.authorProfileProofSecret);
  }

  /** Validate offline before entering author/account write transactions. */
  private async prepareAccountIdentity(
    input: CreateExternalAccountDto,
    actorId?: string,
    authorId?: string,
  ): Promise<CreateExternalAccountDto> {
    const platform = normalizePlatform(input.platform);
    if (
      platform !== "x" &&
      !(
        platform === "pixiv" &&
        (input.profileProof || input.avatarFileObjectId != null)
      )
    )
      return {
        ...input,
        profileSyncAdapter: undefined,
        profileSyncedAt: undefined,
      };
    const proof = this.profileProofs.verify(
      input.profileProof,
      platform as "x" | "pixiv",
      actorId,
      authorId,
    );
    if (
      proof.externalUserId !== input.externalUserId.trim() ||
      (platform === "x" &&
        (!input.handle ||
          proof.handle!.toLowerCase() !==
            this.normalizeXHandle(input.handle).toLowerCase())) ||
      (input.avatarFileObjectId !== undefined &&
        input.avatarFileObjectId !== proof.avatarFileObjectId)
    )
      throw new ConflictException("平台资料凭证与账号不一致，请重新同步");
    return {
      ...input,
      externalUserId: proof.externalUserId,
      handle: proof.handle,
      avatarFileObjectId: proof.avatarFileObjectId,
      profileSyncAdapter: proof.adapterKey,
      profileSyncedAt: proof.syncedAt,
    };
  }

  private account(account: ExternalAccount): ExternalAccountDto {
    const activeStates = account.adapterStates.filter(
      (state) => !["x_web_session", "x_official_v2"].includes(state.adapterKey),
    );
    return {
      id: account.id,
      authorId: account.authorId,
      notes: account.notes ?? null,
      platform: account.platform,
      externalUserId: account.externalUserId,
      handle: account.handle,
      profileUrl: account.profileUrl,
      displayNameSnapshot: account.displayNameSnapshot,
      avatarAvailable: Boolean(account.avatarFileObjectId),
      fetchEnabled: account.fetchEnabled,
      firstSyncMode: account.firstSyncMode,
      providerAvailable: this.sources
        .forPlatform(account.platform)
        .some((client) => client.available),
      revision: account.revision,
      lastCheckedAt:
        activeStates
          .map((state) => state.lastAttemptAt)
          .filter((value): value is Date => Boolean(value))
          .sort((left, right) => right.getTime() - left.getTime())[0]
          ?.toISOString() ?? null,
      adapterStates: activeStates.map((state) => {
        const available =
          this.sources.get(state.adapterKey)?.available ?? false;
        return {
          adapterKey: state.adapterKey,
          enabled: state.enabled,
          available,
          health: !state.enabled
            ? ("disabled" as const)
            : !available
              ? ("unavailable" as const)
              : state.health === "unavailable" || state.health === "disabled"
                ? ("idle" as const)
                : state.health,
          lastAttemptAt: state.lastAttemptAt?.toISOString() ?? null,
          lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
          nextAttemptAt: state.nextAttemptAt?.toISOString() ?? null,
          consecutiveFailures: state.consecutiveFailures,
          lastErrorMessage: state.lastErrorMessage,
          revision: state.revision,
        };
      }),
      deletedAt: account.deletedAt?.toISOString() ?? null,
    };
  }

  private accountSummary(
    account: AuthorListRow["externalAccounts"][number],
  ): ExternalAccountSummaryDto {
    return {
      externalUserId: account.externalUserId,
      id: account.id,
      platform: account.platform,
      handle: account.handle,
      profileUrl: account.profileUrl,
      displayNameSnapshot: account.displayNameSnapshot,
      avatarAvailable: Boolean(account.avatarFileObjectId),
      fetchEnabled: account.fetchEnabled,
    };
  }

  private author(author: AuthorListRow): AuthorDto {
    return {
      id: author.id,
      displayName: author.displayName,
      sourceLanguage: author.sourceLanguage,
      authorizationStatus: author.authorizationStatus,
      revision: author.revision,
      avatarAvailable: Boolean(
        author.avatarFileObjectId ||
        author.externalAccounts.some((account) => account.avatarFileObjectId),
      ),
      tags: author.tags
        .map(({ tag }) => ({
          id: tag.id,
          name: tag.name,
          revision: tag.revision,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      externalAccounts: author.externalAccounts.map((account) =>
        this.accountSummary(account),
      ),
      createdAt: author.createdAt.toISOString(),
      updatedAt: author.updatedAt.toISOString(),
      deletedAt: author.deletedAt?.toISOString() ?? null,
    };
  }

  private managed(author: AuthorWithDetails): ManagedAuthorDto {
    return {
      ...this.author(author),
      notes: author.notes ?? null,
      externalAccounts: author.externalAccounts.map((account) =>
        this.account(account),
      ),
    };
  }

  private tags(names: string[]) {
    const tags = names.map((name) => {
      const display = name.normalize("NFKC").trim().replace(/\s+/g, " ");
      return { name: display, normalizedName: display.toLowerCase() };
    });
    if (tags.some((tag) => !tag.name))
      throw new BadRequestException("标签不能为空");
    if (new Set(tags.map((tag) => tag.normalizedName)).size !== tags.length) {
      throw new BadRequestException("标签不能重复");
    }
    return tags;
  }

  private validateAccount(
    platform: string,
    firstSyncMode: CreateExternalAccountDto["firstSyncMode"],
    fetchEnabled = true,
  ) {
    const normalized = normalizePlatform(platform);
    if (
      ["x", "pixiv"].includes(normalized) &&
      !fetchEnabled &&
      firstSyncMode === "none"
    ) {
      return normalized;
    }
    let clients;
    try {
      clients = this.sources.forPlatform(normalized);
    } catch {
      throw new BadRequestException("暂不支持该内容平台");
    }
    if (normalized === "pixiv") {
      clients = clients.filter((client) => client.available);
      if (!clients.length)
        throw new BadRequestException("Pixiv 尚未配置可用的抓取通道");
    }
    if (
      !clients.some((item) =>
        item.supportedFirstSyncModes.includes(firstSyncMode),
      )
    ) {
      throw new BadRequestException("该平台不支持所选首次同步方式");
    }
    return normalized;
  }

  private async withConflict<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("平台账号或标签已存在");
      }
      throw error;
    }
  }

  async list(query: AuthorQueryDto = {}): Promise<AuthorPageDto> {
    const plan = authorQuery(query);
    // A short read-only snapshot makes count, positions and summaries agree.
    // No external work or unbounded account adapter state belongs in this read.
    return this.db.$transaction(
      async (tx) => {
        const positions = await tx.$queryRaw<AuthorPosition[]>(plan.page);
        const [count] = await tx.$queryRaw<{ total: number }[]>(plan.count);
        const page = positions.slice(0, plan.limit);
        const summaries = page.length
          ? await tx.author.findMany({
              where: { id: { in: page.map((item) => item.id) } },
              select: authorListDetails,
              take: plan.limit,
            })
          : [];
        const byId = new Map(summaries.map((author) => [author.id, author]));
        return {
          items: page.map((position) => this.author(byId.get(position.id)!)),
          total: count?.total ?? 0,
          nextCursor:
            positions.length > plan.limit && page.length
              ? authorCursor(plan.scope, page.at(-1)!)
              : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  listArchived(): Promise<ManagedAuthorDto[]> {
    return this.db.author
      .findMany({
        where: { deletedAt: { not: null } },
        include: authorDetails,
        orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
      })
      .then((authors) => authors.map((author) => this.managed(author)));
  }

  listSources(): SourceCapabilityDto[] {
    return this.sources.list();
  }

  listTags(): Promise<TagDto[]> {
    return this.db.tag.findMany({
      select: { id: true, name: true, revision: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  createTag(input: CreateTagDto): Promise<TagDto> {
    const tag = normalizeAuthorTagName(input.name);
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        await lockAuthorTagCatalog(tx);
        return tx.tag.create({ data: tag });
      }),
    );
  }

  async updateTag(id: string, input: UpdateTagDto): Promise<TagDto> {
    const tag = normalizeAuthorTagName(input.name);
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        await lockAuthorTagCatalog(tx);
        const result = await tx.tag.updateMany({
          where: { id, revision: input.expectedRevision },
          data: { ...tag, revision: { increment: 1 } },
        });
        if (!result.count) {
          if (!(await tx.tag.findUnique({ where: { id } })))
            throw new NotFoundException("标签不存在");
          throw new ConflictException("标签已更新，请刷新后重试");
        }
        return tx.tag.findUniqueOrThrow({ where: { id } });
      }),
    );
  }

  async deleteTag(id: string, expectedRevision: number) {
    return this.db.$transaction(async (tx) => {
      await lockAuthorTagCatalog(tx);
      const result = await tx.tag.deleteMany({
        where: { id, revision: expectedRevision },
      });
      if (!result.count) {
        if (!(await tx.tag.findUnique({ where: { id } })))
          throw new NotFoundException("标签不存在");
        throw new ConflictException("标签已更新，请刷新后重试");
      }
      return { ok: true };
    });
  }

  async get(id: string): Promise<AuthorDto> {
    const author = await this.db.author.findFirst({
      where: { id, deletedAt: null },
      include: authorDetails,
    });
    if (!author) throw new NotFoundException("作者不存在");
    return this.author(author);
  }

  async getManaged(id: string): Promise<ManagedAuthorDto> {
    const author = await this.db.author.findFirst({
      where: { id, deletedAt: null },
      include: authorDetails,
    });
    if (!author) throw new NotFoundException("作者不存在");
    return this.managed(author);
  }

  private async assertCreateActor(
    tx: Prisma.TransactionClient,
    actorId: string,
  ) {
    // The same rows protect both permission checks and writes against concurrent revocation.
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT user_id FROM user_roles WHERE user_id = ${actorId}::uuid FOR SHARE`,
    );
    if (
      !(await tx.user.count({
        where: {
          id: actorId,
          isActive: true,
          mustChangePassword: false,
          roles: { some: { role: { in: ["source", "admin"] } } },
        },
      }))
    )
      throw new ForbiddenException("当前职务不能维护作者");
  }

  private creationPayloadHash(input: CreateAuthorDto) {
    // Proof signatures/TTL and provider timestamps are transport evidence, not a new intent.
    // All user-visible account values that can be persisted still participate in the hash.
    const normalizedTags =
      input.tagNames === undefined ? normalizeAuthorTagSelection(input) : null;
    const compare = (
      left: { normalizedName: string },
      right: { normalizedName: string },
    ) =>
      left.normalizedName < right.normalizedName
        ? -1
        : left.normalizedName > right.normalizedName
          ? 1
          : 0;
    const tagHashFields = normalizedTags
      ? {
          tagSelection: {
            existingTags: [...normalizedTags.existingTags].sort(
              (left, right) =>
                left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
            ),
            newTagNames: this.tags(normalizedTags.newTagNames).sort(compare),
          },
        }
      : { tags: this.tags(input.tagNames!).sort(compare) };
    const accounts = (input.accounts ?? [])
      .map((account) => {
        const platform = normalizePlatform(account.platform);
        const identity = this.identity(
          platform,
          account.externalUserId,
          account.handle,
        );
        return {
          platform,
          ...identity,
          ...(account.notes?.trim() ? { notes: account.notes.trim() } : {}),
          displayNameSnapshot: account.displayNameSnapshot?.trim() || null,
          avatarFileObjectId: account.avatarFileObjectId || null,
          fetchEnabled: account.fetchEnabled,
          firstSyncMode: account.firstSyncMode,
        };
      })
      .sort((left, right) =>
        left.platform < right.platform
          ? -1
          : left.platform > right.platform
            ? 1
            : 0,
      );
    return createHash("sha256")
      .update(
        JSON.stringify({
          displayName: input.displayName.trim(),
          sourceLanguage: input.sourceLanguage,
          authorizationStatus: input.authorizationStatus,
          ...tagHashFields,
          accounts,
          ...(input.profileSourcePlatform !== undefined
            ? { profileSourcePlatform: input.profileSourcePlatform }
            : {}),
          ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
        }),
      )
      .digest("hex");
  }

  async getCreationResult(
    actorId: string,
    idempotencyKey: string,
  ): Promise<ManagedAuthorDto | null> {
    return this.db.$transaction(async (tx) => {
      await this.assertCreateActor(tx, actorId);
      const request = await tx.authorCreationRequest.findUnique({
        where: { actorId_idempotencyKey: { actorId, idempotencyKey } },
        include: { author: { include: authorDetails } },
      });
      return request?.author ? this.managed(request.author) : null;
    });
  }

  async create(
    input: CreateAuthorDto,
    actorId?: string,
  ): Promise<ManagedAuthorDto> {
    const legacyTags = input.tagNames !== undefined;
    if (legacyTags && !Array.isArray(input.tagNames))
      throw new BadRequestException("标签格式无效，请刷新页面");
    if (
      legacyTags &&
      (input.existingTags !== undefined || input.newTagNames !== undefined)
    )
      throw new BadRequestException("标签格式不能混用，请刷新页面");
    const selection = legacyTags ? null : normalizeAuthorTagSelection(input);
    const accounts = input.accounts ?? [];
    if (!actorId && (input.idempotencyKey || accounts.length))
      throw new ForbiddenException("创建账号关联和恢复标识需要当前操作人");
    if (
      new Set(accounts.map((account) => normalizePlatform(account.platform)))
        .size !== accounts.length
    )
      throw new BadRequestException("同一作者每个平台只能关联一个有效账号");
    if (
      input.profileSourcePlatform !== undefined &&
      !["x", "pixiv"].includes(input.profileSourcePlatform)
    )
      throw new BadRequestException("作者资料来源平台无效");
    const payloadHash = this.creationPayloadHash(input);
    // Replaying a committed request must work even after its original profile proof expires.
    if (actorId && input.idempotencyKey) {
      const previous = await this.db.$transaction(async (tx) => {
        await this.assertCreateActor(tx, actorId);
        const request = await tx.authorCreationRequest.findUnique({
          where: {
            actorId_idempotencyKey: {
              actorId,
              idempotencyKey: input.idempotencyKey!,
            },
          },
          include: { author: { include: authorDetails } },
        });
        if (request && request.payloadHash !== payloadHash)
          throw new ConflictException(
            "该保存标识已用于其他作者资料，请先恢复原保存结果",
          );
        return request?.author ? this.managed(request.author) : null;
      });
      if (previous) return previous;
    }
    if (legacyTags)
      throw new ConflictException(
        "页面已更新，请刷新后重新选择标签；已保存的作者可通过恢复入口查看",
      );
    const prepared = await Promise.all(
      accounts.map((account) => this.prepareAccountIdentity(account, actorId)),
    );
    const profileSource =
      input.profileSourcePlatform === undefined
        ? undefined
        : prepared.find(
            (account) =>
              normalizePlatform(account.platform) ===
              input.profileSourcePlatform,
          );
    if (
      input.profileSourcePlatform !== undefined &&
      (!profileSource || !profileSource.profileProof)
    )
      throw new BadRequestException("作者资料来源需要对应平台的已验证账号资料");
    // Profile proof verification and any future provider work must finish before this transaction.
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        if (actorId) await this.assertCreateActor(tx, actorId);
        let requestId: string | undefined;
        if (actorId && input.idempotencyKey) {
          await tx.authorCreationRequest.createMany({
            data: {
              actorId,
              idempotencyKey: input.idempotencyKey,
              payloadHash,
            },
            skipDuplicates: true,
          });
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM author_creation_requests WHERE actor_id = ${actorId}::uuid AND idempotency_key = ${input.idempotencyKey}::uuid FOR UPDATE`,
          );
          const request = await tx.authorCreationRequest.findUniqueOrThrow({
            where: {
              actorId_idempotencyKey: {
                actorId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            include: { author: { include: authorDetails } },
          });
          if (request.payloadHash !== payloadHash)
            throw new ConflictException(
              "该保存标识已用于其他作者资料，请先恢复原保存结果",
            );
          if (request.author) return this.managed(request.author);
          requestId = request.id;
        }
        const [tagIds] = await resolveAuthorTagSelections(tx, [selection!]);
        if (profileSource)
          await this.validateProfileAvatar(
            profileSource.avatarFileObjectId,
            tx,
          );
        const author = await tx.author.create({
          data: {
            displayName: input.displayName.trim(),
            notes: input.notes?.trim() || null,
            ...(profileSource
              ? { avatarFileObjectId: profileSource.avatarFileObjectId ?? null }
              : {}),
            sourceLanguage: input.sourceLanguage,
            authorizationStatus: input.authorizationStatus,
            tags: { create: tagIds.map((tagId) => ({ tagId })) },
          },
        });
        for (const account of prepared) {
          await this.validateProfileAvatar(account.avatarFileObjectId, tx);
          await tx.authorExternalAccount.create({
            data: this.accountData(author.id, account),
          });
        }
        if (requestId)
          await tx.authorCreationRequest.update({
            where: { id: requestId },
            data: { authorId: author.id },
          });
        return this.managed(
          await tx.author.findUniqueOrThrow({
            where: { id: author.id },
            include: authorDetails,
          }),
        );
      }),
    );
  }

  update(id: string, input: UpdateAuthorDto): Promise<ManagedAuthorDto> {
    const selection = normalizeAuthorTagSelection(input);
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        const [tagIds] = await resolveAuthorTagSelections(tx, [selection]);
        const result = await tx.author.updateMany({
          where: { id, revision: input.expectedRevision, deletedAt: null },
          data: {
            displayName: input.displayName,
            ...(input.notes !== undefined
              ? { notes: input.notes?.trim() || null }
              : {}),
            sourceLanguage: input.sourceLanguage,
            authorizationStatus: input.authorizationStatus,
            revision: { increment: 1 },
          },
        });
        if (!result.count)
          await this.throwMissingOrConflict(tx, id, input.expectedRevision);
        await tx.authorTag.deleteMany({ where: { authorId: id } });
        for (const tagId of tagIds)
          await tx.authorTag.create({ data: { authorId: id, tagId } });
        return this.managed(
          await tx.author.findUniqueOrThrow({
            where: { id },
            include: authorDetails,
          }),
        );
      }),
    );
  }

  async archive(
    id: string,
    expectedRevision: number,
  ): Promise<ManagedAuthorDto> {
    return this.db.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.author.updateMany({
        where: { id, revision: expectedRevision, deletedAt: null },
        data: { deletedAt: now, revision: { increment: 1 } },
      });
      if (!result.count)
        await this.throwMissingOrConflict(tx, id, expectedRevision);
      await tx.authorExternalAccount.updateMany({
        where: { authorId: id, deletedAt: null },
        data: {
          deletedAt: now,
          fetchEnabled: false,
          revision: { increment: 1 },
        },
      });
      return this.managed(
        await tx.author.findUniqueOrThrow({
          where: { id },
          include: authorDetails,
        }),
      );
    });
  }

  async restore(
    id: string,
    expectedRevision: number,
  ): Promise<ManagedAuthorDto> {
    const result = await this.db.author.updateMany({
      where: { id, revision: expectedRevision, deletedAt: { not: null } },
      data: { deletedAt: null, revision: { increment: 1 } },
    });
    if (!result.count)
      await this.throwMissingOrConflict(this.db, id, expectedRevision);
    return this.managed(
      await this.db.author.findUniqueOrThrow({
        where: { id },
        include: authorDetails,
      }),
    );
  }

  private identity(platform: string, id: string, handle?: string | null) {
    const externalUserId = id.trim();
    if (!externalUserId) throw new BadRequestException("平台用户 ID 不能为空");
    if (platform === "pixiv") {
      if (!/^[1-9][0-9]*$/.test(externalUserId))
        throw new BadRequestException(
          "Pixiv 用户 ID 应为主页 /users/ 后的数字，例如 123456",
        );
      return {
        externalUserId,
        handle: null,
        profileUrl: `https://www.pixiv.net/users/${externalUserId}`,
      };
    }
    if (platform !== "x")
      return {
        externalUserId,
        handle: handle?.trim() || null,
        profileUrl: null,
      };
    const normalized = handle?.trim() ? this.normalizeXHandle(handle) : null;
    return {
      externalUserId,
      handle: normalized,
      profileUrl: normalized ? `https://x.com/${normalized}` : null,
    };
  }

  private async validateProfileAvatar(
    id?: string | null,
    tx?: Prisma.TransactionClient,
  ) {
    if (!id) return;
    if (
      !(await (tx ?? this.db).fileObject.findFirst({
        where: {
          id,
          kind: "source_profile_avatar",
          lifecycleStatus: "active",
          deletedAt: null,
        },
      }))
    )
      throw new BadRequestException("同步头像文件无效或已过期");
  }

  private accountData(authorId: string, input: CreateExternalAccountDto) {
    const platform = this.validateAccount(
      input.platform,
      input.firstSyncMode,
      input.fetchEnabled,
    );
    return {
      authorId,
      platform,
      ...this.identity(platform, input.externalUserId, input.handle),
      displayNameSnapshot: input.displayNameSnapshot?.trim() || null,
      notes: input.notes?.trim() || null,
      avatarFileObjectId: input.avatarFileObjectId || null,
      fetchEnabled: input.fetchEnabled,
      firstSyncMode: input.firstSyncMode,
      metadataJson: {
        ...(input.profileSyncAdapter
          ? { profileSyncAdapter: input.profileSyncAdapter }
          : {}),
        ...(input.profileSyncedAt
          ? { profileSyncedAt: input.profileSyncedAt }
          : {}),
      },
      adapterStates: {
        create: this.sources.forPlatform(platform).map((client) => ({
          adapterKey: client.adapterKey,
          health: client.available
            ? ("idle" as const)
            : ("unavailable" as const),
        })),
      },
    };
  }

  private changeMetadata(
    current: {
      metadataJson: Prisma.JsonValue;
      externalUserId: string;
      handle: string | null;
      revision: number;
    },
    action: string,
    actorId?: string,
  ) {
    const metadata =
      current.metadataJson &&
      typeof current.metadataJson === "object" &&
      !Array.isArray(current.metadataJson)
        ? current.metadataJson
        : {};
    const previous = Array.isArray(metadata.accountChanges)
      ? metadata.accountChanges
      : [];
    return {
      ...metadata,
      accountChanges: [
        ...previous,
        {
          action,
          actorId: actorId ?? null,
          at: new Date().toISOString(),
          externalUserId: current.externalUserId,
          handle: current.handle,
          revision: current.revision,
        },
      ],
    } as Prisma.InputJsonObject;
  }

  private async ensurePlatformVacant(
    tx: Prisma.TransactionClient,
    authorId: string,
    platform: string,
  ) {
    if (
      await tx.authorExternalAccount.findFirst({
        where: { authorId, platform, deletedAt: null },
      })
    )
      throw new ConflictException(
        `该作者已关联 ${platform === "x" ? "X" : "Pixiv"} 账号，请编辑或先解绑`,
      );
  }

  private async stopAccount(
    tx: Prisma.TransactionClient,
    authorId: string,
    id: string,
    revision: number,
    actorId?: string,
  ) {
    const current = await tx.authorExternalAccount.findFirst({
      where: { id, authorId, deletedAt: null },
    });
    if (!current) throw new NotFoundException("平台账号不存在");
    const result = await tx.authorExternalAccount.updateMany({
      where: { id, authorId, revision, deletedAt: null },
      data: {
        deletedAt: new Date(),
        fetchEnabled: false,
        revision: { increment: 1 },
        metadataJson: this.changeMetadata(current, "unbind", actorId),
      },
    });
    if (!result.count)
      throw new ConflictException("平台账号已更新，请刷新后重试");
    await tx.sourceAdapterState.updateMany({
      where: { externalAccountId: id },
      data: {
        enabled: false,
        health: "disabled",
        fetchLeaseId: null,
        fetchLeaseUntil: null,
        revision: { increment: 1 },
      },
    });
  }

  async createAccount(
    authorId: string,
    input: CreateExternalAccountDto,
    actorId?: string,
  ): Promise<ExternalAccountDto> {
    input = await this.prepareAccountIdentity(input, actorId, authorId);
    const data = this.accountData(authorId, input);
    await this.validateProfileAvatar(input.avatarFileObjectId);
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        if (
          !(await tx.author.findFirst({
            where: { id: authorId, deletedAt: null },
          }))
        )
          throw new NotFoundException("作者不存在");
        await this.ensurePlatformVacant(tx, authorId, data.platform);
        return this.account(
          await tx.authorExternalAccount.create({
            data,
            include: accountDetails,
          }),
        );
      }),
    );
  }

  async listAccounts(authorId: string): Promise<ExternalAccountDto[]> {
    if (
      !(await this.db.author.findFirst({
        where: { id: authorId, deletedAt: null },
      }))
    ) {
      throw new NotFoundException("作者不存在");
    }
    const accounts = await this.db.authorExternalAccount.findMany({
      where: { authorId, deletedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: accountDetails,
    });
    return accounts.map((account) => this.account(account));
  }

  async listArchivedAccounts(authorId: string): Promise<ExternalAccountDto[]> {
    if (!(await this.db.author.findUnique({ where: { id: authorId } }))) {
      throw new NotFoundException("作者不存在");
    }
    const accounts = await this.db.authorExternalAccount.findMany({
      where: { authorId, deletedAt: { not: null } },
      orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
      include: accountDetails,
    });
    return accounts.map((account) => this.account(account));
  }

  async updateAccount(
    authorId: string,
    id: string,
    input: UpdateExternalAccountDto,
    actorId?: string,
  ): Promise<ExternalAccountDto> {
    const observed = await this.db.authorExternalAccount.findFirst({
      where: { id, authorId, deletedAt: null, author: { deletedAt: null } },
    });
    if (!observed) throw new NotFoundException("平台账号不存在");
    if (observed.revision !== input.expectedRevision)
      throw new ConflictException("平台账号已更新，请刷新后重试");
    if (
      input.externalUserId != null &&
      input.externalUserId.trim() !== observed.externalUserId
    )
      throw new ConflictException(
        "平台用户 ID 不可修改；不同 ID 属于新账号，请通过新建入口关联。",
      );
    const wantedHandle = this.identity(
      observed.platform,
      observed.externalUserId,
      input.handle === undefined ? observed.handle : input.handle,
    ).handle;
    const observedHandle = this.identity(
      observed.platform,
      observed.externalUserId,
      observed.handle,
    ).handle;
    const xIdentityChange =
      observed.platform === "x" &&
      ((wantedHandle?.toLowerCase() ?? null) !==
        (observedHandle?.toLowerCase() ?? null) ||
        (input.fetchEnabled && !observed.fetchEnabled) ||
        input.avatarFileObjectId != null);
    const prepared =
      (observed.platform === "x" && (xIdentityChange || input.profileProof)) ||
      (observed.platform === "pixiv" &&
        (input.profileProof || input.avatarFileObjectId != null))
        ? await this.prepareAccountIdentity(
            {
              ...input,
              platform: observed.platform,
              externalUserId: observed.externalUserId,
              handle: wantedHandle,
            },
            actorId,
            authorId,
          )
        : null;
    input = {
      ...input,
      ...(input.handle !== undefined ? { handle: wantedHandle } : {}),
      profileSyncAdapter: prepared?.profileSyncAdapter,
      profileSyncedAt: prepared?.profileSyncedAt,
      ...(prepared
        ? {
            handle: prepared.handle,
            // Optional profile-avatar failure must preserve the observed account avatar.
            avatarFileObjectId:
              prepared.avatarFileObjectId ?? observed.avatarFileObjectId,
          }
        : {}),
    };
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.authorExternalAccount.findFirst({
          where: { id, authorId, deletedAt: null, author: { deletedAt: null } },
        });
        if (!current) throw new NotFoundException("平台账号不存在");
        if (current.revision !== input.expectedRevision)
          throw new ConflictException("平台账号已更新，请刷新后重试");
        if (
          input.externalUserId != null &&
          input.externalUserId.trim() !== current.externalUserId
        )
          throw new ConflictException(
            "平台用户 ID 不可修改；不同 ID 属于新账号，请通过新建入口关联。",
          );
        await this.validateProfileAvatar(input.avatarFileObjectId, tx);
        if (
          input.firstSyncMode !== current.firstSyncMode ||
          (input.fetchEnabled && !current.fetchEnabled)
        ) {
          this.validateAccount(
            current.platform,
            input.firstSyncMode,
            input.fetchEnabled,
          );
        }
        const identity = this.identity(
          current.platform,
          current.externalUserId,
          input.handle === undefined ? current.handle : input.handle,
        );
        const result = await tx.authorExternalAccount.updateMany({
          where: {
            id,
            authorId,
            revision: input.expectedRevision,
            deletedAt: null,
          },
          data: {
            ...identity,
            ...(input.notes !== undefined
              ? { notes: input.notes?.trim() || null }
              : {}),
            displayNameSnapshot:
              input.displayNameSnapshot === undefined
                ? current.displayNameSnapshot
                : input.displayNameSnapshot?.trim() || null,
            ...(input.avatarFileObjectId !== undefined
              ? { avatarFileObjectId: input.avatarFileObjectId }
              : {}),
            fetchEnabled: input.fetchEnabled,
            firstSyncMode: input.firstSyncMode,
            metadataJson: {
              ...this.changeMetadata(current, "edit", actorId),
              ...(input.profileSyncAdapter
                ? { profileSyncAdapter: input.profileSyncAdapter }
                : {}),
              ...(input.profileSyncedAt
                ? { profileSyncedAt: input.profileSyncedAt }
                : {}),
            },
            revision: { increment: 1 },
          },
        });
        if (!result.count)
          throw new ConflictException("平台账号已更新，请刷新后重试");
        if (input.fetchEnabled && !current.fetchEnabled) {
          const activeKeys = this.sources
            .forPlatform(current.platform)
            .filter((source) => source.available)
            .map((source) => source.adapterKey);
          if (activeKeys.length)
            await tx.sourceAdapterState.updateMany({
              where: {
                externalAccountId: id,
                adapterKey: { in: activeKeys },
                enabled: false,
              },
              data: { enabled: true, revision: { increment: 1 } },
            });
        }
        return this.account(
          await tx.authorExternalAccount.findUniqueOrThrow({
            where: { id },
            include: accountDetails,
          }),
        );
      }),
    );
  }

  async updateAdapterState(
    authorId: string,
    accountId: string,
    adapterKey: string,
    input: UpdateSourceAdapterStateDto,
  ): Promise<ExternalAccountDto> {
    const normalizedKey = adapterKey.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalizedKey)) {
      throw new BadRequestException("来源适配器标识无效");
    }
    const account = await this.db.authorExternalAccount.findFirst({
      where: {
        id: accountId,
        authorId,
        deletedAt: null,
        author: { deletedAt: null },
      },
    });
    if (!account) throw new NotFoundException("平台账号不存在");
    if (input.enabled) {
      const adapter = this.sources.get(normalizedKey);
      if (!adapter || adapter.platform !== account.platform)
        throw new BadRequestException("来源适配器不存在或不属于该平台");
      if (!adapter.available)
        throw new BadRequestException("来源适配器尚未配置");
    }
    const changed = await this.db.sourceAdapterState.updateMany({
      where: {
        externalAccountId: accountId,
        adapterKey: normalizedKey,
        revision: input.expectedRevision,
      },
      data: {
        enabled: input.enabled,
        health: input.enabled ? "idle" : "disabled",
        nextAttemptAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        fetchLeaseId: null,
        fetchLeaseUntil: null,
        revision: { increment: 1 },
      },
    });
    if (!changed.count) {
      const existing = await this.db.sourceAdapterState.findUnique({
        select: { id: true },
        where: {
          externalAccountId_adapterKey: {
            externalAccountId: accountId,
            adapterKey: normalizedKey,
          },
        },
      });
      if (!existing) throw new NotFoundException("来源适配器状态不存在");
      throw new ConflictException("来源适配器状态已更新，请刷新后重试");
    }
    return this.account(
      await this.db.authorExternalAccount.findUniqueOrThrow({
        where: { id: accountId },
        include: accountDetails,
      }),
    );
  }

  async archiveAccount(
    authorId: string,
    id: string,
    expectedRevision: number,
    actorId?: string,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.stopAccount(tx, authorId, id, expectedRevision, actorId);
      return { ok: true };
    });
  }

  async restoreAccount(
    authorId: string,
    id: string,
    expectedRevision: number,
    actorId?: string,
  ) {
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        if (
          !(await tx.author.findFirst({
            where: { id: authorId, deletedAt: null },
          }))
        )
          throw new NotFoundException("作者不存在");
        const current = await tx.authorExternalAccount.findFirst({
          where: { id, authorId },
        });
        if (!current) throw new NotFoundException("平台账号不存在");
        await this.ensurePlatformVacant(tx, authorId, current.platform);
        const result = await tx.authorExternalAccount.updateMany({
          where: {
            id,
            authorId,
            revision: expectedRevision,
            deletedAt: { not: null },
          },
          data: {
            deletedAt: null,
            fetchEnabled: false,
            metadataJson: this.changeMetadata(current, "restore", actorId),
            revision: { increment: 1 },
          },
        });
        if (!result.count)
          throw new ConflictException("平台账号已更新，请刷新后重试");
        return this.account(
          await tx.authorExternalAccount.findUniqueOrThrow({
            where: { id },
            include: accountDetails,
          }),
        );
      }),
    );
  }

  importTemplate(): string {
    return AUTHOR_IMPORT_TEMPLATE;
  }

  private normalizeXHandle(input: string): string {
    const trimmed = input.trim();
    let value = trimmed.replace(/^@/, "");
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (
        !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
          url.hostname.toLowerCase(),
        )
      ) {
        throw new BadRequestException("请输入有效的 X @账号或主页地址");
      }
      value = url.pathname.split("/").filter(Boolean)[0] ?? "";
    }
    if (!/^[A-Za-z0-9_]{1,15}$/.test(value)) {
      throw new BadRequestException("请输入有效的 X @账号或主页地址");
    }
    return value;
  }

  private async profileAvatar(
    actorId: string,
    url: string | undefined,
    allowedMediaHosts: readonly string[],
    context: { platform: "x" | "pixiv"; adapter: string },
  ) {
    let avatarFileObjectId: string | null = null,
      avatarUrl: string | null = null;
    let stage: ProfileAvatarStage = "missing";
    const logFailure = (error?: unknown) =>
      console.warn(
        JSON.stringify({
          event: "source_profile_avatar_failed",
          platform: context.platform,
          adapter: /^[a-z][a-z0-9_-]{0,63}$/.test(context.adapter)
            ? context.adapter
            : "unknown",
          ...profileAvatarDiagnostic(stage, error),
        }),
      );
    if (url) {
      try {
        stage = "download";
        const media = await this.downloader.download(url, [
          ...allowedMediaHosts,
        ]);
        stage = "store";
        const file = await this.files.store({
          body: media.body,
          contentType: media.contentType,
          bucketScope: "private",
          kind: "source_profile_avatar",
          sourceName: url,
          createdById: actorId,
        });
        avatarFileObjectId = file.id;
        stage = "sign";
        avatarUrl = (await this.files.signedReadUrl(file.id)).url;
      } catch (error) {
        /* Optional avatar failure must not erase a verified identity. */
        logFailure(error);
      }
    } else logFailure();
    return { avatarFileObjectId, avatarUrl };
  }

  async resolvePixivProfile(
    actorId: string,
    inputId: string,
    authorId?: string,
    accountId?: string,
  ): Promise<ResolvedPixivProfileDto> {
    const externalUserId = inputId.trim();
    if (!/^[1-9][0-9]{0,19}$/.test(externalUserId))
      throw new BadRequestException("请输入有效的 Pixiv 数字 ID");
    const bound =
      accountId && authorId
        ? await this.db.authorExternalAccount.findFirst({
            where: {
              id: accountId,
              authorId,
              platform: "pixiv",
              deletedAt: null,
              author: { deletedAt: null },
            },
          })
        : null;
    if (accountId && !bound) throw new NotFoundException("平台账号不存在");
    if (bound && bound.externalUserId !== externalUserId)
      throw new ConflictException("Pixiv ID 与绑定身份不一致");
    const available = this.sources
      .forPlatform("pixiv")
      .filter((client) => client.available);
    let failed = false;
    for (const client of available) {
      try {
        const profile = await this.sourceFetch.platforms.profileNetwork(
          actorId,
          async () => {
            if (client.metered)
              await this.sourceFetch.consumeMeteredBudget(client.adapterKey);
            const resolved = await client.checkAccount({ externalUserId });
            if (resolved.externalUserId !== externalUserId)
              throw new ConflictException(
                "Pixiv 资料与绑定身份不一致，请核实账号",
              );
            return resolved;
          },
          "pixiv",
        );
        const conflict = await this.db.authorExternalAccount.findFirst({
          where: { platform: "pixiv", externalUserId, deletedAt: null },
          include: { author: { select: { id: true, displayName: true } } },
        });
        if (conflict && conflict.author.id !== authorId)
          throw new ConflictException(
            `该 Pixiv 账号已绑定作者“${conflict.author.displayName}”`,
          );
        const avatar = await this.profileAvatar(
          actorId,
          profile.avatarUrl,
          client.allowedProfileAvatarHosts ?? client.allowedMediaHosts,
          { platform: "pixiv", adapter: client.adapterKey },
        );
        const identity = {
          externalUserId,
          handle: null,
          avatarFileObjectId: avatar.avatarFileObjectId,
          adapterKey: client.adapterKey,
          syncedAt: new Date().toISOString(),
        };
        return {
          ...identity,
          displayName:
            profile.displayName?.trim().slice(0, 255) || externalUserId,
          profileUrl: `https://www.pixiv.net/users/${externalUserId}`,
          avatarUrl: avatar.avatarUrl,
          profileProof: this.profileProofs.issue(
            { ...identity, platform: "pixiv" },
            actorId,
            authorId,
          ),
        };
      } catch (error) {
        if (
          error instanceof ConflictException ||
          error instanceof NotFoundException
        )
          throw error;
        failed = true;
        console.warn(
          JSON.stringify({
            event: "source_profile_failed",
            adapterKey: client.adapterKey,
            ...sourceDiagnostic(error),
          }),
        );
      }
    }
    if (failed)
      throw new ServiceUnavailableException(
        "无法同步 Pixiv 资料，请稍后重试或联系管理员检查图源",
      );
    throw new BadRequestException("Pixiv 资料同步通道尚未配置");
  }

  async resolveXProfile(
    actorId: string,
    inputHandle: string,
    authorId?: string,
    accountId?: string,
  ): Promise<ResolvedXProfileDto> {
    const handle = this.normalizeXHandle(inputHandle);
    const bound =
      accountId && authorId
        ? await this.db.authorExternalAccount.findFirst({
            where: {
              id: accountId,
              authorId,
              platform: "x",
              deletedAt: null,
              author: { deletedAt: null },
            },
          })
        : null;
    if (accountId && !bound) throw new NotFoundException("平台账号不存在");
    const available = this.sources
      .forPlatform("x")
      .filter((client) => client.available);
    let failed = false;
    for (const client of available) {
      if (!bound && !client.resolveProfileByHandle) continue;
      try {
        const profile = await this.sourceFetch.platforms.profileNetwork(
          actorId,
          async () => {
            if (client.metered)
              await this.sourceFetch.consumeMeteredBudget(client.adapterKey);
            const resolved = await (bound
              ? client.checkAccount({ externalUserId: bound.externalUserId })
              : client.resolveProfileByHandle!(handle));
            if (
              !/^[1-9][0-9]{0,19}$/.test(resolved.externalUserId) ||
              !resolved.handle
            )
              throw new BadRequestException("X 资料缺少有效身份");
            const returnedHandle = this.normalizeXHandle(resolved.handle);
            if (
              (bound && bound.externalUserId !== resolved.externalUserId) ||
              (!bound && returnedHandle.toLowerCase() !== handle.toLowerCase())
            )
              throw new ConflictException("X 资料与绑定身份不一致，请核实账号");
            return resolved;
          },
        );
        const normalizedHandle = this.normalizeXHandle(profile.handle!);
        const conflict = await this.db.authorExternalAccount.findFirst({
          where: {
            platform: "x",
            externalUserId: profile.externalUserId,
            deletedAt: null,
          },
          include: { author: { select: { id: true, displayName: true } } },
        });
        if (conflict && conflict.author.id !== authorId)
          throw new ConflictException(
            `该 X 账号已绑定作者“${conflict.author.displayName}”`,
          );
        const { avatarFileObjectId, avatarUrl } = await this.profileAvatar(
          actorId,
          profile.avatarUrl,
          client.allowedProfileAvatarHosts ?? client.allowedMediaHosts,
          { platform: "x", adapter: client.adapterKey },
        );
        const syncedAt = new Date().toISOString();
        const identity = {
          externalUserId: profile.externalUserId,
          handle: normalizedHandle,
          avatarFileObjectId,
          adapterKey: client.adapterKey,
          syncedAt,
        };
        return {
          ...identity,
          displayName:
            profile.displayName?.trim().slice(0, 255) || normalizedHandle,
          profileUrl: `https://x.com/${normalizedHandle}`,
          avatarUrl,
          profileProof: this.profileProofs.issue(
            { ...identity, platform: "x" },
            actorId,
            authorId,
          ),
        };
      } catch (error) {
        if (
          error instanceof ConflictException ||
          error instanceof NotFoundException
        )
          throw error;
        failed = true;
        console.warn(
          JSON.stringify({
            event: "source_profile_failed",
            adapterKey: client.adapterKey,
            ...sourceDiagnostic(error),
          }),
        );
      }
    }
    if (failed)
      throw new ServiceUnavailableException(
        "无法同步 X 资料，请稍后重试或联系管理员检查图源",
      );
    throw new BadRequestException(
      available.length
        ? "当前 X 采集适配器尚未支持资料同步"
        : "X 资料同步通道尚未配置",
    );
  }

  async avatarUrl(id: string) {
    const author = await this.db.author.findFirst({
      where: { id, deletedAt: null },
      include: {
        externalAccounts: {
          where: { deletedAt: null, avatarFileObjectId: { not: null } },
          orderBy: [{ platform: "asc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!author) throw new NotFoundException("作者不存在");
    const fallback = [
      ...author.externalAccounts.filter((account) => account.platform === "x"),
      ...author.externalAccounts.filter((account) => account.platform !== "x"),
    ][0];
    const fileId = author.avatarFileObjectId ?? fallback?.avatarFileObjectId;
    if (!fileId) throw new NotFoundException("作者尚未设置头像");
    return this.files.signedReadUrl(fileId);
  }

  async uploadAvatar(
    actorId: string,
    authorId: string,
    expectedRevision: number,
    file: ManualUploadFile,
    uploadSessionId?: string,
  ): Promise<ManagedAuthorDto> {
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException("作者头像不能超过 5 MiB");
    }
    let inspected;
    try {
      inspected = inspectImage(file.originalname, file.buffer);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "头像格式无效",
      );
    }
    const stored = await this.files.store({
      body: inspected.body,
      contentType: inspected.contentType,
      bucketScope: "private",
      kind: "author_avatar",
      sourceName: inspected.sourceName,
      createdById: actorId,
    });
    let linked = false;
    try {
      await this.db.$transaction(async (tx) => {
        if (uploadSessionId)
          await this.directUploads!.assertAdoptionLeaseTx(tx, uploadSessionId);
        await this.assertUploadActor(tx, actorId);
        const updated = await tx.author.updateMany({
          where: { id: authorId, revision: expectedRevision, deletedAt: null },
          data: { avatarFileObjectId: stored.id, revision: { increment: 1 } },
        });
        if (!updated.count)
          await this.throwMissingOrConflict(tx, authorId, expectedRevision);
        if (uploadSessionId)
          await this.directUploads!.completeTx(tx, uploadSessionId, {
            avatarFileObjectId: stored.id,
          });
      });
      linked = true;
      return this.managed(
        await this.db.author.findUniqueOrThrow({
          where: { id: authorId },
          include: authorDetails,
        }),
      );
    } catch (error) {
      if (!linked)
        await this.files.purgeUnreferenced(stored.id).catch(() => undefined);
      throw error;
    }
  }

  async listEvidence(authorId: string): Promise<AuthorEvidenceDto[]> {
    const author = await this.db.author.findFirst({
      where: { id: authorId, deletedAt: null },
    });
    if (!author) throw new NotFoundException("作者不存在");
    const evidence = await this.db.authorAuthorizationEvidence.findMany({
      where: { authorId, deletedAt: null },
      include: { fileObject: true },
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    });
    return Promise.all(
      evidence.map(async (item) => ({
        id: item.id,
        fileObjectId: item.fileObjectId,
        orderIndex: item.orderIndex,
        contentType: item.fileObject.contentType,
        size: Number(item.fileObject.size),
        url: (await this.files.signedReadUrl(item.fileObjectId)).url,
        createdAt: item.createdAt.toISOString(),
      })),
    );
  }

  async uploadEvidence(
    actorId: string,
    authorId: string,
    expectedRevision: number,
    uploadFiles: ManualUploadFile[],
    uploadSessionId?: string,
  ): Promise<AuthorEvidenceDto[]> {
    if (!uploadFiles.length || uploadFiles.length > 10) {
      throw new BadRequestException("每次请选择 1–10 张授权凭证图片");
    }
    const prepared = uploadFiles.map((file) => {
      if (file.size > 10 * 1024 * 1024) {
        throw new BadRequestException("单张授权凭证不能超过 10 MiB");
      }
      try {
        return inspectImage(file.originalname, file.buffer);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : "授权凭证格式无效",
        );
      }
    });
    const stored: { id: string }[] = [];
    try {
      for (const image of prepared) {
        stored.push(
          await this.files.store({
            body: image.body,
            contentType: image.contentType,
            bucketScope: "private",
            kind: "author_authorization_evidence",
            sourceName: image.sourceName,
            createdById: actorId,
          }),
        );
      }
      await this.db.$transaction(async (tx) => {
        if (uploadSessionId)
          await this.directUploads!.assertAdoptionLeaseTx(tx, uploadSessionId);
        await this.assertUploadActor(tx, actorId);
        const changed = await tx.author.updateMany({
          where: { id: authorId, revision: expectedRevision, deletedAt: null },
          data: { revision: { increment: 1 } },
        });
        if (!changed.count) {
          await this.throwMissingOrConflict(tx, authorId, expectedRevision);
        }
        const last = await tx.authorAuthorizationEvidence.aggregate({
          where: { authorId },
          _max: { orderIndex: true },
        });
        const start = (last._max.orderIndex ?? -1) + 1;
        await tx.authorAuthorizationEvidence.createMany({
          data: stored.map((file, index) => ({
            authorId,
            fileObjectId: file.id,
            orderIndex: start + index,
            uploadedById: actorId,
          })),
        });
        if (uploadSessionId)
          await this.directUploads!.completeTx(tx, uploadSessionId, {
            fileObjectIds: stored.map((file) => file.id),
          });
      });
    } catch (error) {
      await Promise.all(
        stored.map((file) =>
          this.files.purgeUnreferenced(file.id).catch(() => undefined),
        ),
      );
      throw error;
    }
    return this.listEvidence(authorId);
  }

  async deleteEvidence(
    actorId: string,
    authorId: string,
    evidenceId: string,
    expectedRevision: number,
  ): Promise<AuthorEvidenceDto[]> {
    await this.db.$transaction(async (tx) => {
      const changed = await tx.author.updateMany({
        where: { id: authorId, revision: expectedRevision, deletedAt: null },
        data: { revision: { increment: 1 } },
      });
      if (!changed.count) {
        await this.throwMissingOrConflict(tx, authorId, expectedRevision);
      }
      const removed = await tx.authorAuthorizationEvidence.updateMany({
        where: { id: evidenceId, authorId, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: actorId },
      });
      if (!removed.count) throw new NotFoundException("授权凭证不存在");
    });
    return this.listEvidence(authorId);
  }

  async reorderEvidence(
    authorId: string,
    evidenceIds: string[],
    expectedRevision: number,
  ): Promise<AuthorEvidenceDto[]> {
    await this.db.$transaction(async (tx) => {
      const active = await tx.authorAuthorizationEvidence.findMany({
        where: { authorId, deletedAt: null },
        select: { id: true },
      });
      if (
        active.length !== evidenceIds.length ||
        active.some((item) => !evidenceIds.includes(item.id))
      ) {
        throw new BadRequestException("授权凭证顺序必须包含全部现有图片");
      }
      const changed = await tx.author.updateMany({
        where: { id: authorId, revision: expectedRevision, deletedAt: null },
        data: { revision: { increment: 1 } },
      });
      if (!changed.count) {
        await this.throwMissingOrConflict(tx, authorId, expectedRevision);
      }
      for (const [orderIndex, id] of evidenceIds.entries()) {
        await tx.authorAuthorizationEvidence.update({
          where: { id },
          data: { orderIndex },
        });
      }
    });
    return this.listEvidence(authorId);
  }

  private async validateImportRows(
    actorId: string,
    rows: AuthorImportRowDto[],
    resolveProfiles: boolean,
  ): Promise<(AuthorImportRowDto & { errors: string[] })[]> {
    const result: (AuthorImportRowDto & { errors: string[] })[] = [];
    for (const original of rows) {
      const row: AuthorImportRowDto & { errors: string[] } = {
        ...original,
        existingTags: [...original.existingTags],
        newTagNames: [...original.newTagNames],
        errors: [],
      };
      if (!row.displayName.trim() || row.displayName.trim().length > 100)
        row.errors.push("作者昵称必须为 1–100 个字符");
      if (
        !Object.values(SourceLanguage).includes(
          row.sourceLanguage as SourceLanguage,
        )
      )
        row.errors.push("作者母语无效");
      if (
        !Object.values(AuthorizationStatus).includes(
          row.authorizationStatus as AuthorizationStatus,
        )
      )
        row.errors.push("授权状态无效");
      try {
        normalizeAuthorTagSelection(row);
      } catch (error) {
        row.errors.push(error instanceof Error ? error.message : "标签无效");
      }
      if (row.xHandle) {
        try {
          row.xHandle = this.normalizeXHandle(row.xHandle);
        } catch (error) {
          row.errors.push(
            error instanceof Error ? error.message : "X 账号无效",
          );
        }
      }
      if (row.xHandle && resolveProfiles && !row.errors.length) {
        try {
          const profile = await this.resolveXProfile(actorId, row.xHandle);
          if (
            row.xExternalUserId &&
            row.xExternalUserId !== profile.externalUserId
          )
            throw new ConflictException("X 用户 ID 与平台返回身份不一致");
          row.xExternalUserId = profile.externalUserId;
          row.xHandle = profile.handle;
          row.xDisplayName = profile.displayName;
          row.xProfileUrl = profile.profileUrl;
          row.xAvatarFileObjectId = profile.avatarFileObjectId;
          row.xProfileSyncAdapter = profile.adapterKey;
          row.xProfileSyncedAt = profile.syncedAt;
          if (!row.displayName.trim()) row.displayName = profile.displayName;
        } catch (error) {
          row.errors.push(
            error instanceof Error ? error.message : "X 资料同步失败",
          );
        }
      }
      if (row.xHandle && !row.xExternalUserId)
        row.errors.push("X 用户 ID 缺失，请先同步资料");
      if (row.xExternalUserId && !row.xHandle)
        row.errors.push("填写 X 用户 ID 时也必须填写 X @账号");
      if (row.pixivUserId && !/^[1-9][0-9]*$/.test(row.pixivUserId))
        row.errors.push("Pixiv 用户 ID 必须是主页 /users/ 后的数字");
      if (row.pixivProfileUrl) {
        try {
          const url = new URL(row.pixivProfileUrl);
          if (
            url.protocol !== "https:" ||
            !["pixiv.net", "www.pixiv.net"].includes(url.hostname.toLowerCase())
          )
            throw new Error();
        } catch {
          row.errors.push("Pixiv 主页地址无效");
        }
      }
      result.push(row);
    }
    const seen = new Map<string, number>();
    for (const row of result) {
      for (const key of [
        row.xExternalUserId ? `x:${row.xExternalUserId}` : null,
        row.pixivUserId ? `pixiv:${row.pixivUserId}` : null,
      ].filter((value): value is string => Boolean(value))) {
        const first = seen.get(key);
        if (first) row.errors.push(`平台账号与第 ${first} 行重复`);
        else seen.set(key, row.row);
      }
    }
    const keys = [...seen.keys()];
    if (keys.length) {
      const existing = await this.db.authorExternalAccount.findMany({
        where: {
          OR: keys.map((key) => {
            const [platform, ...id] = key.split(":");
            return { platform, externalUserId: id.join(":"), deletedAt: null };
          }),
        },
        include: { author: { select: { displayName: true } } },
      });
      for (const row of result) {
        for (const account of existing) {
          if (
            (account.platform === "x" &&
              account.externalUserId === row.xExternalUserId) ||
            (account.platform === "pixiv" &&
              account.externalUserId === row.pixivUserId)
          ) {
            row.errors.push(
              `平台账号已绑定作者“${account.author.displayName}”`,
            );
          }
        }
      }
    }
    return result;
  }

  async previewImport(
    actorId: string,
    file: ManualUploadFile,
  ): Promise<AuthorImportPreviewDto> {
    let rows;
    try {
      rows = parseAuthorImportCsv(file.buffer);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "CSV 无法解析",
      );
    }
    const names = [
      ...new Set(
        rows.flatMap((row) =>
          row.tagNames.map((name) =>
            name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(),
          ),
        ),
      ),
    ];
    const catalog = await this.db.tag.findMany({
      where: { normalizedName: { in: names } },
    });
    const byName = new Map(catalog.map((tag) => [tag.normalizedName, tag]));
    const selections = rows.map(({ tagNames, ...row }) => {
      const existingTags: { id: string; expectedRevision: number }[] = [],
        newTagNames: string[] = [];
      for (const name of tagNames) {
        const tag = byName.get(
          name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(),
        );
        if (tag)
          existingTags.push({ id: tag.id, expectedRevision: tag.revision });
        else newTagNames.push(name);
      }
      return { ...row, existingTags, newTagNames };
    });
    const validated = await this.validateImportRows(actorId, selections, true);
    return {
      rows: validated,
      validCount: validated.filter((row) => !row.errors.length).length,
      invalidCount: validated.filter((row) => row.errors.length).length,
    };
  }

  async importAuthors(
    actorId: string,
    rows: AuthorImportRowDto[],
  ): Promise<AuthorImportResultDto> {
    if (!rows.length) throw new BadRequestException("没有可导入的作者");
    const validated = await this.validateImportRows(actorId, rows, true);
    const invalid = validated.filter((row) => row.errors.length);
    if (invalid.length) {
      throw new BadRequestException(
        `CSV 仍有 ${invalid.length} 行错误，请重新预览后提交`,
      );
    }
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        await this.assertCreateActor(tx, actorId);
        const tagSelections = await resolveAuthorTagSelections(tx, validated);
        const authorIds: string[] = [];
        for (const [index, row] of validated.entries()) {
          const author = await tx.author.create({
            data: {
              displayName: row.displayName.trim(),
              sourceLanguage: row.sourceLanguage as SourceLanguage,
              authorizationStatus:
                row.authorizationStatus as AuthorizationStatus,
              tags: {
                create: tagSelections[index].map((tagId) => ({ tagId })),
              },
            },
          });
          authorIds.push(author.id);
          if (row.xExternalUserId) {
            await tx.authorExternalAccount.create({
              data: {
                authorId: author.id,
                platform: "x",
                externalUserId: row.xExternalUserId,
                handle: row.xHandle,
                profileUrl: row.xProfileUrl ?? `https://x.com/${row.xHandle}`,
                displayNameSnapshot: row.xDisplayName,
                avatarFileObjectId: row.xAvatarFileObjectId,
                fetchEnabled: true,
                firstSyncMode: "last_24_hours",
                metadataJson: {
                  ...(row.xProfileSyncAdapter
                    ? { profileSyncAdapter: row.xProfileSyncAdapter }
                    : {}),
                  ...(row.xProfileSyncedAt
                    ? { profileSyncedAt: row.xProfileSyncedAt }
                    : {}),
                },
                adapterStates: {
                  create: this.sources.forPlatform("x").map((client) => ({
                    adapterKey: client.adapterKey,
                    health: client.available ? "idle" : "unavailable",
                  })),
                },
              },
            });
          }
          if (row.pixivUserId) {
            await tx.authorExternalAccount.create({
              data: {
                authorId: author.id,
                platform: "pixiv",
                externalUserId: row.pixivUserId,
                handle: null,
                profileUrl: `https://www.pixiv.net/users/${row.pixivUserId}`,
                fetchEnabled: false,
                firstSyncMode: "none",
              },
            });
          }
        }
        return { createdCount: authorIds.length, authorIds };
      }),
    );
  }

  private async throwMissingOrConflict(
    db: Pick<Prisma.TransactionClient, "author">,
    id: string,
    expectedRevision: number,
  ): Promise<never> {
    const author = await db.author.findUnique({ where: { id } });
    if (!author) throw new NotFoundException("作者不存在");
    if (author.revision !== expectedRevision)
      throw new ConflictException("作者已更新，请刷新后重试");
    throw new ConflictException("作者当前状态不允许该操作");
  }
}
