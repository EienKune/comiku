import { DirectUploadsService } from "../transfers/direct-uploads.service.js";
import { DownloadsService } from "../transfers/downloads.service.js";
import { assertCurrentHandoff } from "../workflow/revision-policy.js";
import { assertProductionWritable } from "../workflow/review-policy.js";
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
  Prisma,
  ReviewCaseStatus,
  ReviewResolution,
  Role,
  ReviewStatus,
  WorkEventAction,
  WorkStage,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { TranslationsService } from "../translations/translations.service.js";
import {
  createTypesetHandoffArchive,
  targetImageFileName,
  typesetHandoffPackageFileName,
} from "./handoff-package.js";
import {
  defaultLabelPlusHeader,
  encodeLabelPlus,
  LabelPlusParseError,
  type LabelPlusDocument,
} from "../labelplus/labelplus-codec.js";
import type {
  CreateTypesetHandoffPackageDto,
  CreateTypesetVersionDto,
  DeleteTypesetVersionDto,
  ManageTypesetVersionDto,
  TypesetHandoffPackageDto,
  TypesetVersionDto,
  TypesetVersionListDto,
} from "./typesetting.dto.js";
import { TypesetVersionUploadMode } from "./typesetting.dto.js";
import { prepareTypesetImages } from "./typeset-image-upload.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";
import type { TypesetHandoffManifestDto } from "./typeset-batch.dto.js";

const typesetVersionRetentionMs = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class TypesettingService {
  onModuleInit() {
    this.directUploads?.register("typeset_single", (session, files) => {
      const options = session.options as {
        mode: TypesetVersionUploadMode;
        note: string | null;
        sourceImageIds: string;
      };
      return this.createVersion(
        session.actorId,
        session.resourceId,
        files,
        {
          expectedRevision: session.expectedRevision,
          idempotencyKey: session.id,
          mode: options.mode,
          note: options.note ?? undefined,
          sourceImageIds: options.sourceImageIds || undefined,
        },
        session.id,
      );
    });
    this.downloads?.register("handoff", {
      prepare: async (task, signal) => {
        signal.throwIfAborted();
        const pack = await (
          task.requireCurrentParticipation
            ? this.prepareBatchHandoff.bind(this)
            : this.createHandoffPackage.bind(this)
        )(task.actorId, task.workId, {
          expectedRevision: task.expectedRevision,
          expectedEditorEpoch: task.expectedEditorEpoch,
          idempotencyKey: task.idempotencyKey,
        });
        const record = await this.db.typesetHandoffPackage.findUniqueOrThrow({
          where: { id: pack.packageId },
        });
        return {
          fileObjectId: record.fileObjectId,
          packageId: record.id,
          fileName: record.fileName,
        };
      },
      deliver: (task) =>
        this.handoffDownloadUrl(
          task.actorId,
          task.workId,
          task.packageId!,
          {
            expectedRevision: task.expectedRevision,
            expectedEditorEpoch: task.expectedEditorEpoch,
          },
          task.id,
          task.requireCurrentParticipation,
        ),
    });
  }

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(TranslationsService)
    private readonly translations: TranslationsService,
    @Optional()
    @Inject(DirectUploadsService)
    private readonly directUploads?: DirectUploadsService,
    @Optional()
    @Inject(DownloadsService)
    private readonly downloads?: DownloadsService,
  ) {}

  async handoffManifest(actorId: string): Promise<TypesetHandoffManifestDto> {
    const actor = await this.db.user.findFirst({
      where: {
        id: actorId,
        isActive: true,
        roles: { some: { role: Role.typesetter } },
      },
      select: { id: true },
    });
    if (!actor) throw new ForbiddenException("需要具备嵌字职务");
    const works = await this.db.work.findMany({
      where: {
        workflowStatus: {
          in: [WorkflowStatus.pending_typeset, WorkflowStatus.typesetting],
        },
        stageParticipants: {
          some: {
            userId: actorId,
            stage: WorkStage.typeset,
            leftAt: null,
            submittedAt: null,
          },
        },
      },
      select: {
        id: true,
        workNumber: true,
        title: true,
        revision: true,
        editorEpoch: true,
        reviewStatus: true,
        _count: { select: { images: true } },
      },
      orderBy: { workNumber: "desc" },
    });
    return {
      items: works.map((work) => ({
        workId: work.id,
        workNumber: work.workNumber,
        title: work.title,
        workRevision: work.revision,
        editorEpoch: work.editorEpoch,
        imageCount: work._count.images,
        canDownload:
          work.reviewStatus === ReviewStatus.normal && work._count.images > 0,
        unavailableReason:
          work.reviewStatus !== ReviewStatus.normal
            ? "审核中或阻塞，暂不可交接"
            : work._count.images === 0
              ? "作品没有原图"
              : null,
      })),
    };
  }

  async prepareBatchHandoff(
    actorId: string,
    workId: string,
    input: CreateTypesetHandoffPackageDto,
  ) {
    await this.assertBatchHandoff(actorId, workId, input);
    return this.createHandoffPackage(actorId, workId, input);
  }

  private async assertBatchHandoff(
    actorId: string,
    workId: string,
    input: Pick<
      CreateTypesetHandoffPackageDto,
      "expectedRevision" | "expectedEditorEpoch"
    >,
  ) {
    const actor = await this.db.user.findFirst({
      where: {
        id: actorId,
        isActive: true,
        roles: { some: { role: Role.typesetter } },
      },
      select: { id: true },
    });
    const work = await this.db.work.findFirst({
      where: {
        id: workId,
        workflowStatus: {
          in: [WorkflowStatus.pending_typeset, WorkflowStatus.typesetting],
        },
        stageParticipants: {
          some: {
            userId: actorId,
            stage: WorkStage.typeset,
            leftAt: null,
            submittedAt: null,
          },
        },
      },
      select: {
        revision: true,
        editorEpoch: true,
        reviewStatus: true,
        _count: { select: { images: true } },
      },
    });
    if (!actor || !work)
      throw new ForbiddenException("需要具备嵌字职务并认领当前待办");
    if (work.reviewStatus !== ReviewStatus.normal || !work._count.images)
      throw new ConflictException("审核中、阻塞或没有原图，当前不能交接");
    if (
      work.revision !== input.expectedRevision ||
      work.editorEpoch !== input.expectedEditorEpoch
    ) {
      throw new ConflictException("交接清单已过期，请重新预览确认");
    }
  }

  async createHandoffPackage(
    actorId: string,
    workId: string,
    input: CreateTypesetHandoffPackageDto,
  ): Promise<TypesetHandoffPackageDto> {
    await this.translations.assertCanExportHandoffMaterials(actorId, workId);
    const production = await this.db.work.findUnique({ where: { id: workId } });
    if (!production) throw new NotFoundException("作品不存在");
    assertProductionWritable(production);
    const replay = await this.db.typesetHandoffPackage.findUnique({
      where: {
        workId_kind_idempotencyKey: {
          workId,
          kind: "unified_handoff",
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (replay) {
      if (!(await this.files.exists(replay.fileObjectId)))
        throw new ConflictException("交接包文件已失效，请重新生成");
      return this.packageDto(replay);
    }
    const cached = await this.db.typesetHandoffPackage.findFirst({
      where: {
        workId,
        kind: "unified_handoff",
        workRevision: input.expectedRevision,
        editorEpoch: input.expectedEditorEpoch,
        createdAt: { gt: new Date(Date.now() - 24 * 60 * 60_000) },
        fileObject: { lifecycleStatus: "active", deletedAt: null },
      },
      orderBy: { createdAt: "desc" },
    });
    if (cached && (await this.files.exists(cached.fileObjectId)))
      return this.packageDto(cached);

    const work = await this.db.work.findUnique({
      where: { id: workId },
      select: {
        workNumber: true,
        title: true,
        revision: true,
        editorEpoch: true,
        requiredHandoffVersionId: true,
        workflowStatus: true,
        images: {
          orderBy: { orderIndex: "asc" },
          select: {
            originalFileObjectId: true,
            originalFileObject: { select: { contentType: true } },
            translationEntries: { orderBy: { orderIndex: "asc" } },
          },
        },
      },
    });
    if (!work) throw new NotFoundException("作品不存在");
    if (
      work.workflowStatus !== WorkflowStatus.pending_typeset &&
      work.workflowStatus !== WorkflowStatus.typesetting
    ) {
      throw new ConflictException("作品当前不在嵌字交接阶段");
    }
    if (
      work.revision !== input.expectedRevision ||
      work.editorEpoch !== input.expectedEditorEpoch
    ) {
      throw new ConflictException("作品状态或正式版本已变化，请刷新后重新导出");
    }
    if (!work.images.length)
      throw new ConflictException("作品没有可导出的原图");

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
    let translationBody: Uint8Array;
    try {
      translationBody = encodeLabelPlus(document);
    } catch (error) {
      if (error instanceof LabelPlusParseError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const markerCount = document.images.reduce(
      (count, image) => count + image.markers.length,
      0,
    );
    const archive = await createTypesetHandoffArchive(
      (async function* (files: FileObjectsService) {
        for (const image of work.images) {
          const stored = await files.readStream(image.originalFileObjectId);
          yield {
            contentType: image.originalFileObject.contentType,
            body: stored.body,
          };
        }
      })(this.files),
      work.workNumber,
      translationBody,
    );
    const fileName = typesetHandoffPackageFileName(work.workNumber);
    let stored: Awaited<ReturnType<FileObjectsService["storePath"]>>;
    try {
      stored = await this.files.storePath({
        path: archive.path,
        contentType: "application/zip",
        bucketScope: "works",
        kind: "typeset-handoff-package",
        sourceName: fileName,
        createdById: actorId,
      });
    } finally {
      await archive.cleanup();
    }
    let storedFileLinked = false;
    try {
      const record = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
        );
        const existing = await tx.typesetHandoffPackage.findUnique({
          where: {
            workId_kind_idempotencyKey: {
              workId,
              kind: "unified_handoff",
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) return existing;
        const current = await tx.work.findUnique({ where: { id: workId } });
        if (!current) throw new NotFoundException("作品不存在");
        assertProductionWritable(current);
        if (
          current.revision !== input.expectedRevision ||
          current.editorEpoch !== input.expectedEditorEpoch
        ) {
          throw new ConflictException(
            "作品状态或正式版本已变化，请刷新后重新导出",
          );
        }
        return tx.typesetHandoffPackage.create({
          data: {
            workId,
            fileObjectId: stored.id,
            kind: "unified_handoff",
            fileName,
            imageCount: work.images.length,
            markerCount,
            workRevision: current.revision,
            editorEpoch: current.editorEpoch,
            translationVersionId:
              current.requiredHandoffVersionId ??
              (
                await tx.translationVersion.findFirst({
                  where: { workId },
                  orderBy: { versionNumber: "desc" },
                  select: { id: true },
                })
              )?.id,
            idempotencyKey: input.idempotencyKey,
            createdById: actorId,
          },
        });
      });
      storedFileLinked = record.fileObjectId === stored.id;
      if (!storedFileLinked) {
        await this.files.purgeUnreferenced(stored.id);
      }
      return this.packageDto(record);
    } catch (error) {
      if (!storedFileLinked) {
        await this.files.purgeUnreferenced(stored.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async authorizeHandoffPackage(
    actorId: string,
    workId: string,
    packageId: string,
    batchBaseline?: Pick<
      CreateTypesetHandoffPackageDto,
      "expectedRevision" | "expectedEditorEpoch"
    >,
  ) {
    await this.translations.assertCanExportHandoffMaterials(actorId, workId);
    const production = await this.db.work.findUnique({ where: { id: workId } });
    if (!production) throw new NotFoundException("作品不存在");
    assertProductionWritable(production);
    if (batchBaseline)
      await this.assertBatchHandoff(actorId, workId, batchBaseline);
    const record = await this.db.typesetHandoffPackage.findFirst({
      where: { id: packageId, workId, kind: "unified_handoff" },
      select: {
        id: true,
        fileObjectId: true,
        fileName: true,
        workRevision: true,
        editorEpoch: true,
        translationVersionId: true,
      },
    });
    if (!record) throw new NotFoundException("嵌字交接包不存在");
    const work = await this.db.work.findUnique({
      where: { id: workId },
      select: {
        revision: true,
        editorEpoch: true,
        typesetHandoffStartedAt: true,
        requiredHandoffVersionId: true,
      },
    });
    if (!work) throw new NotFoundException("作品不存在");
    if (
      work.requiredHandoffVersionId &&
      record.translationVersionId !== work.requiredHandoffVersionId
    )
      throw new ConflictException("交接包使用旧文本，请重新生成最新材料");
    const matchesPendingBaseline =
      !work.typesetHandoffStartedAt &&
      work.revision === record.workRevision &&
      work.editorEpoch === record.editorEpoch;
    const matchesStartedBaseline =
      Boolean(work.typesetHandoffStartedAt) &&
      (work.editorEpoch === record.editorEpoch + 1 ||
        work.editorEpoch === record.editorEpoch);
    // A review switches epochs without invalidating an already downloaded package.
    // Keep strict checks for unused packages and for packages containing old text.
    let matchesPreservedHandoff = false;
    if (
      !matchesStartedBaseline &&
      work.typesetHandoffStartedAt &&
      record.translationVersionId
    ) {
      const latest = await this.db.translationVersion.findFirst({
        where: { workId },
        orderBy: { versionNumber: "desc" },
        select: { id: true },
      });
      matchesPreservedHandoff =
        latest?.id === record.translationVersionId &&
        Boolean(
          await this.db.workEvent.findFirst({
            where: {
              workId,
              action: WorkEventAction.typeset_handoff_started,
              detail: { path: ["fileId"], equals: record.id },
            },
            select: { id: true },
          }),
        );
    }
    if (
      !matchesPendingBaseline &&
      !matchesStartedBaseline &&
      !matchesPreservedHandoff
    ) {
      throw new ConflictException("交接包对应的作品版本已过期，请重新生成");
    }
    return { record, work };
  }

  async readHandoffPackage(
    actorId: string,
    workId: string,
    packageId: string,
    baseline?: Pick<
      CreateTypesetHandoffPackageDto,
      "expectedRevision" | "expectedEditorEpoch"
    >,
  ) {
    const { record, work } = await this.authorizeHandoffPackage(
      actorId,
      workId,
      packageId,
      baseline,
    );
    const stored = await this.files.read(record.fileObjectId);
    await this.translations.beginTypesetHandoff(actorId, workId, {
      material: "unified_handoff",
      fileId: record.id,
      expectedRevision: baseline?.expectedRevision ?? work.revision,
      expectedEditorEpoch: baseline?.expectedEditorEpoch ?? work.editorEpoch,
      requireCurrentParticipation: Boolean(baseline),
    });
    return { fileName: record.fileName, body: stored.body };
  }

  async handoffDownloadUrl(
    actorId: string,
    workId: string,
    packageId: string,
    baseline?: Pick<
      CreateTypesetHandoffPackageDto,
      "expectedRevision" | "expectedEditorEpoch"
    >,
    downloadTaskId?: string,
    requireCurrentParticipation = true,
  ) {
    const delivered = downloadTaskId
      ? await this.db.downloadPreparation.findFirst({
          where: { id: downloadTaskId, actorId, workId, packageId },
        })
      : null;
    if (delivered?.deliveredAt) {
      const current = await this.db.work.findUniqueOrThrow({
        where: { id: workId },
      });
      baseline = {
        expectedRevision: current.revision,
        expectedEditorEpoch: current.editorEpoch,
      };
    }
    const { record, work } = await this.authorizeHandoffPackage(
      actorId,
      workId,
      packageId,
      requireCurrentParticipation ? baseline : undefined,
    );
    // Signing must succeed before the existing authoritative handoff boundary advances.
    const signed = await this.files.signedDownloadUrl(
      record.fileObjectId,
      record.fileName,
    );
    await this.translations.beginTypesetHandoff(actorId, workId, {
      downloadTaskId,
      material: "unified_handoff",
      fileId: record.id,
      expectedRevision: baseline?.expectedRevision ?? work.revision,
      expectedEditorEpoch: baseline?.expectedEditorEpoch ?? work.editorEpoch,
      requireCurrentParticipation:
        requireCurrentParticipation && Boolean(baseline),
    });
    return { ...signed, fileName: record.fileName };
  }

  async listVersions(workId: string): Promise<TypesetVersionListDto> {
    const work = await this.db.work.findUnique({
      where: { id: workId },
      select: {
        revision: true,
        currentTypesetVersionId: true,
        requiredHandoffVersionId: true,
        typesetVersions: {
          orderBy: { versionNumber: "desc" },
          include: {
            uploadedBy: { select: { displayName: true } },
            images: { orderBy: { orderIndex: "asc" } },
          },
        },
      },
    });
    if (!work) throw new NotFoundException("作品不存在");
    return {
      items: work.typesetVersions.map((version) =>
        this.versionDto(
          version,
          work.currentTypesetVersionId,
          work.requiredHandoffVersionId,
        ),
      ),
      currentVersionId: work.currentTypesetVersionId,
      workRevision: work.revision,
    };
  }

  // Called only inside the upload session's transaction after its authoritative
  // participant, review, handoff and frozen-baseline checks under the work lock.
  async createStagedVersionTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    work: {
      id: string;
      workflowStatus: WorkflowStatus;
      reviewStatus: ReviewStatus;
    },
    idempotencyKey: string,
    images: {
      fileObjectId: string;
      sourceName: string;
      width: number;
      height: number;
    }[],
  ) {
    const replay = await tx.typesetImageVersion.findUnique({
      where: { workId_idempotencyKey: { workId: work.id, idempotencyKey } },
    });
    if (replay) return replay.id;
    const latest = await tx.typesetImageVersion.aggregate({
      where: { workId: work.id },
      _max: { versionNumber: true },
    });
    const baselineWork = await tx.work.findUniqueOrThrow({
      where: { id: work.id },
    });
    await assertCurrentHandoff(tx, baselineWork);
    const textVersion =
      baselineWork.requiredHandoffVersionId ??
      (
        await tx.translationVersion.findFirst({
          where: { workId: work.id },
          orderBy: { versionNumber: "desc" },
          select: { id: true },
        })
      )?.id;
    const version = await tx.typesetImageVersion.create({
      data: {
        workId: work.id,
        sourceTranslationVersionId: textVersion,
        reviewedTranslationVersionId: textVersion,
        textReviewedAt: new Date(),
        versionNumber: (latest._max.versionNumber ?? 0) + 1,
        idempotencyKey,
        uploadedById: actorId,
        automaticallySorted: false,
        images: {
          create: images.map((image, orderIndex) => ({
            fileObjectId: image.fileObjectId,
            sourceName: image.sourceName,
            width: image.width,
            height: image.height,
            orderIndex,
            workImageId: null,
          })),
        },
      },
    });
    await tx.work.update({
      where: { id: work.id },
      data: { currentTypesetVersionId: version.id, revision: { increment: 1 } },
    });
    await tx.workEvent.create({
      data: {
        workId: work.id,
        actorId,
        action: WorkEventAction.typeset_version_uploaded,
        fromWorkflowStatus: work.workflowStatus,
        toWorkflowStatus: work.workflowStatus,
        fromReviewStatus: work.reviewStatus,
        toReviewStatus: work.reviewStatus,
        idempotencyKey,
        detail: {
          operation: "typeset-version-upload",
          mode: "new_version",
          versionId: version.id,
          versionNumber: version.versionNumber,
          imageCount: images.length,
          linkedSourceImageCount: 0,
          source: "typeset-batch-upload",
        },
      },
    });
    return version.id;
  }

  async createVersion(
    actorId: string,
    workId: string,
    files: ManualUploadFile[],
    input: CreateTypesetVersionDto,
    uploadSessionId?: string,
  ): Promise<TypesetVersionListDto> {
    const replay = await this.db.typesetImageVersion.findUnique({
      where: {
        workId_idempotencyKey: { workId, idempotencyKey: input.idempotencyKey },
      },
      select: { id: true },
    });
    if (replay) return this.listVersions(workId);
    await this.assertCanUploadVersion(actorId, workId);
    let prepared;
    try {
      prepared = prepareTypesetImages(files);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "无法读取成图文件",
      );
    }
    const sourceImageIds = this.parseSourceImageIds(
      input.sourceImageIds,
      files.length,
    );
    const work = await this.db.work.findUnique({
      where: { id: workId },
      select: {
        revision: true,
        workflowStatus: true,
        typesetHandoffStartedAt: true,
        currentTypesetVersionId: true,
        images: {
          orderBy: { orderIndex: "asc" },
          select: { id: true },
        },
      },
    });
    if (!work) throw new NotFoundException("作品不存在");
    if (work.revision !== input.expectedRevision) {
      throw new ConflictException("作品已更新，请刷新后重新上传");
    }
    if (work.workflowStatus !== WorkflowStatus.typesetting) {
      throw new ConflictException("需要先开始嵌字阶段才能上传成图");
    }
    if (!work.typesetHandoffStartedAt) {
      throw new ConflictException("请先取得统一嵌字交接包");
    }
    const workImageIds = new Set(work.images.map((image) => image.id));
    if (sourceImageIds.some((id) => id !== null && !workImageIds.has(id))) {
      throw new BadRequestException("来源原图不属于当前作品");
    }
    const linkedSourceIds = sourceImageIds.filter(
      (id): id is string => id !== null,
    );
    if (new Set(linkedSourceIds).size !== linkedSourceIds.length) {
      throw new BadRequestException("同一成图版本不能重复关联同一张来源原图");
    }
    if (
      input.mode === TypesetVersionUploadMode.replace_current &&
      !work.currentTypesetVersionId
    ) {
      throw new ConflictException("当前没有可覆盖的成图版本，请选择新增版本");
    }

    const storedFiles: Awaited<ReturnType<FileObjectsService["store"]>>[] = [];
    try {
      for (const image of prepared.images) {
        storedFiles.push(
          await this.files.store({
            body: image.body,
            contentType: image.contentType,
            bucketScope: "works",
            kind: "typeset-result",
            sourceName: image.sourceName,
            createdById: actorId,
          }),
        );
      }
      let linked = false;
      try {
        linked = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
          );
          const existing = await tx.typesetImageVersion.findUnique({
            where: {
              workId_idempotencyKey: {
                workId,
                idempotencyKey: input.idempotencyKey,
              },
            },
          });
          if (existing) return false;
          if (
            !(await tx.user.count({
              where: {
                id: actorId,
                isActive: true,
                mustChangePassword: false,
                roles: { some: { role: "typesetter" } },
                workParticipations: {
                  some: {
                    workId,
                    stage: "typeset",
                    leftAt: null,
                    submittedAt: null,
                  },
                },
              },
            }))
          )
            throw new ForbiddenException("嵌字职务或当前认领已失效");
          const current = await tx.work.findUnique({ where: { id: workId } });
          if (!current) throw new NotFoundException("作品不存在");
          assertProductionWritable(current);
          await assertCurrentHandoff(tx, current);
          if (current.revision !== input.expectedRevision) {
            throw new ConflictException("作品已更新，请刷新后重新上传");
          }
          if (
            current.workflowStatus !== WorkflowStatus.typesetting ||
            !current.typesetHandoffStartedAt
          ) {
            throw new ConflictException("作品当前不能上传成图");
          }
          const latest = await tx.typesetImageVersion.aggregate({
            where: { workId },
            _max: { versionNumber: true },
          });
          const versionNumber = (latest._max.versionNumber ?? 0) + 1;
          const version = await tx.typesetImageVersion.create({
            data: {
              workId,
              sourceTranslationVersionId:
                current.requiredHandoffVersionId ??
                (
                  await tx.translationVersion.findFirst({
                    where: { workId },
                    orderBy: { versionNumber: "desc" },
                    select: { id: true },
                  })
                )?.id,
              reviewedTranslationVersionId:
                current.requiredHandoffVersionId ??
                (
                  await tx.translationVersion.findFirst({
                    where: { workId },
                    orderBy: { versionNumber: "desc" },
                    select: { id: true },
                  })
                )?.id,
              textReviewedAt: new Date(),
              versionNumber,
              note: input.note ?? null,
              automaticallySorted: prepared.automaticallySorted,
              idempotencyKey: input.idempotencyKey,
              uploadedById: actorId,
              images: {
                create: prepared.images.map((image, index) => ({
                  workImageId: sourceImageIds[image.uploadIndex],
                  fileObjectId: storedFiles[index].id,
                  orderIndex: index,
                  sourceName: image.sourceName.slice(0, 255),
                  width: image.width,
                  height: image.height,
                })),
              },
            },
          });
          const replacedVersionId =
            input.mode === TypesetVersionUploadMode.replace_current
              ? current.currentTypesetVersionId
              : null;
          if (input.mode === TypesetVersionUploadMode.replace_current) {
            if (!replacedVersionId) {
              throw new ConflictException(
                "当前没有可覆盖的成图版本，请选择新增版本",
              );
            }
            const publishedReference = await tx.publishRecord.findFirst({
              where: { typesetVersionId: replacedVersionId },
              select: { id: true },
            });
            if (publishedReference) {
              throw new ConflictException(
                "当前成图已被发布记录引用，请新增版本并单独设为当前",
              );
            }
            const reviewReference = await tx.workReviewCase.findFirst({
              where: { openedTypesetVersionId: replacedVersionId },
              select: { id: true },
            });
            if (reviewReference) {
              throw new ConflictException(
                "当前成图已被审核记录引用，请新增版本并单独设为当前",
              );
            }
            await tx.typesetImageVersion.update({
              where: { id: replacedVersionId },
              data: {
                deletedAt: new Date(),
                purgeAfter: new Date(Date.now() + typesetVersionRetentionMs),
                deletedById: actorId,
              },
            });
          }
          await tx.work.update({
            where: { id: workId },
            data: {
              currentTypesetVersionId: version.id,
              revision: { increment: 1 },
            },
          });
          await tx.workEvent.create({
            data: {
              workId,
              actorId,
              action: WorkEventAction.typeset_version_uploaded,
              fromWorkflowStatus: current.workflowStatus,
              toWorkflowStatus: current.workflowStatus,
              fromReviewStatus: current.reviewStatus,
              toReviewStatus: current.reviewStatus,
              idempotencyKey: input.idempotencyKey,
              detail: {
                operation: "typeset-version-upload",
                mode: input.mode,
                versionId: version.id,
                versionNumber,
                imageCount: prepared.images.length,
                linkedSourceImageCount: linkedSourceIds.length,
                automaticallySorted: prepared.automaticallySorted,
                replacedVersionId,
              },
            },
          });
          if (uploadSessionId)
            await this.directUploads!.completeTx(tx, uploadSessionId, {
              versionId: version.id,
            });
          return true;
        });
      } finally {
        if (!linked) {
          await Promise.all(
            storedFiles.map((file) =>
              this.files.purgeUnreferenced(file.id).catch(() => undefined),
            ),
          );
        }
      }
    } catch (error) {
      await Promise.all(
        storedFiles.map((file) =>
          this.files.purgeUnreferenced(file.id).catch(() => undefined),
        ),
      );
      throw error;
    }
    return this.listVersions(workId);
  }

  async selectVersion(
    actorId: string,
    workId: string,
    versionId: string,
    input: ManageTypesetVersionDto,
  ) {
    await this.assertCanManageVersions(actorId, workId);
    await this.mutateVersion(
      actorId,
      workId,
      versionId,
      input,
      WorkEventAction.typeset_version_selected,
      "typeset-version-select",
      async (tx, work, version) => {
        if (work.workflowStatus !== WorkflowStatus.typesetting) {
          throw new ConflictException(
            "请先进入嵌字阶段并取消已有提交，再调整成图版本",
          );
        }
        if (version.deletedAt) {
          throw new ConflictException("已删除版本需要先恢复才能设为当前版本");
        }
        await this.assertPastReviewVersion(tx, workId, version.versionNumber);
        const currentWork = await tx.work.findUniqueOrThrow({
          where: { id: workId },
        });
        const candidate = await tx.typesetImageVersion.findUniqueOrThrow({
          where: { id: versionId },
        });
        if (
          currentWork.requiredHandoffVersionId &&
          candidate.reviewedTranslationVersionId !==
            currentWork.requiredHandoffVersionId
        )
          throw new ConflictException(
            "此成图基于旧材料，请先取得最新交接包并明确复核",
          );
        await tx.work.update({
          where: { id: workId },
          data: {
            currentTypesetVersionId: version.id,
            revision: { increment: 1 },
          },
        });
        return { versionNumber: version.versionNumber };
      },
    );
    return this.listVersions(workId);
  }

  async deleteVersion(
    actorId: string,
    workId: string,
    versionId: string,
    input: DeleteTypesetVersionDto,
  ) {
    await this.assertCanManageVersions(actorId, workId);
    await this.mutateVersion(
      actorId,
      workId,
      versionId,
      input,
      WorkEventAction.typeset_version_deleted,
      "typeset-version-delete",
      async (tx, work, version) => {
        if (work.workflowStatus !== WorkflowStatus.typesetting) {
          throw new ConflictException(
            "请先进入嵌字阶段并取消已有提交，再删除成图版本",
          );
        }
        if (version.deletedAt) throw new ConflictException("成图版本已经删除");
        const isCurrent = work.currentTypesetVersionId === version.id;
        if (isCurrent && !input.clearCurrent) {
          throw new ConflictException("请先切换当前版本，或明确清除当前成图");
        }
        const publishedReference = await tx.publishRecord.findFirst({
          where: { typesetVersionId: version.id },
          select: { id: true },
        });
        if (publishedReference) {
          throw new ConflictException("已被发布记录引用的成图版本不能删除");
        }
        const reviewReference = await tx.workReviewCase.findFirst({
          where: { openedTypesetVersionId: version.id },
          select: { id: true },
        });
        if (reviewReference) {
          throw new ConflictException("已被审核记录引用的成图版本不能删除");
        }
        const deletedAt = new Date();
        await tx.typesetImageVersion.update({
          where: { id: version.id },
          data: {
            deletedAt,
            purgeAfter: new Date(
              deletedAt.getTime() + typesetVersionRetentionMs,
            ),
            deletedById: actorId,
          },
        });
        await tx.work.update({
          where: { id: workId },
          data: {
            currentTypesetVersionId: isCurrent ? null : undefined,
            revision: { increment: 1 },
          },
        });
        return {
          versionNumber: version.versionNumber,
          wasCurrent: isCurrent,
          purgeAfter: new Date(
            deletedAt.getTime() + typesetVersionRetentionMs,
          ).toISOString(),
        };
      },
    );
    return this.listVersions(workId);
  }

  async restoreVersion(
    actorId: string,
    workId: string,
    versionId: string,
    input: ManageTypesetVersionDto,
  ) {
    await this.assertCanManageVersions(actorId, workId);
    await this.mutateVersion(
      actorId,
      workId,
      versionId,
      input,
      WorkEventAction.typeset_version_restored,
      "typeset-version-restore",
      async (tx, work, version) => {
        if (work.workflowStatus !== WorkflowStatus.typesetting) {
          throw new ConflictException(
            "请先进入嵌字阶段并取消已有提交，再恢复成图版本",
          );
        }
        if (!version.deletedAt)
          throw new ConflictException("成图版本没有被删除");
        if (version.purgeAfter && version.purgeAfter <= new Date()) {
          throw new ConflictException("成图版本已超过恢复期限");
        }
        await tx.typesetImageVersion.update({
          where: { id: version.id },
          data: { deletedAt: null, purgeAfter: null, deletedById: null },
        });
        await tx.work.update({
          where: { id: workId },
          data: { revision: { increment: 1 } },
        });
        return { versionNumber: version.versionNumber };
      },
    );
    return this.listVersions(workId);
  }

  async imageUrl(
    workId: string,
    versionId: string,
    imageId: string,
    variant: "original" | "thumbnail" = "original",
  ) {
    const image = await this.db.typesetImageVersionImage.findFirst({
      where: { id: imageId, versionId, version: { workId } },
      select: { fileObjectId: true },
    });
    if (!image) throw new NotFoundException("成图不存在");
    return this.files.imageUrl(image.fileObjectId, variant);
  }

  private async assertCanUploadVersion(actorId: string, workId: string) {
    const user = await this.db.user.findUnique({
      where: { id: actorId },
      select: {
        roles: { select: { role: true } },
        workParticipations: {
          where: {
            workId,
            stage: WorkStage.typeset,
            submittedAt: null,
            leftAt: null,
          },
          select: { id: true },
        },
      },
    });
    const roles = new Set(user?.roles.map(({ role }) => role) ?? []);
    if (
      !user ||
      !roles.has(Role.typesetter) ||
      !user.workParticipations.length
    ) {
      throw new ForbiddenException("需要先加入当前作品的嵌字阶段");
    }
  }

  private async assertCanManageVersions(actorId: string, workId: string) {
    const user = await this.db.user.findUnique({
      where: { id: actorId },
      select: {
        roles: { select: { role: true } },
        workParticipations: {
          where: { workId, stage: WorkStage.typeset, leftAt: null },
          select: { id: true },
        },
      },
    });
    const roles = new Set(user?.roles.map(({ role }) => role) ?? []);
    if (
      !user ||
      (!roles.has(Role.admin) &&
        (!roles.has(Role.typesetter) || !user.workParticipations.length))
    ) {
      throw new ForbiddenException("没有管理此作品成图版本的权限");
    }
  }

  private async mutateVersion(
    actorId: string,
    workId: string,
    versionId: string,
    input: ManageTypesetVersionDto,
    action: WorkEventAction,
    operation: string,
    mutation: (
      tx: Prisma.TransactionClient,
      work: {
        revision: number;
        workflowStatus: WorkflowStatus;
        reviewStatus: "normal" | "needs_review" | "blocked";
        currentTypesetVersionId: string | null;
      },
      version: {
        id: string;
        versionNumber: number;
        deletedAt: Date | null;
        purgeAfter: Date | null;
      },
    ) => Promise<Record<string, unknown>>,
  ) {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${workId}::uuid FOR UPDATE`,
      );
      const existing = await tx.workEvent.findUnique({
        where: {
          workId_idempotencyKey: {
            workId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        const detail = existing.detail as { operation?: unknown };
        if (existing.action !== action || detail.operation !== operation) {
          throw new ConflictException("幂等键已用于其他作品操作");
        }
        return;
      }
      const work = await tx.work.findUnique({
        where: { id: workId },
        select: {
          revision: true,
          workflowStatus: true,
          reviewStatus: true,
          currentTypesetVersionId: true,
        },
      });
      if (!work) throw new NotFoundException("作品不存在");
      assertProductionWritable(work);
      if (work.revision !== input.expectedRevision) {
        throw new ConflictException("作品已更新，请刷新后重试");
      }
      if (work.workflowStatus === WorkflowStatus.archived) {
        throw new ConflictException("归档作品不能修改成图版本");
      }
      const version = await tx.typesetImageVersion.findFirst({
        where: { id: versionId, workId },
      });
      if (!version) throw new NotFoundException("成图版本不存在");
      const detail = await mutation(tx, work, version);
      const updated = await tx.work.findUniqueOrThrow({
        where: { id: workId },
        select: { workflowStatus: true },
      });
      await tx.workEvent.create({
        data: {
          workId,
          actorId,
          action,
          fromWorkflowStatus: work.workflowStatus,
          toWorkflowStatus: updated.workflowStatus,
          fromReviewStatus: work.reviewStatus,
          toReviewStatus: work.reviewStatus,
          idempotencyKey: input.idempotencyKey,
          detail: { operation, versionId, ...detail },
        },
      });
    });
  }

  private async assertPastReviewVersion(
    tx: Prisma.TransactionClient,
    workId: string,
    versionNumber: number,
  ) {
    const review = await tx.workReviewCase.findFirst({
      where: {
        workId,
        status: ReviewCaseStatus.resolved,
        resolution: ReviewResolution.revise,
        openedTypesetVersionId: { not: null },
      },
      orderBy: [{ resolvedAt: "desc" }, { createdAt: "desc" }],
      include: {
        openedTypesetVersion: { select: { versionNumber: true } },
      },
    });
    const boundary = review?.openedTypesetVersion?.versionNumber;
    if (boundary !== undefined && versionNumber <= boundary) {
      throw new ConflictException(
        `审核返工后不能重新选择 v${boundary} 或更早的成图版本`,
      );
    }
  }

  private versionDto(
    version: {
      id: string;
      versionNumber: number;
      note: string | null;
      automaticallySorted: boolean;
      sourceTranslationVersionId: string | null;
      reviewedTranslationVersionId: string | null;
      uploadedById: string;
      uploadedBy: { displayName: string };
      deletedAt: Date | null;
      purgeAfter: Date | null;
      createdAt: Date;
      images: {
        id: string;
        workImageId: string | null;
        orderIndex: number;
        sourceName: string;
        width: number;
        height: number;
      }[];
    },
    currentVersionId: string | null,
    requiredTextVersionId: string | null,
  ): TypesetVersionDto {
    return {
      id: version.id,
      sourceTranslationVersionId: version.sourceTranslationVersionId,
      reviewedTranslationVersionId: version.reviewedTranslationVersionId,
      needsTextReview: Boolean(
        requiredTextVersionId &&
        requiredTextVersionId !== version.reviewedTranslationVersionId,
      ),
      versionNumber: version.versionNumber,
      note: version.note,
      automaticallySorted: version.automaticallySorted,
      isCurrent: version.id === currentVersionId,
      uploadedById: version.uploadedById,
      uploadedByName: version.uploadedBy.displayName,
      deletedAt: version.deletedAt?.toISOString() ?? null,
      purgeAfter: version.purgeAfter?.toISOString() ?? null,
      images: version.images.map((image) => ({
        id: image.id,
        workImageId: image.workImageId,
        orderIndex: image.orderIndex,
        sourceName: image.sourceName,
        width: image.width,
        height: image.height,
      })),
      createdAt: version.createdAt.toISOString(),
    };
  }

  private packageDto(record: {
    id: string;
    workId: string;
    fileName: string;
    imageCount: number;
    markerCount: number;
    workRevision: number;
    editorEpoch: number;
    createdAt: Date;
  }): TypesetHandoffPackageDto {
    return {
      packageId: record.id,
      fileName: record.fileName,
      downloadUrl: `/api/works/${record.workId}/typeset/handoff-packages/${record.id}`,
      imageCount: record.imageCount,
      markerCount: record.markerCount,
      workRevision: record.workRevision,
      editorEpoch: record.editorEpoch,
      createdAt: record.createdAt.toISOString(),
    };
  }

  private parseSourceImageIds(value: string | undefined, fileCount: number) {
    if (!value) return Array<string | null>(fileCount).fill(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException("来源原图关联格式无效");
    }
    if (!Array.isArray(parsed) || parsed.length !== fileCount) {
      throw new BadRequestException("来源原图关联必须与上传图片逐一对应");
    }
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      parsed.some(
        (item) =>
          item !== null && (typeof item !== "string" || !uuid.test(item)),
      )
    ) {
      throw new BadRequestException("来源原图关联必须是有效 UUID 或 null");
    }
    return parsed as (string | null)[];
  }
}
