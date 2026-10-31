import {
  candidateTagRules,
  candidateReviewPolicyKey,
  emptyCandidateReviewReason,
  type CandidateReviewRow,
} from "./candidate-review-evidence.js";
import {
  CandidateReviewSessions,
  assertCandidateReader,
} from "./candidate-review-sessions.js";
import {
  candidateBaseWhere,
  candidateFilterHash,
  candidateRankingCte,
  candidatePendingSql,
  decodeCandidateCursor,
  encodeCandidateCursor,
  normalizeCandidateFilter,
} from "./candidate-query.js";
import type { CreateCandidateReviewSessionDto } from "./candidates.dto.js";
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
import { Prisma } from "../generated/prisma/client.js";
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
      triageGroup: "uncertain",
      triageReasons: ["insufficient_evidence"],
      tagRuleMatches: [],
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

  private get reviewSessions() {
    return new CandidateReviewSessions(this.db);
  }
  private get queryPolicy() {
    return (
      this.analysis?.candidateQueryPolicy ?? {
        modelKey: null,
        labels: [],
        positiveLabels: [],
        lowPriorityLabels: [],
      }
    );
  }
  reviewPolicy() {
    const policy = this.queryPolicy;
    const presentation = this.analysis?.labelPresentation ?? [];
    return {
      modelKey: policy.modelKey,
      policyKey: candidateReviewPolicyKey(policy),
      classes: policy.labels.map((label) => ({
        label,
        text:
          presentation.find((entry) => entry.label === label)?.text ?? label,
        tone:
          presentation.find((entry) => entry.label === label)?.tone ??
          ("neutral" as const),
        triageGroup: policy.positiveLabels.includes(label)
          ? ("priority" as const)
          : policy.lowPriorityLabels?.includes(label)
            ? ("low_priority" as const)
            : ("uncertain" as const),
      })),
    };
  }
  private reviewDto(
    candidate: Parameters<CandidatesService["dto"]>[0],
    row?: CandidateReviewRow,
  ) {
    const dto = this.dto(candidate);
    const reason = row?.reason_json ?? emptyCandidateReviewReason;
    return {
      ...dto,
      ...(row && "representative_class" in row
        ? {
            classificationTags: row.representative_class
              ? this.reviewPolicy()
                  .classes.filter(
                    (entry) => entry.label === row.representative_class,
                  )
                  .map(({ label, text, tone }) => ({ label, text, tone }))
              : [],
          }
        : {}),
      triageGroup: row?.triage_group ?? dto.triageGroup,
      triageReasons: reason.triageReasons,
      tagRuleMatches: reason.tagRuleMatches,
      hashtags: row ? reason.hashtags : dto.hashtags,
    };
  }
  createReviewSession(actorId: string, input: CreateCandidateReviewSessionDto) {
    return this.reviewSessions.create(actorId, input, this.queryPolicy);
  }
  cleanupReviewSessions() {
    return this.reviewSessions.cleanup();
  }

  async list(
    query: CandidateQueryDto,
    actorId?: string,
  ): Promise<CandidatePageDto> {
    const filter = normalizeCandidateFilter(query);
    const policy = this.queryPolicy;
    const binding = {
      sessionId: query.reviewSessionId ?? null,
      filterHash: candidateFilterHash(filter),
      modelKey: policy.modelKey,
      group: query.triageGroup ?? null,
    };
    const limit = Math.min(100, Math.max(1, query.limit ?? 24));
    return this.db.$transaction(
      async (tx) => {
        const session = query.reviewSessionId
          ? await this.reviewSessions.read(
              tx,
              query.reviewSessionId,
              actorId ?? "",
              filter,
              policy.modelKey,
            )
          : null;
        if (actorId && !session) await assertCandidateReader(tx, actorId);
        const cursor = query.cursor
          ? decodeCandidateCursor(query.cursor, binding, session?.cursorSecret)
          : null;
        type PageRow = {
          id: string;
          ordinal: number;
          rank: number;
          sort_score: number;
          posted_at: Date;
          triage_group: CandidateReviewRow["triage_group"];
          reason_json: CandidateReviewRow["reason_json"];
          representative_class?: string | null;
        };
        let page: PageRow[];
        let total: number;
        if (session) {
          const where = Prisma.sql`e.session_id = ${session.id}::uuid AND ${candidateBaseWhere(filter)} ${query.triageGroup ? Prisma.sql`AND e.triage_group = ${query.triageGroup}` : Prisma.empty}`;
          const count = await tx.$queryRaw<
            { count: number }[]
          >`SELECT count(*)::int AS count FROM candidate_review_session_entries e JOIN candidate_posts c ON c.id = e.candidate_id JOIN authors a ON a.id = c.author_id WHERE ${where}`;
          total = count[0].count;
          page = await tx.$queryRaw<
            PageRow[]
          >`SELECT c.id, e.ordinal, e.triage_group, e.reason_json FROM candidate_review_session_entries e JOIN candidate_posts c ON c.id = e.candidate_id JOIN authors a ON a.id = c.author_id WHERE ${where} AND e.ordinal > ${cursor?.ordinal ?? 0} ORDER BY e.ordinal LIMIT ${limit + 1}`;
        } else {
          const rules = await candidateTagRules(tx);
          const cte = candidateRankingCte(filter, policy, rules.rules);
          const group = query.triageGroup
            ? Prisma.sql`triage_group = ${query.triageGroup}`
            : Prisma.sql`true`;
          const count = await tx.$queryRaw<
            { count: number }[]
          >`${cte} SELECT count(*)::int AS count FROM ranked WHERE ${group}`;
          total = count[0].count;
          // id sorts descending too; spell out the final tie instead of negating UUIDs.
          const keyset = cursor
            ? Prisma.sql`AND (rank > ${cursor.rank} OR (rank = ${cursor.rank} AND (sort_score < ${cursor.score} OR (sort_score = ${cursor.score} AND (posted_at < ${new Date(cursor.postedAt!)} OR (posted_at = ${new Date(cursor.postedAt!)} AND id < ${cursor.id}::uuid))))))`
            : Prisma.empty;
          page = await tx.$queryRaw<
            PageRow[]
          >`${cte} SELECT id, rank, sort_score, posted_at, triage_group, reason_json, representative_class FROM ranked WHERE ${group} ${keyset} ORDER BY rank, sort_score DESC, posted_at DESC, id DESC LIMIT ${limit + 1}`;
        }
        const hasNext = page.length > limit;
        page = page.slice(0, limit);
        const loaded = page.length
          ? await tx.candidatePost.findMany({
              where: {
                id: { in: page.map((row) => row.id) },
                status: filter.status,
                author: { deletedAt: null },
              },
              include: this.detailsWithAnalysis(),
            })
          : [];
        if (session && page.length) {
          const live = await tx.$queryRaw<
            { id: string; representative_class: string | null }[]
          >`${candidateRankingCte(
            filter,
            policy,
            [],
            page.map((row) => row.id),
          )} SELECT id,representative_class FROM ranked`;
          const classes = new Map(
            live.map((row) => [row.id, row.representative_class]),
          );
          for (const row of page)
            row.representative_class = classes.get(row.id) ?? null;
        }
        const byId = new Map(loaded.map((row) => [row.id, row]));
        const pending = await tx.$queryRaw<{ pending: boolean }[]>(
          candidatePendingSql(filter, policy.modelKey, session?.id),
        );
        const last = page.at(-1);
        return {
          analysisPending: pending[0].pending,
          items: page.flatMap((row) => {
            const current = byId.get(row.id);
            return current ? [this.reviewDto(current, row)] : [];
          }),
          total,
          nextCursor:
            hasNext && last
              ? encodeCandidateCursor(
                  {
                    ...binding,
                    ...(session
                      ? { ordinal: last.ordinal }
                      : {
                          rank: last.rank,
                          score: last.sort_score,
                          postedAt: last.posted_at.toISOString(),
                          id: last.id,
                        }),
                  },
                  session?.cursorSecret,
                )
              : null,
        };
      },
      { timeout: 30_000 },
    );
  }

  async get(id: string): Promise<CandidateDto> {
    const candidate = await this.db.candidatePost.findUnique({
      where: { id },
      include: this.detailsWithAnalysis(),
    });
    if (!candidate) throw new NotFoundException("候选不存在");
    const rules = await candidateTagRules(this.db);
    const rows = await this.db.$queryRaw<
      CandidateReviewRow[]
    >`${candidateRankingCte(normalizeCandidateFilter({ status: candidate.status }), this.queryPolicy, rules.rules, [id])} SELECT id,triage_group,reason_json,representative_class FROM ranked`;
    return this.reviewDto(candidate, rows[0]);
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
    if (input.kind === "gray")
      throw new BadRequestException("不能新建灰名单规则");
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
        const existing = await tx.candidateTagGroup.findUnique({
          where: { id },
          select: { kind: true },
        });
        if (input.kind === "gray" && existing?.kind !== "gray")
          throw new BadRequestException("不能新增灰名单行为");
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
    return (await this.listTagGroups()).find((group) => group.id === id)!;
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
    const reviewRows = new Map<string, CandidateReviewRow>();
    const candidates = session.items.flatMap((item) =>
      item.candidatePost ? [item.candidatePost] : [],
    );
    if (candidates.length) {
      const rules = await candidateTagRules(this.db);
      for (const status of new Set(
        candidates.map((candidate) => candidate.status),
      )) {
        const ids = candidates
          .filter((candidate) => candidate.status === status)
          .map((candidate) => candidate.id);
        const rows = await this.db.$queryRaw<
          CandidateReviewRow[]
        >`${candidateRankingCte(normalizeCandidateFilter({ status }), this.queryPolicy, rules.rules, ids)} SELECT id,triage_group,reason_json,representative_class FROM ranked`;
        for (const row of rows) reviewRows.set(row.id, row);
      }
    }
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
          candidate: item.candidatePost
            ? this.reviewDto(
                item.candidatePost,
                reviewRows.get(item.candidatePost.id),
              )
            : null,
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
      const changed = await tx.candidatePost.updateMany({
        where: { id, status: "pending", revision: input.expectedRevision },
        data: {
          authorId: input.authorId,
          text,
          externalPostUrl: input.sourceUrl?.trim() || null,
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
