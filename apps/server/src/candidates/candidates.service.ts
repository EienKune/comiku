import { JobsService } from "../jobs/jobs.service.js";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { CandidateTagDisposition, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { ImageAnalysisService } from "../image-analysis/image-analysis.service.js";
import {
  collectHashtags,
  normalizeHashtag,
} from "../source-ingestion/hashtags.js";
import {
  CandidateAction,
  CandidateActionOutcome,
  type CandidateUploadSessionDto,
  type CreateCandidateUploadSessionDto,
  ManualUploadOutcome,
  type CandidateActionItemDto,
  type CandidateBatchActionDto,
  type CandidateDto,
  type CandidateTagGroupDto,
  type CreateCandidateTagGroupDto,
  type CandidatePageDto,
  type CandidateQueryDto,
  type ManualCandidateUploadDto,
  type ReorderCandidateMediaDto,
  type SetCandidateClassificationDto,
  type UpdateManualCandidateDto,
  type UpdateCandidateTagGroupDto,
} from "./candidates.dto.js";
import {
  prepareManualUpload,
  type ManualUploadFile,
  type PreparedManualGroup,
} from "./manual-candidate-upload.js";

const details = {
  author: {
    select: {
      displayName: true,
      sourceLanguage: true,
      avatarFileObjectId: true,
      externalAccounts: {
        where: { deletedAt: null },
        select: { platform: true, handle: true, avatarFileObjectId: true },
      },
    },
  },
  authorExternalAccount: {
    select: { platform: true, handle: true, avatarFileObjectId: true },
  },
  media: { orderBy: { orderIndex: "asc" } },
  work: { select: { id: true } },
  hashtags: { orderBy: { normalizedValue: "asc" } },
  sourceObservations: {
    select: { adapterKey: true },
    orderBy: { adapterKey: "asc" },
  },
  classificationDecision: true,
  classificationSuggestions: {
    orderBy: { createdAt: "desc" },
    take: 1,
  },
} as const;
type CandidateDetails = Prisma.CandidatePostGetPayload<{
  include: typeof details;
}>;

const uploadSessionDetails = {
  items: {
    orderBy: { createdAt: "asc" },
    include: { candidatePost: { include: details } },
  },
} as const;
type UploadSessionDetails = Prisma.CandidateUploadSessionGetPayload<{
  include: typeof uploadSessionDetails;
}>;

const uploadSessionLifetimeMs = 24 * 60 * 60 * 1000;
const signedUploadLifetimeSeconds = 15 * 60;

@Injectable()
export class CandidatesService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Optional() @Inject(JobsService) private readonly jobs?: JobsService,
    @Optional()
    @Inject(ImageAnalysisService)
    private readonly analysis?: ImageAnalysisService,
  ) {}

  onModuleInit() {
    this.jobs?.register("candidate_upload_cleanup", async () => {
      await this.expireStaleUploadSessions();
    });
    this.jobs?.register("candidate_finalize", async (job, signal) => {
      if (!job.actorId) return;
      await this.finalizeUploadSession(
        job.actorId,
        job.resourceId,
        true,
        signal,
      );
    });
  }
  async queueFinalize(actorId: string, id: string) {
    const session = await this.findUploadSession(actorId, id);
    if (session.status === "completed") return this.uploadSessionDto(session);
    if (session.expiresAt <= new Date() || session.status === "expired")
      throw new ConflictException("上传会话已过期");
    await this.db.$transaction(async (tx) => {
      await tx.candidateUploadSession.updateMany({
        where: { id, actorId, status: "pending" },
        data: { status: "finalizing" },
      });
      await this.jobs!.enqueue(
        {
          kind: "candidate_finalize",
          resourceId: id,
          actorId,
          idempotencyKey: `candidate-finalize:${id}`,
        },
        tx,
      );
    });
    return this.uploadSessionDto(await this.findUploadSession(actorId, id));
  }
  private async assertUploadActor(
    tx: Prisma.TransactionClient,
    actorId: string,
    authorId: string,
  ) {
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
      throw new ForbiddenException("当前职务不能入库图源");
    if (
      !(await tx.author.count({
        where: {
          id: authorId,
          deletedAt: null,
          authorizationStatus: "authorized",
        },
      }))
    )
      throw new BadRequestException("请选择授权有效的作者");
    await this.jobs?.assertCurrentLease(tx);
  }

  private analysisSummary(candidate: {
    analysisModelKey: string | null;
    analysisState: string;
    analysisScore: number | null;
    analysisPredictions: unknown;
  }) {
    const key = this.analysis?.activeModelKey;
    if (!key || candidate.analysisModelKey !== key)
      return { state: "unprocessed", score: null };
    return {
      state: candidate.analysisState,
      score: this.analysis?.hasEvidence(
        candidate.analysisScore,
        candidate.analysisPredictions,
      )
        ? candidate.analysisScore
        : null,
    };
  }

  private detailsWithAnalysis() {
    return {
      ...details,
      _count: {
        select: {
          media: {
            where: {
              fileObject: {
                lifecycleStatus: "active" as const,
                deletedAt: null,
              },
              candidatePost: { author: { deletedAt: null } },
              analyses: {
                some: {
                  modelKey: this.analysis?.activeModelKey ?? "",
                  status: "failed" as const,
                },
              },
            },
          },
        },
      },
    };
  }

  private dto(
    candidate: CandidateDetails & { _count?: { media: number } },
  ): CandidateDto {
    const analysis = this.analysisSummary(candidate);
    const account =
      candidate.authorExternalAccount ??
      candidate.author.externalAccounts.find((item) => item.platform === "x") ??
      candidate.author.externalAccounts[0];
    return {
      id: candidate.id,
      canRetryAnalysis: Boolean(
        this.analysis?.activeModelKey && candidate._count?.media,
      ),
      classificationTags:
        analysis.score !== null
          ? (this.analysis?.classificationTags(candidate.analysisPredictions) ??
            [])
          : [],
      reviewPriority:
        analysis.score !== null
          ? analysis.score >= 0.8
            ? "high"
            : analysis.score >= 0.5
              ? "medium"
              : "low"
          : analysis.state === "failed"
            ? "failed"
            : analysis.state === "queued"
              ? "queued"
              : "unprocessed",
      authorId: candidate.authorId,
      authorName: candidate.author.displayName,
      authorHandle: account?.handle ?? null,
      authorAvatarAvailable: Boolean(
        candidate.author.avatarFileObjectId || account?.avatarFileObjectId,
      ),
      platform: candidate.platform,
      sourceLanguage: candidate.author.sourceLanguage,
      sourceAdapters: candidate.sourceObservations.map(
        (observation) => observation.adapterKey,
      ),
      hashtags: candidate.hashtags.map((hashtag) => hashtag.displayValue),
      tagDisposition: candidate.tagDisposition,
      visualClass:
        candidate.classificationDecision?.label ??
        candidate.classificationSuggestions[0]?.label ??
        "manga",
      visualClassSource: candidate.classificationDecision
        ? "human"
        : candidate.classificationSuggestions.length
          ? "model"
          : "default",
      classificationRevision:
        candidate.classificationDecision?.revision ?? null,
      externalPostId: candidate.externalPostId,
      externalPostUrl: candidate.externalPostUrl,
      text: candidate.text,
      referencedPostType: candidate.referencedPostType,
      referencedPostId: candidate.referencedPostId,
      status: candidate.status,
      revision: candidate.revision,
      media: candidate.media.map((media) => ({
        id: media.id,
        externalMediaId: media.externalMediaId,
        orderIndex: media.orderIndex,
        width: media.width,
        height: media.height,
        mediaType: media.mediaType,
      })),
      postedAt: candidate.postedAt.toISOString(),
      fetchedAt: candidate.fetchedAt.toISOString(),
      reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
      workId: candidate.work?.id ?? null,
    };
  }

  async list(query: CandidateQueryDto): Promise<CandidatePageDto> {
    const limit = query.limit ?? 24;
    const search = query.search?.replace(/^@/, "").trim();
    const activeModelKey = this.analysis?.activeModelKey;
    const rows = await this.db.candidatePost.findMany({
      where: {
        status: query.status ?? "pending",
        authorId: query.authorId,
        author: {
          sourceLanguage: query.sourceLanguage,
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
        },
        fetchedAt:
          query.fetchedAfter || query.fetchedBefore
            ? {
                gte: query.fetchedAfter
                  ? new Date(query.fetchedAfter)
                  : undefined,
                lte: query.fetchedBefore
                  ? new Date(query.fetchedBefore)
                  : undefined,
              }
            : undefined,
      },
      select: {
        id: true,
        tagDisposition: true,
        analysisScore: true,
        analysisState: true,
        analysisModelKey: true,
        analysisPredictions: true,
        postedAt: true,
        classificationDecision: { select: { label: true } },
        classificationSuggestions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { label: true },
        },
        ...(activeModelKey
          ? {
              _count: {
                select: {
                  media: {
                    where: {
                      fileObject: {
                        lifecycleStatus: "active" as const,
                        deletedAt: null,
                      },
                      candidatePost: { author: { deletedAt: null } },
                      OR: [
                        { analyses: { none: { modelKey: activeModelKey } } },
                        {
                          analyses: {
                            some: {
                              modelKey: activeModelKey,
                              status: "queued",
                            },
                          },
                        },
                        {
                          analyses: { some: { modelKey: activeModelKey } },
                          candidatePost: {
                            OR: [
                              { analysisModelKey: null },
                              { analysisModelKey: { not: activeModelKey } },
                              { analysisSummaryVersion: { lt: 1 } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }
          : {}),
      },
    });
    // Pending work can be outside the selected group or loaded page and still
    // move into this view after analysis. Reuse the existing filtered summary.
    const analysisPending = Boolean(
      activeModelKey && rows.some((row) => row._count?.media > 0),
    );
    // Validate each bounded prediction cache once, not on every sort comparison.
    const summaries = new Map(
      rows.map((row) => [row.id, this.analysisSummary(row)]),
    );
    const classifyGroup = (row: (typeof rows)[number]) => {
      const visual =
        row.classificationDecision?.label ??
        row.classificationSuggestions[0]?.label ??
        "manga";
      if (visual === "photo") return "photo" as const;
      if (row.tagDisposition === "blocked") return "blocked_manga" as const;
      if (
        row.tagDisposition === "valid" ||
        (summaries.get(row.id)!.score !== null &&
          this.analysis?.promotesReview(row.analysisPredictions))
      )
        return "valid_manga" as const;
      return "neutral_manga" as const;
    };
    // Resolve model policy once per candidate, rather than on every sort comparison.
    const groups = new Map(rows.map((row) => [row.id, classifyGroup(row)]));
    const group = (row: (typeof rows)[number]) => groups.get(row.id)!;
    const rank = {
      valid_manga: 0,
      neutral_manga: 1,
      blocked_manga: 2,
      photo: 3,
    } as const;
    const filtered = rows
      .filter((row) => !query.triageGroup || group(row) === query.triageGroup)
      .sort(
        (left, right) =>
          ((query.status ?? "pending") === "pending"
            ? rank[group(left)] - rank[group(right)]
            : 0) ||
          ((query.status ?? "pending") === "pending"
            ? (summaries.get(right.id)!.score ?? -1) -
              (summaries.get(left.id)!.score ?? -1)
            : 0) ||
          right.postedAt.getTime() - left.postedAt.getTime() ||
          right.id.localeCompare(left.id),
      );
    let start = 0;
    if (query.cursor) {
      start = filtered.findIndex((row) => row.id === query.cursor) + 1;
      if (!start) throw new BadRequestException("候选分页游标无效或已过期");
    }
    const page = filtered.slice(start, start + limit);
    const loaded = page.length
      ? await this.db.candidatePost.findMany({
          where: { id: { in: page.map((row) => row.id) } },
          include: this.detailsWithAnalysis(),
        })
      : [];
    const loadedById = new Map(
      loaded.map((candidate) => [candidate.id, candidate]),
    );
    return {
      analysisPending,
      items: page.map((row) => this.dto(loadedById.get(row.id)!)),
      total: filtered.length,
      nextCursor:
        start + page.length < filtered.length
          ? (page.at(-1)?.id ?? null)
          : null,
    };
  }

  async get(id: string): Promise<CandidateDto> {
    const candidate = await this.db.candidatePost.findUnique({
      where: { id },
      include: this.detailsWithAnalysis(),
    });
    if (!candidate) throw new NotFoundException("候选不存在");
    return this.dto(candidate);
  }

  async listTagGroups(): Promise<CandidateTagGroupDto[]> {
    const groups = await this.db.candidateTagGroup.findMany({
      include: { aliases: { orderBy: { normalizedValue: "asc" } } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      kind: group.kind,
      enabled: group.enabled,
      aliases: group.aliases.map((alias) => alias.displayValue),
      revision: group.revision,
    }));
  }

  async createTagGroup(
    input: CreateCandidateTagGroupDto,
  ): Promise<CandidateTagGroupDto> {
    const aliases = this.tagAliases(input.aliases);
    await this.withCandidateConflict(() =>
      this.db.candidateTagGroup.create({
        data: {
          name: input.name.trim(),
          kind: input.kind,
          enabled: input.enabled,
          aliases: { create: aliases },
        },
      }),
    );
    await this.refreshAllTagDispositions();
    return (await this.listTagGroups()).find(
      (group) => group.name === input.name.trim(),
    )!;
  }

  async updateTagGroup(
    id: string,
    input: UpdateCandidateTagGroupDto,
  ): Promise<CandidateTagGroupDto> {
    const aliases = this.tagAliases(input.aliases);
    await this.withCandidateConflict(() =>
      this.db.$transaction(async (tx) => {
        const changed = await tx.candidateTagGroup.updateMany({
          where: { id, revision: input.expectedRevision },
          data: {
            name: input.name.trim(),
            kind: input.kind,
            enabled: input.enabled,
            revision: { increment: 1 },
          },
        });
        if (!changed.count)
          throw new ConflictException("标签组已更新，请刷新后重试");
        await tx.candidateTagAlias.deleteMany({ where: { groupId: id } });
        await tx.candidateTagAlias.createMany({
          data: aliases.map((alias) => ({ groupId: id, ...alias })),
        });
      }),
    );
    await this.refreshAllTagDispositions();
    return (await this.listTagGroups()).find((group) => group.id === id)!;
  }

  async setClassification(
    actorId: string,
    id: string,
    input: SetCandidateClassificationDto,
  ): Promise<CandidateDto> {
    if (!(await this.db.candidatePost.count({ where: { id } })))
      throw new NotFoundException("候选不存在");
    const existing = await this.db.candidateClassificationDecision.findUnique({
      where: { candidatePostId: id },
    });
    if (existing && input.expectedRevision !== existing.revision)
      throw new ConflictException("人工分类已更新，请刷新后重试");
    if (!existing && input.expectedRevision !== null)
      throw new ConflictException("人工分类状态已变化，请刷新后重试");
    await this.db.candidateClassificationDecision.upsert({
      where: { candidatePostId: id },
      create: { candidatePostId: id, label: input.label, decidedById: actorId },
      update: {
        label: input.label,
        decidedById: actorId,
        revision: { increment: 1 },
      },
    });
    return this.get(id);
  }

  private tagAliases(values: string[]) {
    const aliases = values.map((value) => normalizeHashtag(value));
    if (aliases.some((alias) => !alias))
      throw new BadRequestException("标签别名不能为空、包含空格或超过 100 字");
    const valid = aliases.filter((alias) => alias !== null);
    if (
      new Set(valid.map((alias) => alias.normalizedValue)).size !== valid.length
    )
      throw new BadRequestException("标签别名不能重复");
    return valid;
  }

  private async refreshAllTagDispositions() {
    await this.db.$executeRaw`
      UPDATE candidate_posts AS candidate
      SET tag_disposition = CASE
        WHEN EXISTS (
          SELECT 1 FROM candidate_hashtags AS hashtag
          JOIN candidate_tag_aliases AS alias ON alias.normalized_value = hashtag.normalized_value
          JOIN candidate_tag_groups AS tag_group ON tag_group.id = alias.group_id
          WHERE hashtag.candidate_post_id = candidate.id
            AND tag_group.enabled = true
            AND tag_group.kind = 'blocked'::"CandidateTagGroupKind"
        ) THEN 'blocked'::"CandidateTagDisposition"
        WHEN EXISTS (
          SELECT 1 FROM candidate_hashtags AS hashtag
          JOIN candidate_tag_aliases AS alias ON alias.normalized_value = hashtag.normalized_value
          JOIN candidate_tag_groups AS tag_group ON tag_group.id = alias.group_id
          WHERE hashtag.candidate_post_id = candidate.id
            AND tag_group.enabled = true
            AND tag_group.kind = 'valid'::"CandidateTagGroupKind"
        ) THEN 'valid'::"CandidateTagDisposition"
        ELSE 'neutral'::"CandidateTagDisposition"
      END
    `;
  }

  private async tagDisposition(
    db: Prisma.TransactionClient | PrismaService,
    hashtags: { normalizedValue: string }[],
  ): Promise<CandidateTagDisposition> {
    if (!hashtags.length) return CandidateTagDisposition.neutral;
    const matches = await db.candidateTagAlias.findMany({
      where: {
        normalizedValue: { in: hashtags.map((tag) => tag.normalizedValue) },
        group: { enabled: true, kind: { in: ["valid", "blocked"] } },
      },
      select: { group: { select: { kind: true } } },
    });
    if (matches.some(({ group }) => group.kind === "blocked"))
      return CandidateTagDisposition.blocked;
    if (matches.some(({ group }) => group.kind === "valid"))
      return CandidateTagDisposition.valid;
    return CandidateTagDisposition.neutral;
  }

  private async withCandidateConflict<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException("标签组名称或别名已存在");
      throw error;
    }
  }

  async mediaUrl(
    candidateId: string,
    mediaId: string,
    variant: "original" | "thumbnail" = "original",
  ) {
    const media = await this.db.candidateMedia.findFirst({
      where: { id: mediaId, candidatePostId: candidateId },
    });
    if (!media) throw new NotFoundException("候选图片不存在");
    return this.files.imageUrl(media.fileObjectId, variant);
  }

  async uploadManual(
    actorId: string,
    input: ManualCandidateUploadDto,
    uploads: ManualUploadFile[],
  ) {
    const author = await this.db.author.findFirst({
      where: { id: input.authorId, deletedAt: null },
    });
    if (!author) throw new NotFoundException("作者不存在");
    if (author.authorizationStatus !== "authorized") {
      throw new BadRequestException("只能为授权有效的作者上传图源");
    }
    const results = [];
    for (const upload of uploads) {
      try {
        const group = prepareManualUpload(upload);
        const candidate = await this.storeManualGroup(actorId, input, group);
        results.push({
          sourceName: upload.originalname,
          outcome: ManualUploadOutcome.created,
          message: null,
          warnings: group.warnings,
          candidate,
        });
      } catch (error) {
        results.push({
          sourceName: upload.originalname,
          outcome: ManualUploadOutcome.failed,
          message:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "上传内容无法处理",
          warnings: [],
          candidate: null,
        });
      }
    }
    return { results };
  }

  async createUploadSession(
    actorId: string,
    input: CreateCandidateUploadSessionDto,
  ): Promise<CandidateUploadSessionDto> {
    await this.expireStaleUploadSessions();
    const author = await this.db.author.findFirst({
      where: { id: input.authorId, deletedAt: null },
    });
    if (!author) throw new NotFoundException("作者不存在");
    if (author.authorizationStatus !== "authorized") {
      throw new BadRequestException("只能为授权有效的作者上传图源");
    }
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + uploadSessionLifetimeMs);
    const items = input.files.map((file) => {
      const id = randomUUID();
      const extension = extname(file.sourceName).toLowerCase().slice(0, 10);
      return {
        id,
        sourceName: file.sourceName,
        objectKey: `staging/candidate-upload/${sessionId}/${id}${extension}`,
        contentType: file.contentType,
        size: BigInt(file.size),
        checksum: file.checksum,
      };
    });
    const session = await this.db.candidateUploadSession.create({
      data: {
        id: sessionId,
        actorId,
        authorId: input.authorId,
        text: input.text?.trim() || null,
        sourceUrl: input.sourceUrl?.trim() || null,
        expiresAt,
        items: { create: items },
      },
      include: uploadSessionDetails,
    });
    return this.uploadSessionDto(session);
  }

  async getUploadSession(
    actorId: string,
    id: string,
  ): Promise<CandidateUploadSessionDto> {
    let session = await this.findUploadSession(actorId, id);
    if (
      ["pending", "finalizing"].includes(session.status) &&
      session.expiresAt.getTime() <= Date.now()
    ) {
      await this.expireUploadSession(session);
      session = await this.findUploadSession(actorId, id);
    }
    return this.uploadSessionDto(session);
  }

  async finalizeUploadSession(
    actorId: string,
    id: string,
    background = false,
    signal?: AbortSignal,
  ): Promise<CandidateUploadSessionDto> {
    let session = await this.findUploadSession(actorId, id);
    if (session.status === "completed" || session.status === "expired") {
      if (session.status === "expired") {
        throw new ConflictException("上传会话已过期，请重新选择文件");
      }
      return this.uploadSessionDto(session);
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.expireUploadSession(session);
      throw new ConflictException("上传会话已过期，请重新选择文件");
    }
    if (session.status === "finalizing" && !background) {
      if (session.updatedAt.getTime() > Date.now() - 10 * 60 * 1000) {
        throw new ConflictException("上传内容正在处理，请稍后刷新结果");
      }
      await this.db.candidateUploadSession.update({
        where: { id: session.id },
        data: { status: "pending" },
      });
    }
    const claimed = background
      ? { count: 1 }
      : await this.db.candidateUploadSession.updateMany({
          where: { id: session.id, actorId, status: "pending" },
          data: { status: "finalizing" },
        });
    if (claimed.count !== 1) {
      throw new ConflictException("上传会话状态已变化，请刷新后重试");
    }
    session = await this.findUploadSession(actorId, id);
    const input: ManualCandidateUploadDto = {
      authorId: session.authorId,
      text: session.text,
      sourceUrl: session.sourceUrl,
    };
    for (const item of session.items) {
      signal?.throwIfAborted();
      if (item.status !== "pending") continue;
      try {
        const body = await this.verifyStagingItem(item);
        const group = prepareManualUpload({
          originalname: item.sourceName,
          mimetype: item.contentType,
          size: body.byteLength,
          buffer: Buffer.from(body),
        });
        const candidate = await this.storeManualGroup(
          actorId,
          input,
          group,
          item.id,
        );
        await this.db.candidateUploadItem.update({
          where: { id: item.id },
          data: {
            status: "created",
            resultMessage: null,
            warnings: group.warnings,
            candidatePostId: candidate.id,
          },
        });
      } catch (error) {
        signal?.throwIfAborted();
        await this.jobs?.assertCurrentLease(this.db);
        await this.db.candidateUploadItem.update({
          where: { id: item.id },
          data: {
            status: "failed",
            resultMessage:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "上传内容无法处理",
            warnings: [],
          },
        });
      } finally {
        signal?.throwIfAborted();
        await this.jobs?.assertCurrentLease(this.db);
        await this.files
          .deleteStagingObject(item.objectKey)
          .catch(() => undefined);
      }
    }
    await this.db.candidateUploadSession.update({
      where: { id: session.id },
      data: { status: "completed", completedAt: new Date() },
    });
    return this.uploadSessionDto(await this.findUploadSession(actorId, id));
  }

  private async verifyStagingItem(item: {
    objectKey: string;
    contentType: string;
    size: bigint;
    checksum: string;
  }) {
    const metadata = await this.files.headStagingObject(item.objectKey);
    if (!metadata) throw new Error("文件尚未完成上传");
    if (
      metadata.size !== Number(item.size) ||
      metadata.contentType !== item.contentType ||
      metadata.checksum?.toLowerCase() !== item.checksum.toLowerCase()
    ) {
      throw new Error("上传文件的大小、类型或校验值与会话不一致");
    }
    const body = await this.files.readStagingObject(item.objectKey);
    const checksum = createHash("sha256").update(body).digest("hex");
    if (
      body.byteLength !== Number(item.size) ||
      checksum !== item.checksum.toLowerCase()
    ) {
      throw new Error("上传文件校验失败，请重新选择文件");
    }
    return body;
  }

  private async findUploadSession(actorId: string, id: string) {
    const session = await this.db.candidateUploadSession.findFirst({
      where: { id, actorId },
      include: uploadSessionDetails,
    });
    if (!session) throw new NotFoundException("上传会话不存在");
    if (
      session.status === "finalizing" &&
      (await this.db.backgroundJob.count({
        where: { resourceId: id, kind: "candidate_finalize", status: "failed" },
      }))
    ) {
      await this.db.candidateUploadItem.updateMany({
        where: { sessionId: id, status: "pending" },
        data: {
          status: "failed",
          resultMessage: "后台处理未完成，请重新选择文件",
        },
      });
      await this.db.candidateUploadSession.update({
        where: { id },
        data: { status: "completed", completedAt: new Date() },
      });
      return this.db.candidateUploadSession.findUniqueOrThrow({
        where: { id },
        include: uploadSessionDetails,
      });
    }
    return session;
  }

  private async uploadSessionDto(
    session: UploadSessionDetails,
  ): Promise<CandidateUploadSessionDto> {
    const canUpload =
      session.status === "pending" && session.expiresAt.getTime() > Date.now();
    const items = await Promise.all(
      session.items.map(async (item) => {
        const lifetime = Math.min(
          signedUploadLifetimeSeconds,
          Math.max(
            1,
            Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
          ),
        );
        const target =
          canUpload && item.status === "pending"
            ? await this.files.signedStagingWriteUrl(
                {
                  key: item.objectKey,
                  contentType: item.contentType,
                  size: Number(item.size),
                  checksum: item.checksum,
                },
                lifetime,
              )
            : null;
        return {
          id: item.id,
          sourceName: item.sourceName,
          status: item.status,
          upload: target
            ? {
                url: target.url,
                method: "PUT" as const,
                headers: target.headers,
                expiresAt: new Date(
                  Date.now() + target.expiresInSeconds * 1000,
                ).toISOString(),
              }
            : null,
          message: item.resultMessage,
          warnings: Array.isArray(item.warnings)
            ? item.warnings.filter(
                (warning): warning is string => typeof warning === "string",
              )
            : [],
          candidate: item.candidatePost ? this.dto(item.candidatePost) : null,
        };
      }),
    );
    return {
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
      items,
    };
  }

  private async expireUploadSession(session: UploadSessionDetails) {
    if (
      await this.db.backgroundJob.count({
        where: {
          resourceId: session.id,
          status: "running",
          leaseUntil: { gt: new Date() },
        },
      })
    )
      return;
    await Promise.all(
      session.items.map((item) =>
        this.files.deleteStagingObject(item.objectKey),
      ),
    );
    await this.db.candidateUploadSession.updateMany({
      where: {
        id: session.id,
        status: { in: ["pending", "finalizing", "completed"] },
      },
      data: { status: "expired" },
    });
  }

  private async expireStaleUploadSessions() {
    const sessions = await this.db.candidateUploadSession.findMany({
      where: {
        status: { in: ["pending", "finalizing", "completed"] },
        expiresAt: { lte: new Date() },
      },
      include: uploadSessionDetails,
      take: 50,
    });
    for (const session of sessions) await this.expireUploadSession(session);
  }

  private async storeManualGroup(
    actorId: string,
    input: ManualCandidateUploadDto,
    group: PreparedManualGroup,
    externalPostId: string = randomUUID(),
  ): Promise<CandidateDto> {
    await this.assertUploadActor(this.db, actorId, input.authorId);
    const existing = await this.db.candidatePost.findUnique({
      where: {
        platform_externalPostId: { platform: "manual", externalPostId },
      },
      select: { id: true },
    });
    if (existing) return this.get(existing.id);
    const stored: Prisma.FileObjectGetPayload<object>[] = [];
    try {
      for (const image of group.images) {
        stored.push(
          await this.files.store({
            body: image.body,
            contentType: image.contentType,
            bucketScope: "source",
            kind: "candidate-media",
            sourceName: image.sourceName,
            createdById: actorId,
          }),
        );
      }
      const candidateId = await this.db.$transaction(async (tx) => {
        await this.assertUploadActor(tx, actorId, input.authorId);
        const candidateText = input.text?.trim() || null;
        const hashtags = collectHashtags([], candidateText ?? undefined);
        const tagDisposition = await this.tagDisposition(tx, hashtags);
        const candidate = await tx.candidatePost.create({
          data: {
            authorId: input.authorId,
            authorExternalAccountId: null,
            platform: "manual",
            externalPostId,
            externalPostUrl: input.sourceUrl?.trim() || null,
            text: candidateText,
            postedAt: new Date(),
            rawJson: {
              source: "manual_upload",
              sourceName: group.sourceName,
              automaticallySorted: group.automaticallySorted,
              warnings: group.warnings,
            },
            tagDisposition,
            hashtags: { create: hashtags },
            sourceObservations: {
              create: {
                adapterKey: "manual",
                rawJson: {
                  source: "manual_upload",
                  sourceName: group.sourceName,
                  automaticallySorted: group.automaticallySorted,
                  warnings: group.warnings,
                },
              },
            },
          },
        });
        await tx.candidateMedia.createMany({
          data: group.images.map((image, index) => ({
            candidatePostId: candidate.id,
            externalMediaId: (
              String(index + 1).padStart(3, "0") +
              ":" +
              image.sourceName
            ).slice(0, 255),
            orderIndex: index,
            fileObjectId: stored[index].id,
            sourceUrl: null,
            width: image.width,
            height: image.height,
            mediaType: "photo",
          })),
        });
        return candidate.id;
      });
      return this.get(candidateId);
    } catch (error) {
      for (const file of stored.reverse()) {
        await this.files.purgeUnreferenced(file.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async reorderMedia(id: string, input: ReorderCandidateMediaDto) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM candidate_posts WHERE id = ${id}::uuid FOR UPDATE`,
      );
      const candidate = await tx.candidatePost.findUnique({
        where: { id },
        include: { media: { orderBy: { orderIndex: "asc" } } },
      });
      if (!candidate) throw new NotFoundException("候选不存在");
      if (
        candidate.status !== "pending" ||
        candidate.revision !== input.expectedRevision
      ) {
        throw new ConflictException("候选已更新或当前状态不能调整顺序");
      }
      const currentIds = candidate.media.map((media) => media.id).sort();
      const requestedIds = [...input.mediaIds].sort();
      if (
        currentIds.length !== requestedIds.length ||
        currentIds.some((value, index) => value !== requestedIds[index])
      ) {
        throw new BadRequestException("图片顺序必须包含该候选的全部图片");
      }
      for (let index = 0; index < input.mediaIds.length; index += 1) {
        await tx.candidateMedia.update({
          where: { id: input.mediaIds[index] },
          data: { orderIndex: 1000 + index },
        });
      }
      for (let index = 0; index < input.mediaIds.length; index += 1) {
        await tx.candidateMedia.update({
          where: { id: input.mediaIds[index] },
          data: { orderIndex: index },
        });
      }
      await tx.candidatePost.update({
        where: { id },
        data: { revision: { increment: 1 } },
      });
    });
    return this.get(id);
  }

  async updateManualMetadata(id: string, input: UpdateManualCandidateDto) {
    const text = input.text?.trim() || null;
    const hashtags = collectHashtags([], text ?? undefined);
    await this.db.$transaction(async (tx) => {
      const author = await tx.author.findFirst({
        where: {
          id: input.authorId,
          deletedAt: null,
          authorizationStatus: "authorized",
        },
      });
      if (!author) throw new BadRequestException("请选择授权有效的作者");
      const candidate = await tx.candidatePost.findUnique({ where: { id } });
      if (!candidate) throw new NotFoundException("候选不存在");
      if (
        candidate.platform !== "manual" ||
        candidate.status !== "pending" ||
        candidate.revision !== input.expectedRevision
      ) {
        throw new ConflictException("候选已更新或当前状态不能修改上传信息");
      }
      const tagDisposition = await this.tagDisposition(tx, hashtags);
      const changed = await tx.candidatePost.updateMany({
        where: { id, status: "pending", revision: input.expectedRevision },
        data: {
          authorId: input.authorId,
          text,
          externalPostUrl: input.sourceUrl?.trim() || null,
          tagDisposition,
          revision: { increment: 1 },
        },
      });
      if (!changed.count)
        throw new ConflictException("候选已更新，请刷新后重试");
      await tx.candidateHashtag.deleteMany({ where: { candidatePostId: id } });
      if (hashtags.length) {
        await tx.candidateHashtag.createMany({
          data: hashtags.map((tag) => ({ candidatePostId: id, ...tag })),
        });
      }
    });
    return this.get(id);
  }

  async batch(actorId: string, input: CandidateBatchActionDto) {
    const results = [];
    for (const item of input.items) {
      try {
        results.push(await this.applyOne(actorId, input.action, item));
      } catch (error) {
        results.push({
          id: item.id,
          outcome:
            error instanceof NotFoundException
              ? CandidateActionOutcome.not_found
              : error instanceof ConflictException
                ? CandidateActionOutcome.conflict
                : CandidateActionOutcome.failed,
          message:
            error instanceof NotFoundException ||
            error instanceof ConflictException
              ? error.message
              : "操作失败，请稍后重试",
          workId: null,
        });
      }
    }
    return { results };
  }

  private async applyOne(
    actorId: string,
    action: CandidateAction,
    item: CandidateActionItemDto,
  ) {
    if (action === CandidateAction.import) return this.import(actorId, item);
    const from = action === CandidateAction.discard ? "pending" : "discarded";
    const to = action === CandidateAction.discard ? "discarded" : "pending";
    return this.db.$transaction(async (tx) => {
      const result = await tx.candidatePost.updateMany({
        where: { id: item.id, revision: item.expectedRevision, status: from },
        data: {
          status: to,
          reviewedById: actorId,
          reviewedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (!result.count) {
        const candidate = await tx.candidatePost.findUnique({
          where: { id: item.id },
        });
        if (!candidate) throw new NotFoundException("候选不存在");
        if (candidate.revision !== item.expectedRevision) {
          throw new ConflictException("候选已更新，请刷新后重试");
        }
        throw new ConflictException("候选当前状态不允许该操作");
      }
      await tx.candidateActionLog.create({
        data: {
          candidatePostId: item.id,
          actorId,
          action,
          fromStatus: from,
          toStatus: to,
        },
      });
      return {
        id: item.id,
        outcome: CandidateActionOutcome.succeeded,
        message: null,
        workId: null,
      };
    });
  }

  private async import(actorId: string, item: CandidateActionItemDto) {
    return this.db.$transaction(async (tx) => {
      const candidate = await tx.candidatePost.findUnique({
        where: { id: item.id },
        include: {
          media: { orderBy: { orderIndex: "asc" } },
          author: true,
          work: true,
        },
      });
      if (!candidate) throw new NotFoundException("候选不存在");
      if (candidate.status === "imported" && candidate.work) {
        return {
          id: item.id,
          outcome: CandidateActionOutcome.unchanged,
          message: null,
          workId: candidate.work.id,
        };
      }
      if (
        candidate.revision !== item.expectedRevision ||
        candidate.status !== "pending"
      ) {
        throw new ConflictException("候选已更新或当前状态不允许入库");
      }
      if (!candidate.media.length)
        throw new ConflictException("候选没有可入库图片");
      const changed = await tx.candidatePost.updateMany({
        where: {
          id: item.id,
          revision: item.expectedRevision,
          status: "pending",
        },
        data: {
          status: "imported",
          reviewedById: actorId,
          reviewedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (!changed.count)
        throw new ConflictException("候选已更新，请刷新后重试");
      const work = await tx.work.create({
        data: {
          authorId: candidate.authorId,
          sourceCandidatePostId: candidate.id,
          sourcePostUrl: candidate.externalPostUrl,
          title: null,
          sourceText: candidate.text,
          sourceLanguage: candidate.author.sourceLanguage,
          importedById: actorId,
        },
      });
      await tx.workImage.createMany({
        data: candidate.media.map((media) => ({
          workId: work.id,
          originalFileObjectId: media.fileObjectId,
          orderIndex: media.orderIndex,
          width: media.width,
          height: media.height,
        })),
      });
      await tx.workEvent.create({
        data: {
          workId: work.id,
          actorId,
          action: "imported",
          toWorkflowStatus: work.workflowStatus,
          toReviewStatus: work.reviewStatus,
          detail: { candidatePostId: candidate.id },
        },
      });
      await tx.candidateActionLog.create({
        data: {
          candidatePostId: item.id,
          actorId,
          action: "import",
          fromStatus: "pending",
          toStatus: "imported",
          workId: work.id,
        },
      });
      return {
        id: item.id,
        outcome: CandidateActionOutcome.succeeded,
        message: null,
        workId: work.id,
      };
    });
  }
}
