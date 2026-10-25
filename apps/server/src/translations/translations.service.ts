import { assertProductionWritable } from "../workflow/review-policy.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { proofreadSkipAvailability } from "../workflow/proofread-exemption.js";
import { randomUUID } from "node:crypto";
import {
  Prisma,
  ReviewStatus,
  Role,
  TranslationPresenceMode,
  TranslationVersionKind,
  WorkEventAction,
  WorkCollaborationMode,
  WorkStage,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import {
  defaultLabelPlusHeader,
  encodeLabelPlus,
  LabelPlusParseError,
  parseLabelPlus,
  type LabelPlusDocument,
  type LabelPlusParseResult,
} from "../labelplus/labelplus-codec.js";
import {
  canSubmitWorkStage,
  canUserWorkStage,
} from "../workflow/workflow-policy.js";
import { targetImageFileName } from "../typesetting/handoff-package.js";
import type {
  CreateTranslationEntryDto,
  DeleteTranslationEntryDto,
  ExportLabelPlusDto,
  ImportLabelPlusDto,
  LabelPlusExportDto,
  LabelPlusImportPreviewDto,
  ReorderTranslationEntryDto,
  TranslationEditorDto,
  TranslationEntryDto,
  TranslationImageDraftDto,
  TranslationPresenceListDto,
  UpdateTranslationPresenceDto,
  UpdateTranslationEntryDto,
} from "./translations.dto.js";

type DatabaseClient = PrismaService | Prisma.TransactionClient;
type TypesetHandoffDetail = {
  downloadTaskId?: string;
  material: "translation_package" | "source_images" | "unified_handoff";
  fileId: string;
  expectedRevision?: number;
  expectedEditorEpoch?: number;
  requireCurrentParticipation?: boolean;
};
type TranslationEntryRow = Prisma.TranslationEntryGetPayload<object>;
type EditableWorkState = {
  id: string;
  revision: number;
  workflowStatus: WorkflowStatus;
  reviewStatus: ReviewStatus;
  editorEpoch: number;
  stage: WorkStage;
};

const entryOrder = { orderIndex: "asc" } as const;
const presenceExpiresInSeconds = 90;
const stalePresenceRetentionMs = 24 * 60 * 60 * 1000;
const markerCoordinateScale = 1_000;

function normalizeMarkerCoordinate(value: number): number;
function normalizeMarkerCoordinate(value: undefined): undefined;
function normalizeMarkerCoordinate(
  value: number | undefined,
): number | undefined;
function normalizeMarkerCoordinate(value: number | undefined) {
  return value === undefined
    ? undefined
    : Math.round(value * markerCoordinateScale) / markerCoordinateScale;
}

export interface LabelPlusUpload {
  buffer: Uint8Array;
  originalname: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class TranslationsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
  ) {}

  async getEditor(
    actorId: string,
    workId: string,
    currentSessionId?: string,
  ): Promise<TranslationEditorDto> {
    const work = await this.db.work.findUnique({
      where: { id: workId },
      include: {
        proofreadSkippedVersion: true,
        images: {
          include: { translationEntries: { orderBy: entryOrder } },
          orderBy: { orderIndex: "asc" },
        },
        translationVersions: {
          include: {
            createdBy: { select: { displayName: true } },
            entries: true,
          },
          orderBy: { versionNumber: "desc" },
          take: 1,
        },
        reviewCases: {
          where: { status: "open" },
          include: { openedBy: { select: { displayName: true } } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (!work) throw new NotFoundException("作品不存在");
    const submissionStage = this.submittableTextStage(work.workflowStatus);
    const currentStage = this.currentTextStage(work.workflowStatus);
    const participationStages = await this.editParticipationStages(
      this.db,
      actorId,
      workId,
    );
    const canEdit =
      work.workflowStatus !== WorkflowStatus.archived &&
      work.reviewStatus === ReviewStatus.normal &&
      participationStages.length > 0;
    const latest = work.translationVersions[0];
    const editorParticipationStage =
      currentStage && participationStages.includes(currentStage)
        ? currentStage
        : null;
    const activeParticipation = editorParticipationStage
      ? await this.db.workStageParticipant.findFirst({
          where: {
            workId,
            userId: actorId,
            stage: editorParticipationStage,
            submittedAt: null,
            leftAt: null,
          },
          include: {
            assignments: true,
            contributionSubmissions: {
              orderBy: { createdAt: "desc" },
              take: 1,
              include: { pages: true },
            },
          },
        })
      : null;
    const actor = currentStage
      ? await this.db.user.findUnique({
          where: { id: actorId },
          select: {
            roles: { select: { role: true } },
            languageCapabilities: { select: { language: true } },
          },
        })
      : null;
    const activeParticipantCount = currentStage
      ? await this.db.workStageParticipant.count({
          where: {
            workId,
            stage: currentStage,
            submittedAt: null,
            leftAt: null,
          },
        })
      : 0;
    const violatesSingleSeparation =
      currentStage && work.collaborationMode === WorkCollaborationMode.single
        ? Boolean(
            await this.db.workStageParticipant.findFirst({
              where: {
                workId,
                userId: actorId,
                stage:
                  currentStage === WorkStage.translate
                    ? WorkStage.proofread
                    : WorkStage.translate,
                leftAt: null,
              },
              select: { id: true },
            }),
          )
        : false;
    const joinableStage =
      currentStage &&
      !activeParticipation &&
      work.reviewStatus === ReviewStatus.normal &&
      actor &&
      canUserWorkStage(
        actor.roles.map(({ role }) => role),
        actor.languageCapabilities.map(({ language }) => language),
        currentStage,
        work.sourceLanguage,
      ) &&
      !violatesSingleSeparation &&
      (work.collaborationMode === WorkCollaborationMode.multi ||
        activeParticipantCount === 0)
        ? currentStage
        : null;
    const assignedImageIds =
      activeParticipation?.assignments.map(({ workImageId }) => workImageId) ??
      [];
    const contributionCurrent = this.contributionCurrent(
      activeParticipation,
      work.images,
    );
    const multiStageReady =
      work.collaborationMode === WorkCollaborationMode.multi && currentStage
        ? await this.multiStageReady(workId, currentStage)
        : false;
    const cancelableSubmissionStage = await this.cancelableSubmissionStage(
      actorId,
      work,
    );
    const skipAvailability = await proofreadSkipAvailability(
      this.db,
      actorId,
      workId,
    );
    return {
      canSkipProofreading: skipAvailability.canSkipProofreading,
      skipProofreadingUnavailableReason:
        skipAvailability.skipProofreadingUnavailableReason,
      reviewRevision: null,
      workId: work.id,
      workNumber: work.workNumber,
      title: work.title,
      sourceLanguage: work.sourceLanguage,
      collaborationMode: work.collaborationMode,
      workflowStatus: work.workflowStatus,
      reviewStatus: work.reviewStatus,
      openReviewCase: work.reviewCases[0]
        ? {
            id: work.reviewCases[0].id,
            reason: work.reviewCases[0].reason,
            openedByName: work.reviewCases[0].openedBy.displayName,
            resolution: work.reviewCases[0].resolution,
            resolutionNote: work.reviewCases[0].resolutionNote,
            createdAt: work.reviewCases[0].createdAt.toISOString(),
          }
        : null,
      workRevision: work.revision,
      editorEpoch: work.editorEpoch,
      typesetHandoffStartedAt:
        work.typesetHandoffStartedAt?.toISOString() ?? null,
      canEdit,
      editStages: participationStages,
      canExportLabelPlus:
        work.reviewStatus === ReviewStatus.normal &&
        (await this.canExportHandoffMaterials(actorId, workId)),
      joinableStage,
      submissionStage:
        submissionStage &&
        activeParticipation &&
        participationStages.includes(submissionStage)
          ? submissionStage
          : null,
      cancelableSubmissionStage,
      assignedImageIds,
      contributionCurrent,
      multiStageReady,
      hasUnsubmittedChanges: latest
        ? this.snapshotDiffers(work.images, latest.entries)
        : work.images.some((image) => image.translationEntries.length > 0),
      revisionStages: [],
      translationAttentionStage: work.translationAttentionStage,
      translationAttentionVersionNumber: work.translationAttentionVersionNumber,
      images: work.images.map((image) => this.imageDto(image)),
      latestVersion: latest
        ? {
            id: latest.id,
            versionNumber: latest.versionNumber,
            kind: latest.kind,
            stage: latest.stage,
            workRevision: latest.workRevision,
            editorEpoch: latest.editorEpoch,
            createdById: latest.createdById,
            createdByName: latest.createdBy.displayName,
            createdAt: latest.createdAt.toISOString(),
          }
        : null,
      activeParticipants: await this.activePresence(workId, currentSessionId),
    };
  }

  async previewLabelPlusImport(
    actorId: string,
    workId: string,
    upload: LabelPlusUpload,
  ): Promise<LabelPlusImportPreviewDto> {
    await this.assertCanImportLabelPlus(actorId, workId);
    const parsed = this.parseLabelPlusUpload(upload);
    const images = await this.labelPlusTargetImages(workId);
    return this.labelPlusPreview(parsed, images);
  }

  async importLabelPlus(
    actorId: string,
    sessionId: string,
    workId: string,
    upload: LabelPlusUpload,
    input: ImportLabelPlusDto,
  ): Promise<TranslationEditorDto> {
    if (
      input.stage !== WorkStage.translate &&
      input.stage !== WorkStage.proofread
    ) {
      throw new BadRequestException("LabelPlus 导入职责必须是翻译或校对");
    }
    await this.assertCanImportLabelPlus(actorId, workId);
    const parsed = this.parseLabelPlusUpload(upload);
    let storedFileId: string | undefined;
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
        );
        const existing = await tx.labelPlusFile.findUnique({
          where: {
            workId_direction_idempotencyKey: {
              workId,
              direction: "import",
              idempotencyKey: input.idempotencyKey,
            },
          },
          select: { id: true },
        });
        if (existing) return;
        if (
          await tx.workEvent.findUnique({
            where: {
              workId_idempotencyKey: {
                workId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            select: { id: true },
          })
        ) {
          throw new ConflictException("幂等键已用于其他作品操作");
        }

        const work = await tx.work.findUnique({
          where: { id: workId },
          select: {
            revision: true,
            editorEpoch: true,
            workflowStatus: true,
            reviewStatus: true,
          },
        });
        if (!work) throw new NotFoundException("作品不存在");
        if (work.reviewStatus !== ReviewStatus.normal) {
          throw new ConflictException(
            "作品存在未解决的审核事项，不能导入正式版本",
          );
        }
        if (
          work.revision !== input.expectedRevision ||
          work.editorEpoch !== input.expectedEditorEpoch
        ) {
          throw new ConflictException(
            "作品状态或正式版本已变化，请重新预览导入",
          );
        }
        const editableWork = await this.lockEditableWork(
          tx,
          actorId,
          workId,
          input.expectedEditorEpoch,
        );
        const participationStages = await this.editParticipationStages(
          tx,
          actorId,
          workId,
        );
        if (!participationStages.includes(input.stage)) {
          throw new ForbiddenException(
            "需要以本人实际参与的翻译或校对职责导入",
          );
        }

        const target = await this.labelPlusTargetImages(workId, tx);
        const images = target.images;
        const preview = this.labelPlusPreview(parsed, target);
        if (!preview.canImport) {
          throw new BadRequestException(preview.blockingIssues);
        }

        const startedWork = await this.startStageForMutation(
          tx,
          actorId,
          editableWork,
        );

        const stored = await this.files.store({
          body: upload.buffer,
          contentType: "text/plain; charset=utf-8",
          bucketScope: "works",
          kind: "labelplus-import",
          sourceName: upload.originalname,
          createdById: actorId,
        });
        storedFileId = stored.id;

        const imageIds = images.map(({ id }) => id);
        await tx.translationEntry.deleteMany({
          where: { workImageId: { in: imageIds } },
        });
        await tx.workImage.updateMany({
          where: { id: { in: imageIds } },
          data: { translationRevision: { increment: 1 } },
        });
        for (const [
          imageIndex,
          sourceImage,
        ] of parsed.document.images.entries()) {
          if (!sourceImage.markers.length) continue;
          await tx.translationEntry.createMany({
            data: sourceImage.markers.map((marker, orderIndex) => ({
              workImageId: images[imageIndex].id,
              orderIndex,
              markerX: normalizeMarkerCoordinate(marker.x),
              markerY: normalizeMarkerCoordinate(marker.y),
              markerPositionType:
                marker.positionType === 1 ? "inside" : "outside",
              translatedText: marker.translation,
              note: null,
              creationIdempotencyKey: randomUUID(),
              createdById: actorId,
              updatedById: actorId,
            })),
          });
        }

        const nextWorkRevision = startedWork.revision + 1;
        const nextEditorEpoch = startedWork.editorEpoch + 1;
        const version = await this.createStageVersion(tx, {
          actorId,
          workId,
          stage: input.stage,
          workRevision: nextWorkRevision,
          editorEpoch: nextEditorEpoch,
          kind: TranslationVersionKind.labelplus_import,
        });
        const hasDownstreamAttention = this.canSubmitRevisionForStage(
          input.stage,
          startedWork.workflowStatus,
        );
        await tx.work.update({
          where: { id: workId },
          data: {
            revision: { increment: 1 },
            editorEpoch: { increment: 1 },
            translationAttentionStage: hasDownstreamAttention
              ? this.attentionStage(startedWork.workflowStatus)
              : null,
            translationAttentionVersionNumber: hasDownstreamAttention
              ? version.versionNumber
              : null,
          },
        });
        await tx.labelPlusFile.create({
          data: {
            workId,
            fileObjectId: stored.id,
            direction: "import",
            formatVersion: parsed.document.formatVersion,
            fileName: this.safeLabelPlusFileName(upload.originalname),
            imageCount: preview.imageCount,
            markerCount: preview.markerCount,
            parseWarnings: parsed.warnings as unknown as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey,
            createdById: actorId,
          },
        });
        await tx.workEvent.create({
          data: {
            workId,
            actorId,
            action: WorkEventAction.translation_imported,
            fromWorkflowStatus: startedWork.workflowStatus,
            toWorkflowStatus: startedWork.workflowStatus,
            idempotencyKey: input.idempotencyKey,
            detail: {
              operation: "labelplus-import",
              stage: input.stage,
              imageCount: preview.imageCount,
              markerCount: preview.markerCount,
              versionNumber: version.versionNumber,
              warningCount: preview.warnings.length,
            },
          },
        });
      });
    } catch (error) {
      if (storedFileId) {
        await this.files.purgeUnreferenced(storedFileId).catch(() => undefined);
      }
      throw error;
    }
    return this.getEditor(actorId, workId, sessionId);
  }

  async exportLabelPlus(
    actorId: string,
    workId: string,
    input: ExportLabelPlusDto,
  ): Promise<LabelPlusExportDto> {
    if (!(await this.canExportHandoffMaterials(actorId, workId))) {
      throw new ForbiddenException("没有导出此作品 LabelPlus 的权限");
    }
    let storedFileId: string | undefined;
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
        );
        const existing = await tx.labelPlusFile.findUnique({
          where: {
            workId_direction_idempotencyKey: {
              workId,
              direction: "export",
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) return this.labelPlusExportDto(existing);

        const work = await tx.work.findUnique({
          where: { id: workId },
          select: {
            workNumber: true,
            revision: true,
            editorEpoch: true,
            workflowStatus: true,
            reviewStatus: true,
            images: {
              orderBy: { orderIndex: "asc" },
              include: {
                originalFileObject: { select: { contentType: true } },
                translationEntries: { orderBy: entryOrder },
              },
            },
          },
        });
        if (!work) throw new NotFoundException("作品不存在");
        assertProductionWritable(work);
        if (
          work.revision !== input.expectedRevision ||
          work.editorEpoch !== input.expectedEditorEpoch
        ) {
          throw new ConflictException(
            "作品状态或正式版本已变化，请刷新后重新导出",
          );
        }

        const document: LabelPlusDocument = {
          formatVersion: "1,0",
          headerLines: [...defaultLabelPlusHeader],
          images: work.images.map((image, index) => ({
            fileName: targetImageFileName(
              work.workNumber,
              index,
              image.originalFileObject.contentType,
            ),
            markers: image.translationEntries.map((entry) => ({
              x: entry.markerX.toNumber(),
              y: entry.markerY.toNumber(),
              positionType: entry.markerPositionType === "inside" ? 1 : 2,
              translation: entry.translatedText,
            })),
          })),
        };
        let body: Uint8Array;
        try {
          body = encodeLabelPlus(document);
        } catch (error) {
          if (error instanceof LabelPlusParseError) {
            throw new BadRequestException(error.message);
          }
          throw error;
        }

        const fileName = this.exportFileName(work.workNumber);
        const stored = await this.files.store({
          body,
          contentType: "text/plain; charset=utf-8",
          bucketScope: "works",
          kind: "labelplus-export",
          sourceName: fileName,
          createdById: actorId,
        });
        storedFileId = stored.id;
        const markerCount = document.images.reduce(
          (count, image) => count + image.markers.length,
          0,
        );
        const record = await tx.labelPlusFile.create({
          data: {
            workId,
            fileObjectId: stored.id,
            direction: "export",
            formatVersion: document.formatVersion,
            fileName,
            imageCount: document.images.length,
            markerCount,
            parseWarnings: [],
            idempotencyKey: input.idempotencyKey,
            createdById: actorId,
          },
        });
        return this.labelPlusExportDto(record);
      });
    } catch (error) {
      if (storedFileId) {
        await this.files.purgeUnreferenced(storedFileId).catch(() => undefined);
      }
      throw error;
    }
  }

  async readLabelPlusFile(actorId: string, workId: string, fileId: string) {
    if (!(await this.canExportHandoffMaterials(actorId, workId))) {
      throw new ForbiddenException("没有下载此作品 LabelPlus 的权限");
    }
    const record = await this.db.labelPlusFile.findFirst({
      where: { id: fileId, workId },
      select: { fileObjectId: true, fileName: true, direction: true },
    });
    if (!record) throw new NotFoundException("LabelPlus 文件不存在");
    const stored = await this.files.read(record.fileObjectId);
    return { fileName: record.fileName, body: stored.body };
  }

  async beginTypesetHandoff(
    actorId: string,
    workId: string,
    detail: TypesetHandoffDetail,
  ) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      const delivered = detail.downloadTaskId
        ? await tx.downloadPreparation.findFirst({
            where: {
              id: detail.downloadTaskId,
              actorId,
              workId,
              purpose: "handoff",
              status: "succeeded",
            },
          })
        : null;
      if (detail.downloadTaskId && !delivered)
        throw new ConflictException("下载任务不存在或尚未完成");
      // The receipt and the authoritative handoff advance in one transaction.
      if (delivered?.deliveredAt) {
        const current = await tx.work.findUniqueOrThrow({
          where: { id: workId },
        });
        await this.beginTypesetHandoffTx(tx, actorId, workId, {
          ...detail,
          expectedRevision: current.revision,
          expectedEditorEpoch: current.editorEpoch,
        });
        return;
      }
      await this.beginTypesetHandoffTx(tx, actorId, workId, detail);
      if (detail.downloadTaskId)
        await tx.downloadPreparation.update({
          where: { id: detail.downloadTaskId },
          data: { deliveredAt: new Date() },
        });
    });
  }

  private async beginTypesetHandoffTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    detail: TypesetHandoffDetail,
  ) {
    const work = await tx.work.findUnique({ where: { id: workId } });
    if (!work) throw new NotFoundException("作品不存在");
    assertProductionWritable(work);
    if (
      (detail.expectedRevision !== undefined &&
        work.revision !== detail.expectedRevision) ||
      (detail.expectedEditorEpoch !== undefined &&
        work.editorEpoch !== detail.expectedEditorEpoch)
    )
      throw new ConflictException("交接期间作品基线已变化，请重新下载最新材料");
    if (detail.requireCurrentParticipation) {
      const eligible = await tx.user.findFirst({
        where: {
          id: actorId,
          isActive: true,
          roles: { some: { role: "typesetter" } },
        },
        select: { id: true },
      });
      const owner = await tx.workStageParticipant.findFirst({
        where: {
          workId,
          userId: actorId,
          stage: WorkStage.typeset,
          leftAt: null,
          submittedAt: null,
        },
        select: { id: true },
      });
      if (!eligible || !owner)
        throw new ForbiddenException("需要具备嵌字职务并认领当前任务");
      if (
        work.reviewStatus !== ReviewStatus.normal ||
        (work.workflowStatus !== WorkflowStatus.pending_typeset &&
          work.workflowStatus !== WorkflowStatus.typesetting)
      ) {
        throw new ConflictException("作品当前不允许批量交接");
      }
      if (
        work.revision !== detail.expectedRevision ||
        work.editorEpoch !== detail.expectedEditorEpoch
      ) {
        throw new ConflictException("交接清单已过期，请重新预览确认");
      }
    }
    if (
      (work.workflowStatus !== WorkflowStatus.pending_typeset &&
        work.workflowStatus !== WorkflowStatus.typesetting) ||
      (work.workflowStatus === WorkflowStatus.typesetting &&
        work.typesetHandoffStartedAt)
    ) {
      return;
    }
    const user = await tx.user.findUnique({
      where: { id: actorId },
      select: { isActive: true, roles: { select: { role: true } } },
    });
    // Management reads may export materials, but only a qualified typesetter
    // can establish the downstream work boundary.
    if (
      !user?.isActive ||
      !canUserWorkStage(
        user.roles.map(({ role }) => role),
        [],
        WorkStage.typeset,
        work.sourceLanguage,
      )
    )
      return;
    const participant = await tx.workStageParticipant.findFirst({
      where: {
        workId,
        userId: actorId,
        stage: WorkStage.typeset,
        submittedAt: null,
        leftAt: null,
      },
      select: { id: true },
    });
    if (!participant) return;
    if (
      (detail.expectedRevision !== undefined &&
        work.revision !== detail.expectedRevision) ||
      (detail.expectedEditorEpoch !== undefined &&
        work.editorEpoch !== detail.expectedEditorEpoch)
    ) {
      throw new ConflictException("交接包对应的作品版本已过期，请重新生成");
    }
    const nextWorkRevision = work.revision + 1;
    const nextEditorEpoch = work.editorEpoch + 1;
    const version = await this.createStageVersionIfChanged(tx, {
      actorId,
      workId,
      stage: WorkStage.proofread,
      workRevision: nextWorkRevision,
      editorEpoch: nextEditorEpoch,
    });
    const changed = await tx.work.updateMany({
      where: {
        id: workId,
        OR: [
          { typesetHandoffStartedAt: null },
          { workflowStatus: WorkflowStatus.pending_typeset },
        ],
      },
      data: {
        typesetHandoffStartedAt: new Date(),
        workflowStatus: WorkflowStatus.typesetting,
        revision: { increment: 1 },
        editorEpoch: { increment: 1 },
      },
    });
    if (!changed.count) return;
    if (work.requiredHandoffVersionId) {
      await tx.translationVersion.update({
        where: { id: work.requiredHandoffVersionId },
        data: { handoffStartedAt: new Date() },
      });
    }
    if (work.proofreadSkippedVersionId) {
      await tx.translationVersion.updateMany({
        where: { id: work.proofreadSkippedVersionId, handoffStartedAt: null },
        data: { handoffStartedAt: new Date() },
      });
    }
    await tx.workEvent.create({
      data: {
        workId,
        actorId,
        action: WorkEventAction.typeset_handoff_started,
        fromWorkflowStatus: work.workflowStatus,
        toWorkflowStatus: WorkflowStatus.typesetting,
        fromReviewStatus: work.reviewStatus,
        toReviewStatus: work.reviewStatus,
        detail: {
          operation: "typeset-handoff-start",
          material: detail.material,
          fileId: detail.fileId,
          participantId: participant.id,
          proofreadVersionId: version?.id ?? null,
          proofreadVersionNumber: version?.versionNumber ?? null,
          editorEpoch: nextEditorEpoch,
        },
      },
    });
  }

  async updatePresence(
    actorId: string,
    sessionId: string,
    workId: string,
    input: UpdateTranslationPresenceDto,
  ): Promise<TranslationPresenceListDto> {
    const work = await this.db.work.findUnique({
      where: { id: workId },
      select: { workflowStatus: true },
    });
    if (!work) throw new NotFoundException("作品不存在");
    if (
      input.mode === TranslationPresenceMode.edit &&
      (work.workflowStatus === WorkflowStatus.archived ||
        !(await this.hasEditParticipation(this.db, actorId, workId)))
    ) {
      throw new ForbiddenException("需要先加入翻译或校对协作才能进入编辑模式");
    }
    const now = new Date();
    await this.db.$transaction([
      this.db.translationEditorPresence.deleteMany({
        where: {
          workId,
          lastSeenAt: {
            lt: new Date(now.getTime() - stalePresenceRetentionMs),
          },
        },
      }),
      this.db.translationEditorPresence.upsert({
        where: { workId_sessionId: { workId, sessionId } },
        create: {
          workId,
          userId: actorId,
          sessionId,
          mode: input.mode,
          lastSeenAt: now,
        },
        update: { userId: actorId, mode: input.mode, lastSeenAt: now },
      }),
    ]);
    return {
      items: await this.activePresence(workId, sessionId, now),
      expiresInSeconds: presenceExpiresInSeconds,
    };
  }

  async leavePresence(
    actorId: string,
    sessionId: string,
    workId: string,
  ): Promise<TranslationPresenceListDto> {
    await this.db.translationEditorPresence.deleteMany({
      where: { workId, sessionId, userId: actorId },
    });
    return {
      items: await this.activePresence(workId, sessionId),
      expiresInSeconds: presenceExpiresInSeconds,
    };
  }

  async createEntry(
    actorId: string,
    imageId: string,
    input: CreateTranslationEntryDto,
  ): Promise<TranslationImageDraftDto> {
    return this.db.$transaction(async (tx) => {
      const workId = await this.getImageWorkId(tx, imageId);
      const work = await this.lockEditableWork(
        tx,
        actorId,
        workId,
        input.expectedEditorEpoch,
      );
      const image = await this.lockImage(tx, imageId);
      const replay = await tx.translationEntry.findUnique({
        where: {
          workImageId_creationIdempotencyKey: {
            workImageId: imageId,
            creationIdempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (replay) {
        if (replay.createdById !== actorId) {
          throw new ConflictException("幂等键已用于其他创建操作");
        }
        const draft = await this.getImageDraft(tx, imageId);
        return { ...draft, mutation: this.mutationMeta(work) };
      }
      if (image.translationRevision !== input.expectedImageRevision) {
        this.imageStale();
      }
      const orderIndex = await tx.translationEntry.count({
        where: { workImageId: imageId },
      });
      const started = await this.startStageForMutation(tx, actorId, work);
      await tx.translationEntry.create({
        data: {
          workImageId: imageId,
          orderIndex,
          markerX: normalizeMarkerCoordinate(input.markerX),
          markerY: normalizeMarkerCoordinate(input.markerY),
          markerPositionType: input.markerPositionType,
          creationIdempotencyKey: input.idempotencyKey,
          createdById: actorId,
          updatedById: actorId,
        },
      });
      await this.incrementImageRevision(
        tx,
        imageId,
        input.expectedImageRevision,
      );
      const draft = await this.getImageDraft(tx, imageId);
      return { ...draft, mutation: this.mutationMeta(started) };
    });
  }

  async updateEntry(
    actorId: string,
    entryId: string,
    input: UpdateTranslationEntryDto,
  ): Promise<TranslationEntryDto> {
    if (
      input.markerX === undefined &&
      input.markerY === undefined &&
      input.markerPositionType === undefined &&
      input.translatedText === undefined &&
      input.note === undefined
    ) {
      throw new BadRequestException("至少提供一项要保存的条目内容");
    }
    return this.db.$transaction(async (tx) => {
      const entryWork = await tx.translationEntry.findUnique({
        where: { id: entryId },
        select: { workImage: { select: { workId: true } } },
      });
      if (!entryWork) throw new NotFoundException("翻译条目不存在");
      const work = await this.lockEditableWork(
        tx,
        actorId,
        entryWork.workImage.workId,
        input.expectedEditorEpoch,
      );
      const entry = await tx.translationEntry.findUnique({
        where: { id: entryId },
      });
      if (!entry) throw new NotFoundException("翻译条目不存在");
      if (entry.revision !== input.expectedRevision) this.entryStale();
      const markerX = normalizeMarkerCoordinate(input.markerX);
      const markerY = normalizeMarkerCoordinate(input.markerY);
      const changesContent =
        (markerX !== undefined && markerX !== Number(entry.markerX)) ||
        (markerY !== undefined && markerY !== Number(entry.markerY)) ||
        (input.markerPositionType !== undefined &&
          input.markerPositionType !== entry.markerPositionType) ||
        (input.translatedText !== undefined &&
          input.translatedText !== entry.translatedText) ||
        (input.note !== undefined && input.note !== entry.note);
      if (!changesContent) {
        const saved = await this.getEntry(tx, entryId);
        return { ...saved, mutation: this.mutationMeta(work) };
      }
      const started = await this.startStageForMutation(tx, actorId, work);
      const changed = await tx.translationEntry.updateMany({
        where: { id: entryId, revision: input.expectedRevision },
        data: {
          markerX,
          markerY,
          markerPositionType: input.markerPositionType,
          translatedText: input.translatedText,
          note: input.note,
          updatedById: actorId,
          revision: { increment: 1 },
        },
      });
      if (!changed.count) this.entryStale();
      const saved = await this.getEntry(tx, entryId);
      return { ...saved, mutation: this.mutationMeta(started) };
    });
  }

  async deleteEntry(
    actorId: string,
    entryId: string,
    input: DeleteTranslationEntryDto,
  ): Promise<TranslationImageDraftDto> {
    return this.db.$transaction(async (tx) => {
      const entry = await tx.translationEntry.findUnique({
        where: { id: entryId },
        select: {
          workImageId: true,
          workImage: { select: { workId: true } },
        },
      });
      if (!entry) throw new NotFoundException("翻译条目不存在");
      const work = await this.lockEditableWork(
        tx,
        actorId,
        entry.workImage.workId,
        input.expectedEditorEpoch,
      );
      const image = await this.lockImage(tx, entry.workImageId);
      if (image.translationRevision !== input.expectedImageRevision) {
        this.imageStale();
      }
      const started = await this.startStageForMutation(tx, actorId, work);
      const removed = await tx.translationEntry.deleteMany({
        where: { id: entryId, revision: input.expectedRevision },
      });
      if (!removed.count) this.entryStale();
      const remaining = await tx.translationEntry.findMany({
        where: { workImageId: entry.workImageId },
        orderBy: entryOrder,
        select: { id: true },
      });
      await this.writeOrder(
        tx,
        entry.workImageId,
        remaining.map((item) => item.id),
      );
      await this.incrementImageRevision(
        tx,
        entry.workImageId,
        input.expectedImageRevision,
      );
      const draft = await this.getImageDraft(tx, entry.workImageId);
      return { ...draft, mutation: this.mutationMeta(started) };
    });
  }

  async reorderEntry(
    actorId: string,
    imageId: string,
    entryId: string,
    input: ReorderTranslationEntryDto,
  ): Promise<TranslationImageDraftDto> {
    return this.db.$transaction(async (tx) => {
      const workId = await this.getImageWorkId(tx, imageId);
      const work = await this.lockEditableWork(
        tx,
        actorId,
        workId,
        input.expectedEditorEpoch,
      );
      const image = await this.lockImage(tx, imageId);
      if (image.translationRevision !== input.expectedImageRevision) {
        this.imageStale();
      }
      const entries = await tx.translationEntry.findMany({
        where: { workImageId: imageId },
        orderBy: entryOrder,
        select: { id: true },
      });
      if (!entries.some((entry) => entry.id === entryId)) {
        throw new NotFoundException("翻译条目不属于此图片");
      }
      const original = entries.map((entry) => entry.id);
      const next = original.filter((id) => id !== entryId);
      if (input.beforeMarkerId === entryId) {
        return this.getImageDraft(tx, imageId);
      }
      if (input.beforeMarkerId == null) {
        next.push(entryId);
      } else {
        const beforeIndex = next.indexOf(input.beforeMarkerId);
        if (beforeIndex < 0) {
          throw new BadRequestException("目标标记不属于此图片");
        }
        next.splice(beforeIndex, 0, entryId);
      }
      if (original.every((id, index) => id === next[index])) {
        return this.getImageDraft(tx, imageId);
      }
      const started = await this.startStageForMutation(tx, actorId, work);
      await this.writeOrder(tx, imageId, next);
      await this.incrementImageRevision(
        tx,
        imageId,
        input.expectedImageRevision,
      );
      const draft = await this.getImageDraft(tx, imageId);
      return { ...draft, mutation: this.mutationMeta(started) };
    });
  }

  private async lockImage(tx: Prisma.TransactionClient, imageId: string) {
    const rows = await tx.$queryRaw<
      { id: string; workId: string; translationRevision: number }[]
    >(Prisma.sql`
      SELECT id, work_id AS "workId", translation_revision AS "translationRevision"
      FROM work_images
      WHERE id = ${imageId}::uuid
      FOR UPDATE
    `);
    const image = rows[0];
    if (!image) throw new NotFoundException("作品图片不存在");
    return image;
  }

  private async getImageWorkId(db: DatabaseClient, imageId: string) {
    const image = await db.workImage.findUnique({
      where: { id: imageId },
      select: { workId: true },
    });
    if (!image) throw new NotFoundException("作品图片不存在");
    return image.workId;
  }

  private async lockEditableWork(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    expectedEditorEpoch: number,
  ): Promise<EditableWorkState> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        revision: number;
        workflowStatus: WorkflowStatus;
        reviewStatus: ReviewStatus;
        editorEpoch: number;
      }[]
    >(
      Prisma.sql`
        SELECT
          id,
          revision,
          workflow_status AS "workflowStatus",
          review_status AS "reviewStatus",
          editor_epoch AS "editorEpoch"
        FROM works
        WHERE id = ${workId}::uuid
        FOR UPDATE
      `,
    );
    if (!rows[0]) throw new NotFoundException("作品不存在");
    if (rows[0].workflowStatus === WorkflowStatus.archived) {
      throw new ConflictException("归档作品不能编辑译文");
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`,
    );
    assertProductionWritable(rows[0]);
    if (rows[0].editorEpoch !== expectedEditorEpoch) {
      throw new ConflictException({
        code: "EDITOR_EPOCH_STALE",
        message: "作品已产生新的正式版本，请重新确认本地草稿",
        currentEditorEpoch: rows[0].editorEpoch,
      });
    }
    const stage = this.currentTextStage(rows[0].workflowStatus);
    if (!stage || !(await this.hasEditParticipation(tx, actorId, workId))) {
      throw new ForbiddenException("需要先加入翻译或校对协作才能编辑");
    }
    return {
      ...rows[0],
      stage,
    };
  }

  private async startStageForMutation(
    tx: Prisma.TransactionClient,
    actorId: string,
    work: EditableWorkState,
  ): Promise<EditableWorkState> {
    if (work.stage === WorkStage.translate) {
      await tx.work.updateMany({
        where: {
          id: work.id,
          NOT: { translationContributorIds: { has: actorId } },
        },
        data: { translationContributorIds: { push: actorId } },
      });
    }
    const isPending =
      work.workflowStatus === WorkflowStatus.pending_translate ||
      work.workflowStatus === WorkflowStatus.pending_proofread;
    if (!isPending) return work;
    const workflowStatus =
      work.stage === WorkStage.translate
        ? WorkflowStatus.translating
        : WorkflowStatus.proofreading;
    const incrementsEpoch = work.stage === WorkStage.proofread;
    const next: EditableWorkState = {
      ...work,
      revision: work.revision + 1,
      workflowStatus,
      editorEpoch: work.editorEpoch + (incrementsEpoch ? 1 : 0),
    };
    const baseline = incrementsEpoch
      ? await this.createStageVersionIfChanged(tx, {
          actorId,
          workId: work.id,
          stage: WorkStage.translate,
          workRevision: next.revision,
          editorEpoch: next.editorEpoch,
        })
      : null;
    const changed = await tx.work.updateMany({
      where: {
        id: work.id,
        revision: work.revision,
        workflowStatus: work.workflowStatus,
        editorEpoch: work.editorEpoch,
      },
      data: {
        workflowStatus,
        revision: { increment: 1 },
        ...(incrementsEpoch ? { editorEpoch: { increment: 1 } } : {}),
      },
    });
    if (!changed.count) {
      throw new ConflictException("作品状态已变化，请刷新后重试");
    }
    await tx.workEvent.create({
      data: {
        workId: work.id,
        actorId,
        action: WorkEventAction.stage_started,
        fromWorkflowStatus: work.workflowStatus,
        toWorkflowStatus: workflowStatus,
        fromReviewStatus: work.reviewStatus,
        toReviewStatus: work.reviewStatus,
        idempotencyKey: randomUUID(),
        detail: {
          operation: "fact-start",
          stage: work.stage,
          ...(baseline
            ? {
                translationBaselineVersionId: baseline.id,
                translationBaselineVersionNumber: baseline.versionNumber,
              }
            : {}),
          editorEpoch: next.editorEpoch,
        },
      },
    });
    return next;
  }

  private mutationMeta(work: EditableWorkState) {
    return {
      workRevision: work.revision,
      editorEpoch: work.editorEpoch,
      workflowStatus: work.workflowStatus,
      submissionStage: this.submittableTextStage(work.workflowStatus),
    };
  }

  async resetDraftForStage(
    tx: Prisma.TransactionClient,
    actorId: string,
    workId: string,
    stage: WorkStage,
  ) {
    const images = await tx.workImage.findMany({
      where: { workId },
      select: { id: true },
    });
    const imageIds = images.map(({ id }) => id);
    await tx.translationEntry.deleteMany({
      where: { workImageId: { in: imageIds } },
    });
    if (stage === WorkStage.proofread) {
      const latest = await tx.translationVersion.findFirst({
        where: { workId, stage: WorkStage.translate },
        orderBy: { versionNumber: "desc" },
        include: { entries: true },
      });
      if (latest?.entries.length) {
        await tx.translationEntry.createMany({
          data: latest.entries.map((entry) => ({
            workImageId: entry.workImageId,
            orderIndex: entry.orderIndex,
            markerX: entry.markerX,
            markerY: entry.markerY,
            markerPositionType: entry.markerPositionType,
            translatedText: entry.translatedText,
            note: entry.note,
            creationIdempotencyKey: randomUUID(),
            createdById: actorId,
            updatedById: actorId,
          })),
        });
      }
    }
    await tx.workImage.updateMany({
      where: { id: { in: imageIds } },
      data: { translationRevision: { increment: 1 } },
    });
  }

  async createSkippedProofreadVersion(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      workId: string;
      sourceVersionId: string;
      workRevision: number;
      editorEpoch: number;
    },
  ) {
    const source = await tx.translationVersion.findUniqueOrThrow({
      where: { id: input.sourceVersionId },
      include: { entries: true },
    });
    if (source.workId !== input.workId || source.stage !== WorkStage.translate)
      throw new ConflictException("来源翻译版本无效");
    const latest = await tx.translationVersion.findFirst({
      where: { workId: input.workId },
      orderBy: { versionNumber: "desc" },
    });
    return tx.translationVersion.create({
      data: {
        workId: input.workId,
        createdById: input.actorId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        kind: TranslationVersionKind.proofread_submission,
        stage: WorkStage.proofread,
        proofreadSkipped: true,
        sourceTranslationVersionId: source.id,
        workRevision: input.workRevision,
        editorEpoch: input.editorEpoch,
        entries: {
          create: source.entries.map(
            ({
              workImageId,
              sourceEntryId,
              orderIndex,
              markerX,
              markerY,
              markerPositionType,
              translatedText,
              note,
            }) => ({
              workImageId,
              sourceEntryId,
              orderIndex,
              markerX,
              markerY,
              markerPositionType,
              translatedText,
              note,
            }),
          ),
        },
      },
    });
  }

  async createStageVersion(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      workId: string;
      stage: WorkStage;
      workRevision: number;
      editorEpoch: number;
      kind?: TranslationVersionKind;
      contributorUserIds?: string[];
      reviewRevisionId?: string;
      sourceTranslationVersionId?: string;
    },
  ) {
    if (
      input.stage !== WorkStage.translate &&
      input.stage !== WorkStage.proofread
    ) {
      throw new BadRequestException("当前阶段不生成译文版本");
    }
    const [latest, proofreadSubmission, images] = await Promise.all([
      tx.translationVersion.findFirst({
        where: { workId: input.workId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      }),
      tx.translationVersion.findFirst({
        where: {
          workId: input.workId,
          kind: TranslationVersionKind.proofread_submission,
        },
        select: { id: true },
      }),
      tx.workImage.findMany({
        where: { workId: input.workId },
        orderBy: { orderIndex: "asc" },
        include: { translationEntries: { orderBy: entryOrder } },
      }),
    ]);
    const kind =
      input.kind ??
      (input.stage === WorkStage.translate
        ? latest
          ? TranslationVersionKind.revision
          : TranslationVersionKind.translate_submission
        : proofreadSubmission
          ? TranslationVersionKind.revision
          : TranslationVersionKind.proofread_submission);
    return tx.translationVersion.create({
      data: {
        workId: input.workId,
        reviewRevisionId: input.reviewRevisionId,
        sourceTranslationVersionId: input.sourceTranslationVersionId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        kind,
        stage: input.stage,
        workRevision: input.workRevision,
        editorEpoch: input.editorEpoch,
        createdById: input.actorId,
        contributorUserIds: input.contributorUserIds ?? [],
        entries: {
          create: images.flatMap((image) =>
            image.translationEntries.map((entry) => ({
              workImageId: image.id,
              sourceEntryId: entry.id,
              orderIndex: entry.orderIndex,
              markerX: entry.markerX,
              markerY: entry.markerY,
              markerPositionType: entry.markerPositionType,
              translatedText: entry.translatedText,
              note: entry.note,
            })),
          ),
        },
      },
      select: { id: true, versionNumber: true, kind: true },
    });
  }

  async createStageVersionIfChanged(
    tx: Prisma.TransactionClient,
    input: {
      actorId: string;
      workId: string;
      stage: WorkStage;
      workRevision: number;
      editorEpoch: number;
    },
  ) {
    const [latestForStage, images] = await Promise.all([
      tx.translationVersion.findFirst({
        where: { workId: input.workId, stage: input.stage },
        orderBy: { versionNumber: "desc" },
        include: { entries: true },
      }),
      tx.workImage.findMany({
        where: { workId: input.workId },
        orderBy: { orderIndex: "asc" },
        include: { translationEntries: { orderBy: entryOrder } },
      }),
    ]);
    if (
      latestForStage &&
      !this.snapshotDiffers(images, latestForStage.entries)
    ) {
      return null;
    }
    return this.createStageVersion(tx, input);
  }

  private parseLabelPlusUpload(upload: LabelPlusUpload): LabelPlusParseResult {
    if (!upload?.buffer || upload.size < 1) {
      throw new BadRequestException("请选择非空的 LabelPlus 文件");
    }
    try {
      return parseLabelPlus(upload.buffer);
    } catch (error) {
      if (error instanceof LabelPlusParseError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async labelPlusTargetImages(
    workId: string,
    db: DatabaseClient = this.db,
  ) {
    const work = await db.work.findUnique({
      where: { id: workId },
      select: { id: true, workNumber: true },
    });
    if (!work) throw new NotFoundException("作品不存在");
    const images = await db.workImage.findMany({
      where: { workId },
      orderBy: { orderIndex: "asc" },
      select: {
        id: true,
        orderIndex: true,
        originalFileObject: { select: { contentType: true } },
      },
    });
    return { workNumber: work.workNumber, images };
  }

  private labelPlusPreview(
    parsed: LabelPlusParseResult,
    target: {
      workNumber: number;
      images: {
        id: string;
        orderIndex: number;
        originalFileObject: { contentType: string };
      }[];
    },
  ): LabelPlusImportPreviewDto {
    const { images, workNumber } = target;
    const blockingIssues: string[] = [];
    if (parsed.document.images.length !== images.length) {
      blockingIssues.push(
        `文件包含 ${parsed.document.images.length} 个图片章节，作品包含 ${images.length} 张图片；请调整为一一对应后重新选择文件。`,
      );
    }
    if (parsed.warnings.some(({ code }) => code === "duplicate_image_name")) {
      blockingIssues.push("图片章节名存在重复，无法确认唯一映射。");
    }
    if (
      parsed.warnings.some(({ code }) => code === "unsupported_position_type")
    ) {
      blockingIssues.push("文件包含暂不支持的标记类型，请改为框内或框外。");
    }
    return {
      formatVersion: parsed.document.formatVersion,
      imageCount: parsed.document.images.length,
      markerCount: parsed.document.images.reduce(
        (count, image) => count + image.markers.length,
        0,
      ),
      mappings: parsed.document.images
        .slice(0, images.length)
        .map((sourceImage, index) => ({
          sourceFileName: sourceImage.fileName,
          targetImageId: images[index].id,
          targetFileName: targetImageFileName(
            workNumber,
            index,
            images[index].originalFileObject.contentType,
          ),
          markerCount: sourceImage.markers.length,
        })),
      warnings: parsed.warnings,
      blockingIssues,
      canImport: blockingIssues.length === 0,
    };
  }

  private safeLabelPlusFileName(sourceName: string) {
    const name = sourceName.split(/[\\/]/).at(-1)?.trim() || "labelplus.txt";
    return name.slice(0, 255);
  }

  private exportFileName(workNumber: number) {
    return `${workNumber}_翻译.txt`;
  }

  private labelPlusExportDto(record: {
    id: string;
    fileName: string;
    formatVersion: string;
    imageCount: number;
    markerCount: number;
    createdAt: Date;
    workId: string;
  }): LabelPlusExportDto {
    return {
      fileId: record.id,
      fileName: record.fileName,
      downloadUrl: `/api/works/${record.workId}/labelplus/files/${record.id}`,
      formatVersion: record.formatVersion,
      imageCount: record.imageCount,
      markerCount: record.markerCount,
      createdAt: record.createdAt.toISOString(),
    };
  }

  async canExportHandoffMaterials(actorId: string, workId: string) {
    const user = await this.db.user.findUnique({
      where: { id: actorId },
      select: {
        roles: { select: { role: true } },
        workParticipations: {
          where: { workId },
          select: { stage: true },
        },
      },
    });
    if (!user) return false;
    const roles = new Set(user.roles.map(({ role }) => role));
    if (
      roles.has(Role.admin) ||
      roles.has(Role.source) ||
      roles.has(Role.reviewer)
    ) {
      return true;
    }
    const stages = new Set(user.workParticipations.map(({ stage }) => stage));
    return (
      (roles.has(Role.translator) && stages.has(WorkStage.translate)) ||
      (roles.has(Role.proofreader) && stages.has(WorkStage.proofread)) ||
      (roles.has(Role.typesetter) && stages.has(WorkStage.typeset))
    );
  }

  async assertCanExportHandoffMaterials(actorId: string, workId: string) {
    if (!(await this.canExportHandoffMaterials(actorId, workId))) {
      throw new ForbiddenException("没有导出此作品交接材料的权限");
    }
  }

  private async assertCanImportLabelPlus(actorId: string, workId: string) {
    const [work, user] = await Promise.all([
      this.db.work.findUnique({
        where: { id: workId },
        select: {
          collaborationMode: true,
          workflowStatus: true,
          reviewStatus: true,
        },
      }),
      this.db.user.findUnique({
        where: { id: actorId },
        select: { roles: { select: { role: true } } },
      }),
    ]);
    if (!work) throw new NotFoundException("作品不存在");
    assertProductionWritable(work);
    if (!(await this.hasEditParticipation(this.db, actorId, workId))) {
      throw new ForbiddenException("需要先加入当前翻译或校对阶段才能导入");
    }
    if (
      work.collaborationMode === WorkCollaborationMode.multi &&
      !user?.roles.some(({ role }) => role === Role.admin)
    ) {
      throw new ForbiddenException("多人协作中的整份 LabelPlus 导入仅限管理员");
    }
  }

  private async hasEditParticipation(
    db: DatabaseClient,
    actorId: string,
    workId: string,
  ) {
    return (await this.editParticipationStages(db, actorId, workId)).length > 0;
  }

  private async editParticipationStages(
    db: DatabaseClient,
    actorId: string,
    workId: string,
  ): Promise<WorkStage[]> {
    const [user, work] = await Promise.all([
      db.user.findUnique({
        where: { id: actorId },
        select: {
          roles: { select: { role: true } },
          languageCapabilities: { select: { language: true } },
        },
      }),
      db.work.findUnique({
        where: { id: workId },
        select: {
          workflowStatus: true,
          reviewStatus: true,
          sourceLanguage: true,
          typesetHandoffStartedAt: true,
        },
      }),
    ]);
    if (!user || !work || work.reviewStatus !== ReviewStatus.normal) return [];
    const participationStage = this.currentTextStage(work.workflowStatus);
    if (!participationStage) return [];
    const participations = await db.workStageParticipant.findMany({
      where: {
        workId,
        userId: actorId,
        stage: participationStage,
        submittedAt: null,
        leftAt: null,
      },
      select: { stage: true },
    });
    return participations
      .filter(({ stage }) =>
        canUserWorkStage(
          user.roles.map(({ role }) => role),
          user.languageCapabilities.map(({ language }) => language),
          stage,
          work.sourceLanguage,
        ),
      )
      .map(({ stage }) => stage);
  }

  private contributionCurrent(
    participant: {
      assignments: { workImageId: string }[];
      contributionSubmissions: {
        pages: { workImageId: string; imageRevision: number }[];
      }[];
    } | null,
    images: { id: string; translationRevision: number }[],
  ) {
    const submission = participant?.contributionSubmissions[0];
    return Boolean(
      participant &&
      submission &&
      participant.assignments.length > 0 &&
      participant.assignments.every(({ workImageId }) =>
        submission.pages.some(
          (page) =>
            page.workImageId === workImageId &&
            page.imageRevision ===
              images.find(({ id }) => id === workImageId)?.translationRevision,
        ),
      ),
    );
  }

  private async multiStageReady(workId: string, stage: WorkStage) {
    const [images, participants] = await Promise.all([
      this.db.workImage.findMany({
        where: { workId },
        select: { id: true, translationRevision: true },
      }),
      this.db.workStageParticipant.findMany({
        where: { workId, stage, submittedAt: null, leftAt: null },
        include: {
          assignments: true,
          contributionSubmissions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { pages: true },
          },
        },
      }),
    ]);
    const current = participants.filter((participant) =>
      this.contributionCurrent(participant, images),
    );
    return (
      images.length > 0 &&
      images.every((image) =>
        current.some((participant) =>
          participant.assignments.some(
            ({ workImageId }) => workImageId === image.id,
          ),
        ),
      )
    );
  }

  private async activePresence(
    workId: string,
    currentSessionId?: string,
    now = new Date(),
  ) {
    const cutoff = new Date(now.getTime() - presenceExpiresInSeconds * 1000);
    const rows = await this.db.translationEditorPresence.findMany({
      where: {
        workId,
        lastSeenAt: { gte: cutoff },
        session: { revokedAt: null, expiresAt: { gt: now } },
        user: { isActive: true },
      },
      include: {
        user: {
          select: {
            displayName: true,
            workParticipations: {
              where: {
                workId,
                stage: { in: [WorkStage.translate, WorkStage.proofread] },
                submittedAt: null,
                leftAt: null,
              },
              select: { stage: true },
            },
          },
        },
      },
      orderBy: [{ mode: "desc" }, { lastSeenAt: "desc" }],
    });
    return rows.map((row) => ({
      userId: row.userId,
      displayName: row.user.displayName,
      mode: row.mode,
      stages: [
        ...new Set(row.user.workParticipations.map(({ stage }) => stage)),
      ],
      isCurrentSession: row.sessionId === currentSessionId,
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  }

  private submittableTextStage(
    workflowStatus: WorkflowStatus,
  ): WorkStage | null {
    const stage = this.currentTextStage(workflowStatus);
    return stage && canSubmitWorkStage(stage, workflowStatus) ? stage : null;
  }

  private currentTextStage(workflowStatus: WorkflowStatus): WorkStage | null {
    if (
      workflowStatus === WorkflowStatus.pending_translate ||
      workflowStatus === WorkflowStatus.translating
    ) {
      return WorkStage.translate;
    }
    if (
      workflowStatus === WorkflowStatus.pending_proofread ||
      workflowStatus === WorkflowStatus.proofreading
    ) {
      return WorkStage.proofread;
    }
    return null;
  }

  private async cancelableSubmissionStage(
    actorId: string,
    work: {
      id: string;
      workflowStatus: WorkflowStatus;
      typesetHandoffStartedAt: Date | null;
      proofreadSkippedVersionId: string | null;
      proofreadSkippedVersion: { handoffStartedAt: Date | null } | null;
    },
  ): Promise<WorkStage | null> {
    const stage =
      work.workflowStatus === WorkflowStatus.pending_proofread
        ? WorkStage.translate
        : work.workflowStatus === WorkflowStatus.pending_typeset &&
            !work.typesetHandoffStartedAt
          ? work.proofreadSkippedVersionId
            ? work.proofreadSkippedVersion?.handoffStartedAt
              ? null
              : WorkStage.translate
            : WorkStage.proofread
          : null;
    if (!stage) return null;
    const participant = await this.db.workStageParticipant.findFirst({
      where: {
        workId: work.id,
        userId: actorId,
        stage,
        submittedAt: { not: null },
        leftAt: null,
      },
      select: { id: true },
    });
    return participant ? stage : null;
  }

  private canSubmitRevisionForStage(
    stage: WorkStage,
    workflowStatus: WorkflowStatus,
  ) {
    const translateTargets = new Set<WorkflowStatus>([
      WorkflowStatus.pending_proofread,
      WorkflowStatus.proofreading,
      WorkflowStatus.pending_typeset,
      WorkflowStatus.typesetting,
      WorkflowStatus.pending_publish,
      WorkflowStatus.published,
    ]);
    const proofreadTargets = new Set<WorkflowStatus>([
      WorkflowStatus.pending_typeset,
      WorkflowStatus.typesetting,
      WorkflowStatus.pending_publish,
      WorkflowStatus.published,
    ]);
    return stage === WorkStage.translate
      ? translateTargets.has(workflowStatus)
      : stage === WorkStage.proofread && proofreadTargets.has(workflowStatus);
  }

  private attentionStage(workflowStatus: WorkflowStatus): WorkStage {
    if (
      workflowStatus === WorkflowStatus.pending_proofread ||
      workflowStatus === WorkflowStatus.proofreading
    ) {
      return WorkStage.proofread;
    }
    if (
      workflowStatus === WorkflowStatus.pending_typeset ||
      workflowStatus === WorkflowStatus.typesetting
    ) {
      return WorkStage.typeset;
    }
    return WorkStage.publish;
  }

  private snapshotDiffers(
    images: {
      id: string;
      translationEntries: TranslationEntryRow[];
    }[],
    versionEntries: {
      workImageId: string;
      orderIndex: number;
      markerX: Prisma.Decimal;
      markerY: Prisma.Decimal;
      markerPositionType: string;
      translatedText: string;
      note: string | null;
    }[],
  ) {
    const current = images.flatMap((image) =>
      image.translationEntries.map((entry) => ({
        ...entry,
        workImageId: image.id,
      })),
    );
    if (current.length !== versionEntries.length) return true;
    const snapshots = new Map(
      versionEntries.map((entry) => [
        `${entry.workImageId}:${entry.orderIndex}`,
        entry,
      ]),
    );
    return current.some((entry) => {
      const saved = snapshots.get(`${entry.workImageId}:${entry.orderIndex}`);
      return (
        !saved ||
        !entry.markerX.equals(saved.markerX) ||
        !entry.markerY.equals(saved.markerY) ||
        entry.markerPositionType !== saved.markerPositionType ||
        entry.translatedText !== saved.translatedText ||
        entry.note !== saved.note
      );
    });
  }

  private async incrementImageRevision(
    tx: Prisma.TransactionClient,
    imageId: string,
    expectedRevision: number,
  ) {
    const changed = await tx.workImage.updateMany({
      where: { id: imageId, translationRevision: expectedRevision },
      data: { translationRevision: { increment: 1 } },
    });
    if (!changed.count) this.imageStale();
  }

  private async writeOrder(
    tx: Prisma.TransactionClient,
    imageId: string,
    orderedIds: string[],
  ) {
    await tx.translationEntry.updateMany({
      where: { workImageId: imageId },
      data: { orderIndex: { increment: 1_000_000 } },
    });
    for (const [orderIndex, id] of orderedIds.entries()) {
      await tx.translationEntry.update({
        where: { id },
        data: { orderIndex },
      });
    }
  }

  private async getEntry(db: DatabaseClient, entryId: string) {
    const entry = await db.translationEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry) throw new NotFoundException("翻译条目不存在");
    return this.entryDto(entry);
  }

  private async getImageDraft(db: DatabaseClient, imageId: string) {
    const image = await db.workImage.findUnique({
      where: { id: imageId },
      include: { translationEntries: { orderBy: entryOrder } },
    });
    if (!image) throw new NotFoundException("作品图片不存在");
    return this.imageDto(image);
  }

  private imageDto(image: {
    id: string;
    orderIndex: number;
    width: number | null;
    height: number | null;
    translationRevision: number;
    translationEntries: TranslationEntryRow[];
  }): TranslationImageDraftDto {
    return {
      id: image.id,
      orderIndex: image.orderIndex,
      width: image.width,
      height: image.height,
      translationRevision: image.translationRevision,
      entries: image.translationEntries.map((entry) => this.entryDto(entry)),
    };
  }

  private entryDto(entry: TranslationEntryRow): TranslationEntryDto {
    return {
      id: entry.id,
      workImageId: entry.workImageId,
      orderIndex: entry.orderIndex,
      markerX: entry.markerX.toNumber(),
      markerY: entry.markerY.toNumber(),
      markerPositionType: entry.markerPositionType,
      translatedText: entry.translatedText,
      note: entry.note,
      revision: entry.revision,
      createdById: entry.createdById,
      updatedById: entry.updatedById,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    };
  }

  private imageStale(): never {
    throw new ConflictException("图片标记顺序已更新，请刷新后重试");
  }

  private entryStale(): never {
    throw new ConflictException("翻译条目已更新，请比较服务端内容后重试");
  }
}
