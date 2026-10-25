import { assertProductionWritable } from "../workflow/review-policy.js";
import { DownloadsService } from "../transfers/downloads.service.js";
import { createTypesetHandoffArchive } from "../typesetting/handoff-package.js";
import type { DownloadPreparation } from "../generated/prisma/client.js";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  Prisma,
  ReviewStatus,
  Role,
  WorkEventAction,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import type {
  ConfirmPublicationDto,
  PublicationRecordDto,
  PublishingViewDto,
} from "./publishing.dto.js";
import {
  defaultPublicationTemplateKey,
  normalizeAuthorCredit,
  renderPublicationText,
} from "./publication-template.js";
import { publicationImagePackageFileName } from "./publication-package.js";

const publicationDetails = {
  author: { select: { displayName: true } },
  sourceCandidatePost: {
    select: {
      authorExternalAccount: { select: { handle: true } },
    },
  },
  currentTypesetVersion: {
    include: {
      images: {
        orderBy: { orderIndex: "asc" },
        include: {
          fileObject: { select: { id: true, contentType: true } },
        },
      },
    },
  },
  events: {
    where: { action: WorkEventAction.stage_submitted },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  },
  creditAliases: { select: { userId: true, stage: true, creditName: true } },
  stageParticipants: {
    select: { userId: true, user: { select: { displayName: true } } },
  },
  publishRecords: {
    orderBy: { publishedAt: "desc" },
    include: {
      publishedBy: { select: { displayName: true } },
      typesetVersion: { select: { versionNumber: true } },
    },
  },
} as const;

type PublicationWork = Prisma.WorkGetPayload<{
  include: typeof publicationDetails;
}>;

@Injectable()
export class PublishingService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Optional()
    @Inject(DownloadsService)
    private readonly downloads?: DownloadsService,
  ) {}

  async view(actorId: string, workId: string): Promise<PublishingViewDto> {
    await this.assertCanPrepare(actorId, workId);
    return this.buildView(this.db, workId);
  }

  onModuleInit() {
    this.downloads?.register("publication", {
      prepare: (task, signal) => this.prepareImageDownload(task, signal),
      deliver: async (task) => {
        await this.validateDownload(task);
        return this.downloads!.signedFile(task);
      },
    });
  }

  private async validateDownload(task: DownloadPreparation) {
    await this.assertCanPrepare(task.actorId, task.workId);
    const prepared = await this.prepare(this.db, task.workId, false);
    assertProductionWritable(prepared.work);
    if (
      prepared.work.revision !== task.expectedRevision ||
      prepared.work.editorEpoch !== task.expectedEditorEpoch
    )
      throw new ConflictException("作品已更新，请重新生成成图包");
    return prepared;
  }

  private async prepareImageDownload(
    task: DownloadPreparation,
    signal: AbortSignal,
  ) {
    const prepared = await this.validateDownload(task);
    const fileName = publicationImagePackageFileName(prepared.work.workNumber);
    const cache = await this.db.downloadPreparation.findFirst({
      where: {
        workId: task.workId,
        purpose: "publication",
        status: "succeeded",
        expectedRevision: task.expectedRevision,
        expectedEditorEpoch: task.expectedEditorEpoch,
        expiresAt: { gt: new Date() },
        fileObject: { lifecycleStatus: "active", deletedAt: null },
      },
      orderBy: { createdAt: "desc" },
    });
    if (cache?.fileObjectId && (await this.files.exists(cache.fileObjectId)))
      return { fileObjectId: cache.fileObjectId, fileName };
    const archive = await createTypesetHandoffArchive(
      (async function* (files: FileObjectsService) {
        for (const image of prepared.work.currentTypesetVersion!.images) {
          signal.throwIfAborted();
          yield {
            contentType: image.fileObject.contentType,
            body: (await files.readStream(image.fileObject.id)).body,
          };
        }
      })(this.files),
      prepared.work.workNumber,
      undefined,
      true,
    );
    let stored;
    try {
      stored = await this.files.storePath({
        path: archive.path,
        contentType: "application/zip",
        bucketScope: "works",
        kind: "publication-package",
        sourceName: fileName,
        createdById: task.actorId,
      });
    } finally {
      await archive.cleanup();
    }
    try {
      signal.throwIfAborted();
      await this.validateDownload(task);
    } catch (error) {
      await this.files.purgeUnreferenced(stored.id);
      throw error;
    }
    return { fileObjectId: stored.id, fileName };
  }

  // Retained compatibility route uses the same streamed archive, never a batch buffer.
  async readCurrentImages(actorId: string, workId: string) {
    const prepared = await this.prepare(this.db, workId, false);
    const result = await this.prepareImageDownload(
      {
        actorId,
        workId,
        expectedRevision: prepared.work.revision,
        expectedEditorEpoch: prepared.work.editorEpoch,
      } as DownloadPreparation,
      new AbortController().signal,
    );
    return {
      fileName: result.fileName,
      body: (await this.files.readStream(result.fileObjectId)).body,
    };
  }

  async confirm(
    actorId: string,
    workId: string,
    input: ConfirmPublicationDto,
  ): Promise<PublishingViewDto> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      const replay = await tx.publishRecord.findUnique({
        where: {
          workId_idempotencyKey: {
            workId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (replay) return;
      const usedEvent = await tx.workEvent.findUnique({
        where: {
          workId_idempotencyKey: {
            workId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (usedEvent) throw new ConflictException("幂等键已用于其他作品操作");
      const prepared = await this.prepare(tx, workId, true);
      if (prepared.work.revision !== input.expectedRevision) {
        throw new ConflictException("作品已更新，请刷新后重新确认发布");
      }
      if (prepared.work.reviewStatus !== ReviewStatus.normal) {
        throw new ConflictException("作品存在未解决的审核事项");
      }
      const now = new Date();
      const record = await tx.publishRecord.create({
        data: {
          workId,
          typesetVersionId: prepared.work.currentTypesetVersion!.id,
          templateId: prepared.template.id,
          templateNameSnapshot: prepared.template.name,
          templateRevision: prepared.template.revision,
          templateContentSnapshot: prepared.template.content,
          generatedTextSnapshot: prepared.generatedText,
          translationCreditsSnapshot: prepared.credits.translate,
          proofreadCreditsSnapshot: prepared.credits.proofread,
          typesetCreditsSnapshot: prepared.credits.typeset,
          note: input.note ?? null,
          idempotencyKey: input.idempotencyKey,
          publishedById: actorId,
          publishedAt: now,
        },
      });
      await tx.work.update({
        where: { id: workId },
        data: {
          workflowStatus: WorkflowStatus.published,
          publishedAt: now,
          revision: { increment: 1 },
        },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action: WorkEventAction.publish_confirmed,
          fromWorkflowStatus: prepared.work.workflowStatus,
          toWorkflowStatus: WorkflowStatus.published,
          fromReviewStatus: prepared.work.reviewStatus,
          toReviewStatus: prepared.work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: {
            operation: "publish-confirm",
            publishRecordId: record.id,
            typesetVersionId: prepared.work.currentTypesetVersion!.id,
            typesetVersionNumber:
              prepared.work.currentTypesetVersion!.versionNumber,
            templateKey: prepared.template.key,
            proofreadSkippedVersionId: prepared.work.proofreadSkippedVersionId,
            templateRevision: prepared.template.revision,
          },
        },
      });
    });
    return this.buildView(this.db, workId);
  }

  private async buildView(
    client: Prisma.TransactionClient,
    workId: string,
  ): Promise<PublishingViewDto> {
    const prepared = await this.prepare(client, workId, false);
    const version = prepared.work.currentTypesetVersion!;
    const publishedRecord =
      prepared.work.workflowStatus === WorkflowStatus.published
        ? prepared.work.publishRecords[0]
        : undefined;
    const publishedCredits = (value: Prisma.JsonValue | null | undefined) =>
      Array.isArray(value) && value.every((item) => typeof item === "string")
        ? (value as string[])
        : null;
    return {
      workId,
      workRevision: prepared.work.revision,
      workflowStatus: prepared.work.workflowStatus,
      title: prepared.work.title!,
      body: prepared.work.publicationBody,
      authorCredit: prepared.authorCredit,
      sourcePostUrl: prepared.work.sourcePostUrl,
      translationCredits:
        publishedCredits(publishedRecord?.translationCreditsSnapshot) ??
        prepared.credits.translate,
      proofreadCredits:
        publishedCredits(publishedRecord?.proofreadCreditsSnapshot) ??
        prepared.credits.proofread,
      typesetCredits:
        publishedCredits(publishedRecord?.typesetCreditsSnapshot) ??
        prepared.credits.typeset,
      generatedText:
        publishedRecord?.generatedTextSnapshot ?? prepared.generatedText,
      templateName: prepared.template.name,
      templateRevision: prepared.template.revision,
      currentTypesetVersionId: version.id,
      currentTypesetVersionNumber: version.versionNumber,
      imageCount: version.images.length,
      publishedAt: prepared.work.publishedAt?.toISOString() ?? null,
      records: prepared.work.publishRecords.map((record) =>
        this.recordDto(record),
      ),
    };
  }

  private async prepare(
    client: Prisma.TransactionClient,
    workId: string,
    requirePending: boolean,
  ) {
    const work = await client.work.findUnique({
      where: { id: workId },
      include: publicationDetails,
    });
    const template = await client.publishTemplate.findUnique({
      where: { key: defaultPublicationTemplateKey },
    });
    if (!work) throw new NotFoundException("作品不存在");
    if (!work.title?.trim()) {
      throw new ConflictException("请先填写作品标题再发布");
    }
    if (
      requirePending
        ? work.workflowStatus !== WorkflowStatus.pending_publish
        : work.workflowStatus !== WorkflowStatus.pending_publish &&
          work.workflowStatus !== WorkflowStatus.published
    ) {
      throw new ConflictException(
        requirePending ? "作品当前不能确认发布" : "作品尚未完成嵌字阶段",
      );
    }
    if (
      requirePending &&
      (work.typesetReviewRequired ||
        (work.requiredHandoffVersionId &&
          work.currentTypesetVersion?.reviewedTranslationVersionId !==
            work.requiredHandoffVersionId))
    )
      throw new ConflictException("修订后的成图尚未复核，不能确认发布");
    const version = work.currentTypesetVersion;
    if (!version || version.deletedAt || !version.images.length) {
      throw new ConflictException("作品没有完整且有效的当前成图版本");
    }
    if (!template?.isActive) {
      throw new ConflictException("默认发布模板不可用");
    }
    const credits = this.submissionCredits(work);
    if (
      !credits.translate.length ||
      (!work.proofreadSkippedVersionId && !credits.proofread.length) ||
      !credits.typeset.length
    ) {
      throw new ConflictException("作品缺少已冻结的翻译、校对或嵌字署名");
    }
    const authorCredit = normalizeAuthorCredit(
      work.sourceCandidatePost.authorExternalAccount?.handle,
      work.author.displayName,
    );
    return {
      work,
      template,
      credits,
      authorCredit,
      generatedText: renderPublicationText(template.content, {
        proofreadingSkipped: Boolean(work.proofreadSkippedVersionId),
        title: work.title,
        body: work.publicationBody,
        author: authorCredit,
        translationCredits: credits.translate,
        proofreadCredits: credits.proofread,
        typesetCredits: credits.typeset,
      }),
    };
  }

  private submissionCredits(work: PublicationWork) {
    const aliases = new Map(
      work.creditAliases.map(({ userId, stage, creditName }) => [
        `${stage}:${userId}`,
        creditName,
      ]),
    );
    const displayNames = new Map(
      work.stageParticipants.map(({ userId, user }) => [
        userId,
        user.displayName,
      ]),
    );
    const result = {
      translate: [] as string[],
      proofread: [] as string[],
      typeset: [] as string[],
    };
    for (const event of work.events) {
      const detail = event.detail;
      if (!detail || Array.isArray(detail) || typeof detail !== "object") {
        continue;
      }
      const stage = detail.stage;
      if (!(
        stage === "translate" ||
        stage === "proofread" ||
        stage === "typeset"
      )) {
        continue;
      }
      if (result[stage].length || !Array.isArray(detail.credits)) continue;
      result[stage] = [
        ...new Set(
          detail.credits.flatMap((credit) => {
            if (
              !credit ||
              Array.isArray(credit) ||
              typeof credit !== "object" ||
              typeof credit.creditName !== "string" ||
              !credit.creditName.trim()
            ) {
              return [];
            }
            const userId =
              typeof credit.userId === "string" ? credit.userId : null;
            return [
              (userId
                ? (aliases.get(`${stage}:${userId}`) ??
                  displayNames.get(userId))
                : undefined) ?? credit.creditName.trim(),
            ];
          }),
        ),
      ];
    }
    if (work.proofreadSkippedVersionId) result.proofread = [];
    return result;
  }

  private recordDto(
    record: PublicationWork["publishRecords"][number],
  ): PublicationRecordDto {
    return {
      id: record.id,
      typesetVersionId: record.typesetVersionId,
      typesetVersionNumber: record.typesetVersion.versionNumber,
      templateName: record.templateNameSnapshot,
      templateRevision: record.templateRevision,
      generatedText: record.generatedTextSnapshot,
      note: record.note,
      publishedById: record.publishedById,
      publishedByName: record.publishedBy.displayName,
      publishedAt: record.publishedAt.toISOString(),
    };
  }

  private async assertCanPrepare(actorId: string, workId: string) {
    const user = await this.db.user.findUnique({
      where: { id: actorId },
      select: {
        roles: { select: { role: true } },
        workParticipations: {
          where: { workId, stage: "typeset", leftAt: null },
          select: { id: true },
        },
      },
    });
    const roles = new Set(user?.roles.map(({ role }) => role) ?? []);
    if (
      !user ||
      (!roles.has(Role.admin) &&
        !roles.has(Role.operator) &&
        !roles.has(Role.reviewer) &&
        (!roles.has(Role.typesetter) || !user.workParticipations.length))
    ) {
      throw new ForbiddenException("没有整理此作品发布内容的权限");
    }
  }
}
