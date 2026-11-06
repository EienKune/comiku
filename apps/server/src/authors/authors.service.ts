import { DirectUploadsService } from "../transfers/direct-uploads.service.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
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
  ) {}

  private account(account: ExternalAccount): ExternalAccountDto {
    const activeStates = account.adapterStates.filter(
      (state) => !["x_web_session", "x_official_v2"].includes(state.adapterKey),
    );
    return {
      id: account.id,
      authorId: account.authorId,
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

  private accountSummary(account: ExternalAccount): ExternalAccountSummaryDto {
    return {
      externalUserId: account.externalUserId,
      id: account.id,
      platform: account.platform,
      handle: account.handle,
      profileUrl: account.profileUrl,
      displayNameSnapshot: account.displayNameSnapshot,
      avatarAvailable: Boolean(account.avatarFileObjectId),
    };
  }

  private author(author: AuthorWithDetails): AuthorDto {
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
    if (normalized === "pixiv" && !fetchEnabled && firstSyncMode === "none") {
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
    const limit = query.limit ?? 50;
    const search = query.search?.replace(/^@/, "").trim() ?? "";
    const baseWhere: Prisma.AuthorWhereInput = {
      deletedAt: null,
      authorizationStatus: query.authorizationStatus,
      ...(query.platform
        ? {
            externalAccounts: {
              some: {
                platform: query.platform.toLowerCase(),
                deletedAt: null,
              },
            },
          }
        : {}),
      ...(query.tag
        ? {
            tags: {
              some: {
                tag: {
                  normalizedName: query.tag
                    .normalize("NFKC")
                    .trim()
                    .toLowerCase(),
                },
              },
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { displayName: { contains: search, mode: "insensitive" } },
              {
                externalAccounts: {
                  some: {
                    deletedAt: null,
                    handle: { contains: search, mode: "insensitive" },
                  },
                },
              },
            ],
          }
        : {}),
    };
    const all = await this.db.author.findMany({
      where: baseWhere,
      include: authorDetails,
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    });
    if (search) {
      const term = search.toLowerCase();
      all.sort((left, right) => {
        const rank = (author: AuthorWithDetails) => {
          const handles = author.externalAccounts
            .filter((account) => account.platform === "x" && account.handle)
            .map((account) => account.handle!.toLowerCase());
          if (handles.includes(term)) return 0;
          if (handles.some((handle) => handle.startsWith(term))) return 1;
          if (handles.some((handle) => handle.includes(term))) return 2;
          return 3;
        };
        return (
          rank(left) - rank(right) ||
          left.displayName.localeCompare(right.displayName) ||
          left.id.localeCompare(right.id)
        );
      });
    }
    let start = 0;
    if (query.cursor) {
      try {
        const cursorId = Buffer.from(query.cursor, "base64url").toString();
        start = all.findIndex((author) => author.id === cursorId) + 1;
        if (start === 0) throw new Error();
      } catch {
        throw new BadRequestException("作者分页游标无效或已过期");
      }
    }
    const page = all.slice(start, start + limit);
    return {
      items: page.map((author) => this.author(author)),
      total: all.length,
      nextCursor:
        start + page.length < all.length && page.length
          ? Buffer.from(page.at(-1)!.id).toString("base64url")
          : null,
    };
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
    return this.db.tag.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] });
  }

  createTag(input: CreateTagDto): Promise<TagDto> {
    const [tag] = this.tags([input.name]);
    return this.withConflict(() => this.db.tag.create({ data: tag }));
  }

  async updateTag(id: string, input: UpdateTagDto): Promise<TagDto> {
    const [tag] = this.tags([input.name]);
    return this.withConflict(async () => {
      const result = await this.db.tag.updateMany({
        where: { id, revision: input.expectedRevision },
        data: { ...tag, revision: { increment: 1 } },
      });
      if (!result.count) {
        const existing = await this.db.tag.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException("标签不存在");
        throw new ConflictException("标签已更新，请刷新后重试");
      }
      return this.db.tag.findUniqueOrThrow({ where: { id } });
    });
  }

  async deleteTag(id: string, expectedRevision: number) {
    const result = await this.db.tag.deleteMany({
      where: { id, revision: expectedRevision },
    });
    if (!result.count) {
      const existing = await this.db.tag.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException("标签不存在");
      throw new ConflictException("标签已更新，请刷新后重试");
    }
    return { ok: true };
  }

  async get(id: string): Promise<AuthorDto> {
    const author = await this.db.author.findFirst({
      where: { id, deletedAt: null },
      include: authorDetails,
    });
    if (!author) throw new NotFoundException("作者不存在");
    return this.author(author);
  }

  create(input: CreateAuthorDto): Promise<ManagedAuthorDto> {
    const tags = this.tags(input.tagNames);
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        const author = await tx.author.create({
          data: {
            displayName: input.displayName,
            sourceLanguage: input.sourceLanguage,
            authorizationStatus: input.authorizationStatus,
            tags: {
              create: tags.map((tag) => ({
                tag: {
                  connectOrCreate: {
                    where: { normalizedName: tag.normalizedName },
                    create: tag,
                  },
                },
              })),
            },
          },
          include: authorDetails,
        });
        return this.managed(author);
      }),
    );
  }

  update(id: string, input: UpdateAuthorDto): Promise<ManagedAuthorDto> {
    const tags = this.tags(input.tagNames);
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        const result = await tx.author.updateMany({
          where: { id, revision: input.expectedRevision, deletedAt: null },
          data: {
            displayName: input.displayName,
            sourceLanguage: input.sourceLanguage,
            authorizationStatus: input.authorizationStatus,
            revision: { increment: 1 },
          },
        });
        if (!result.count)
          await this.throwMissingOrConflict(tx, id, input.expectedRevision);
        await tx.authorTag.deleteMany({ where: { authorId: id } });
        for (const tag of tags) {
          const saved = await tx.tag.upsert({
            where: { normalizedName: tag.normalizedName },
            create: tag,
            update: {},
          });
          await tx.authorTag.create({
            data: { authorId: id, tagId: saved.id },
          });
        }
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

  private async validateProfileAvatar(id?: string | null) {
    if (!id) return;
    if (
      !(await this.db.fileObject.findFirst({
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
    action = "unbind",
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
        metadataJson: this.changeMetadata(current, action, actorId),
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
  ): Promise<ExternalAccountDto> {
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
    await this.validateProfileAvatar(input.avatarFileObjectId);
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        const current = await tx.authorExternalAccount.findFirst({
          where: { id, authorId, deletedAt: null, author: { deletedAt: null } },
        });
        if (!current) throw new NotFoundException("平台账号不存在");
        if (current.revision !== input.expectedRevision)
          throw new ConflictException("平台账号已更新，请刷新后重试");
        if (
          current.platform !== "pixiv" ||
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
          input.externalUserId ?? current.externalUserId,
          input.handle === undefined ? current.handle : input.handle,
        );
        if (identity.externalUserId !== current.externalUserId) {
          if (current.platform === "x" && !input.handle?.trim())
            throw new BadRequestException("更换 X 身份时请同时填写新 @账号");
          await this.stopAccount(
            tx,
            authorId,
            id,
            input.expectedRevision,
            actorId,
            "replace",
          );
          const data = this.accountData(authorId, {
            ...input,
            platform: current.platform,
            externalUserId: identity.externalUserId,
          });
          return this.account(
            await tx.authorExternalAccount.create({
              data: {
                ...data,
                metadataJson: { ...data.metadataJson, replacesAccountId: id },
              },
              include: accountDetails,
            }),
          );
        }
        const result = await tx.authorExternalAccount.updateMany({
          where: {
            id,
            authorId,
            revision: input.expectedRevision,
            deletedAt: null,
          },
          data: {
            ...identity,
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

  async resolveXProfile(
    actorId: string,
    inputHandle: string,
    authorId?: string,
  ): Promise<ResolvedXProfileDto> {
    const handle = this.normalizeXHandle(inputHandle);
    const errors: string[] = [];
    for (const client of this.sources.forPlatform("x")) {
      if (!client.available) continue;
      try {
        if (client.metered) {
          await this.sourceFetch.consumeMeteredBudget(client.adapterKey);
        }
        if (!client.resolveProfileByHandle) continue;
        const profile = await client.resolveProfileByHandle(handle);
        const normalizedHandle = this.normalizeXHandle(
          profile.handle ?? handle,
        );
        const conflict = await this.db.authorExternalAccount.findFirst({
          where: {
            platform: "x",
            externalUserId: profile.externalUserId,
            deletedAt: null,
          },
          include: { author: { select: { id: true, displayName: true } } },
        });
        if (conflict && conflict.author.id !== authorId) {
          throw new ConflictException(
            `该 X 账号已绑定作者“${conflict.author.displayName}”`,
          );
        }
        let avatarFileObjectId: string | null = null;
        let avatarUrl: string | null = null;
        if (profile.avatarUrl) {
          const media = await this.downloader.download(
            profile.avatarUrl,
            client.allowedMediaHosts,
          );
          const file = await this.files.store({
            body: media.body,
            contentType: media.contentType,
            bucketScope: "private",
            kind: "source_profile_avatar",
            sourceName: profile.avatarUrl,
            createdById: actorId,
          });
          avatarFileObjectId = file.id;
          avatarUrl = (await this.files.signedReadUrl(file.id)).url;
        }
        const syncedAt = new Date().toISOString();
        return {
          externalUserId: profile.externalUserId,
          handle: normalizedHandle,
          displayName: profile.displayName?.trim() || normalizedHandle,
          profileUrl: profile.profileUrl ?? `https://x.com/${normalizedHandle}`,
          avatarFileObjectId,
          avatarUrl,
          adapterKey: client.adapterKey,
          syncedAt,
        };
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        errors.push(error instanceof Error ? error.message : "未知错误");
      }
    }
    throw new BadRequestException(
      errors.length
        ? `无法同步 X 资料：${errors.at(-1)}`
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
        tagNames: [...original.tagNames],
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
        this.tags(row.tagNames);
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
      if (
        row.xHandle &&
        !row.xExternalUserId &&
        resolveProfiles &&
        !row.errors.length
      ) {
        try {
          const profile = await this.resolveXProfile(actorId, row.xHandle);
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
    const validated = await this.validateImportRows(actorId, rows, true);
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
    const validated = await this.validateImportRows(actorId, rows, false);
    const invalid = validated.filter((row) => row.errors.length);
    if (invalid.length) {
      throw new BadRequestException(
        `CSV 仍有 ${invalid.length} 行错误，请重新预览后提交`,
      );
    }
    return this.withConflict(() =>
      this.db.$transaction(async (tx) => {
        const authorIds: string[] = [];
        for (const row of validated) {
          const author = await tx.author.create({
            data: {
              displayName: row.displayName.trim(),
              sourceLanguage: row.sourceLanguage as SourceLanguage,
              authorizationStatus:
                row.authorizationStatus as AuthorizationStatus,
              tags: {
                create: this.tags(row.tagNames).map((tag) => ({
                  tag: {
                    connectOrCreate: {
                      where: { normalizedName: tag.normalizedName },
                      create: tag,
                    },
                  },
                })),
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
