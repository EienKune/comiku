import { JobsService } from "../jobs/jobs.service.js";
import { assertCurrentHandoff } from "../workflow/revision-policy.js";
import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  Logger,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  Prisma,
  Role,
  WorkStage,
  WorkflowStatus,
  ReviewStatus,
  WorkEventAction,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { TypesettingService } from "./typesetting.service.js";
import { WorksService } from "../works/works.service.js";
import {
  prepareTypesetBatchFile,
  typesetName,
  validateTypesetSelection,
  TYPESET_BATCH_MAX_FILES,
} from "./typeset-batch-upload.js";
import type {
  CreateTypesetUploadSessionDto,
  PreviewTypesetUploadGroupsDto,
  TypesetUploadPlanDto,
  TypesetUploadPlansDto,
  TypesetUploadSessionDto,
} from "./typeset-upload.dto.js";

const details = {
  files: {
    include: {
      images: {
        include: { fileObject: true },
        orderBy: { orderIndex: "asc" as const },
      },
    },
    orderBy: { orderIndex: "asc" as const },
  },
};
type Session = Prisma.TypesetUploadSessionGetPayload<{
  include: typeof details;
}>;
const lifetimeMs = 24 * 60 * 60 * 1000;

@Injectable()
export class TypesetUploadsService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleanupRunning = false;
  private extracting = false;
  onModuleInit() {
    this.jobs?.register("typeset_upload_cleanup", async () => {
      await this.cleanupExpired();
    });
    this.jobs?.register("typeset_extract", async (job, signal) => {
      if (!job.actorId) return;
      await this.extract(job.actorId, job.resourceId, true, signal);
    });
    if (this.environment.nodeEnv === "test") return;
    this.cleanupTimer = setInterval(
      () => {
        void this.cleanupExpired().catch(() =>
          Logger.warn(
            "成图临时文件清理未完成，将稍后重试",
            "TypesetUploadsService",
          ),
        );
      },
      15 * 60 * 1000,
    );
    this.cleanupTimer.unref();
  }
  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(TypesettingService)
    private readonly typesetting: TypesettingService,
    @Inject(WorksService) private readonly works: WorksService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Optional() @Inject(JobsService) private readonly jobs?: JobsService,
  ) {}

  private async assertActor(
    actorId: string,
    db: PrismaService | Prisma.TransactionClient = this.db,
  ) {
    const user = await db.user.findFirst({
      where: {
        id: actorId,
        isActive: true,
        roles: { some: { role: Role.typesetter } },
      },
      select: { id: true },
    });
    if (!user) throw new ForbiddenException("需要具备嵌字职务");
  }

  async create(
    actorId: string,
    input: CreateTypesetUploadSessionDto,
  ): Promise<TypesetUploadSessionDto> {
    await this.assertActor(actorId);
    await this.cleanupExpired();
    if (!input.files.length || input.files.length > TYPESET_BATCH_MAX_FILES)
      throw new BadRequestException("整批最多选择 200 个文件");
    if (
      input.files.reduce((total, file) => total + file.size, 0) >
      this.environment.typesetBatchMaxBytes
    )
      throw new BadRequestException("整批上传超过当前容量上限");
    if (
      input.files.some(
        (file) =>
          file.contentType !== "application/zip" &&
          file.size > 25 * 1024 * 1024,
      )
    )
      throw new BadRequestException("单张成图不能超过 25 MiB");
    const types: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      zip: "application/zip",
    };
    if (
      input.files.some(
        (file) =>
          types[file.sourceName.toLowerCase().split(".").at(-1) ?? ""] !==
          file.contentType,
      )
    )
      throw new BadRequestException("文件扩展名与上传类型不一致");
    const id = randomUUID();
    const session = await this.db.typesetUploadSession.create({
      data: {
        id,
        actorId,
        expiresAt: new Date(Date.now() + lifetimeMs),
        files: {
          create: input.files.map((file, orderIndex) => {
            const fileId = randomUUID();
            return {
              id: fileId,
              orderIndex,
              sourceName: file.sourceName,
              objectKey: `staging/typeset-upload/${id}/${fileId}`,
              contentType: file.contentType,
              size: BigInt(file.size),
              checksum: file.checksum,
            };
          }),
        },
      },
      include: details,
    });
    return this.dto(session);
  }

  async get(actorId: string, id: string) {
    return this.dto(await this.find(actorId, id));
  }

  private async find(actorId: string, id: string): Promise<Session> {
    await this.assertActor(actorId);
    const session = await this.db.typesetUploadSession.findFirst({
      where: { id, actorId },
      include: details,
    });
    if (!session) throw new NotFoundException("成图上传会话不存在");
    if (
      session.status === "expired" ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new ConflictException("成图上传会话已过期，请重新选择文件");
    if (
      session.status === "extracting" &&
      (await this.db.backgroundJob.count({
        where: { resourceId: id, kind: "typeset_extract", status: "failed" },
      }))
    ) {
      await this.db.typesetUploadFile.updateMany({
        where: { sessionId: id, status: { not: "processed" } },
        data: { status: "failed", error: "后台解析未完成，请重新选择文件" },
      });
      await this.db.typesetUploadSession.update({
        where: { id },
        data: { status: "previewed" },
      });
      return this.db.typesetUploadSession.findUniqueOrThrow({
        where: { id },
        include: details,
      });
    }
    return session;
  }

  private async dto(session: Session): Promise<TypesetUploadSessionDto> {
    return {
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
      maxWorks: this.environment.typesetBatchMaxWorks,
      maxTotalBytes: this.environment.typesetBatchMaxBytes,
      files: await Promise.all(
        session.files.map(async (file) => {
          const target =
            file.status !== "processed" && session.status !== "extracting"
              ? await this.files.signedStagingWriteUrl(
                  {
                    key: file.objectKey,
                    contentType: file.contentType,
                    size: Number(file.size),
                    checksum: file.checksum,
                  },
                  Math.min(
                    900,
                    Math.max(
                      1,
                      Math.floor(
                        (session.expiresAt.getTime() - Date.now()) / 1000,
                      ),
                    ),
                  ),
                )
              : null;
          const archive = file.contentType === "application/zip";
          const container = typesetName(file.sourceName, archive);
          return {
            id: file.id,
            sourceName: file.sourceName,
            archive,
            status: file.status,
            error: file.error,
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
            images: file.images.map((image) => {
              const named = typesetName(image.sourceName);
              const conflict =
                archive &&
                container.workNumber !== null &&
                named.workNumber !== null &&
                container.workNumber !== named.workNumber;
              const workNumber = conflict
                ? null
                : archive
                  ? (container.workNumber ?? named.workNumber)
                  : named.workNumber;
              const warnings: string[] = [];
              if (conflict)
                warnings.push("包内编号与包名冲突，请拆组或明确指定目标");
              if (!workNumber)
                warnings.push("无法自动匹配作品编号，请明确指定目标");
              if (!image.sourceName.includes("成图"))
                warnings.push("文件名没有成图标识，请核对实际图片");
              if (file.sourceName.includes("嵌字交接"))
                warnings.push("疑似原图交接包，请确认上传的是成图");
              return {
                id: image.id,
                uploadFileId: file.id,
                sourceName: image.sourceName,
                width: image.width,
                height: image.height,
                size: Number(image.fileObject.size),
                workNumber,
                pageNumber: named.pageNumber,
                warnings,
              };
            }),
          };
        }),
      ),
    };
  }

  async queueExtract(actorId: string, id: string) {
    const session = await this.find(actorId, id);
    if (
      session.status === "previewed" &&
      session.files.every((file) => file.status === "processed")
    )
      return this.dto(session);
    if (!["pending", "previewed", "extracting"].includes(session.status))
      throw new ConflictException("会话当前不能解析");
    if (session.status === "extracting") return this.get(actorId, id);
    const key =
      session.status === "pending"
        ? `typeset-extract:${id}`
        : `typeset-extract:${id}:${randomUUID()}`;
    await this.db.$transaction(async (tx) => {
      await tx.typesetUploadSession.update({
        where: { id },
        data: { status: "extracting" },
      });
      await this.jobs!.enqueue(
        {
          kind: "typeset_extract",
          resourceId: id,
          actorId,
          idempotencyKey: key,
        },
        tx,
      );
    });
    return this.get(actorId, id);
  }

  async extract(
    actorId: string,
    id: string,
    background = false,
    signal?: AbortSignal,
  ): Promise<TypesetUploadSessionDto> {
    if (this.extracting)
      throw new ConflictException("正在解析其他成图包，请稍后恢复会话重试");
    this.extracting = true;
    try {
      return await this.extractSession(actorId, id, background, signal);
    } finally {
      this.extracting = false;
    }
  }

  private async extractSession(
    actorId: string,
    id: string,
    background: boolean,
    signal?: AbortSignal,
  ): Promise<TypesetUploadSessionDto> {
    const session = await this.find(actorId, id);
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const claimed = background
      ? { count: 1 }
      : await this.db.typesetUploadSession.updateMany({
          where: {
            id,
            actorId,
            OR: [
              { status: { in: ["pending", "previewed"] } },
              { status: "extracting", updatedAt: { lt: stale } },
            ],
          },
          data: { status: "extracting" },
        });
    if (!claimed.count)
      throw new ConflictException("成图正在解析，请稍后恢复会话");
    let finished = false;
    let totalBytes = session.files
      .flatMap((file) => file.images)
      .reduce((total, image) => total + Number(image.fileObject.size), 0);
    let totalImages = session.files.flatMap((file) => file.images).length;
    try {
      for (const file of session.files) {
        signal?.throwIfAborted();
        if (file.status === "processed") continue;
        const storedIds: string[] = [];
        try {
          const metadata = await this.files.headStagingObject(file.objectKey);
          if (
            !metadata ||
            metadata.size !== Number(file.size) ||
            metadata.contentType !== file.contentType ||
            metadata.checksum?.toLowerCase() !== file.checksum
          )
            throw new Error("文件未上传完成，或大小、类型、校验值与会话不一致");
          const body = await this.files.readStagingObject(file.objectKey);
          if (
            body.byteLength !== Number(file.size) ||
            createHash("sha256").update(body).digest("hex") !== file.checksum
          )
            throw new Error("上传内容校验失败");
          const group = prepareTypesetBatchFile({
            originalname: file.sourceName,
            mimetype: file.contentType,
            size: body.byteLength,
            buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
          });
          const expanded = group.images.reduce(
            (total, image) => total + image.body.byteLength,
            0,
          );
          if (
            totalBytes + expanded > this.environment.typesetBatchMaxBytes ||
            totalImages + group.images.length >
              this.environment.typesetBatchMaxWorks * 100
          )
            throw new Error("解包后的整批图片超过容量或数量上限");
          const images: Prisma.TypesetUploadImageUncheckedCreateWithoutUploadFileInput[] =
            [];
          for (const [index, image] of group.images.entries()) {
            const stored = await this.files.store({
              body: image.body,
              contentType: image.contentType,
              bucketScope: "works",
              kind: "typeset-upload-preview",
              sourceName: image.sourceName,
              createdById: actorId,
            });
            storedIds.push(stored.id);
            images.push({
              sourceName: image.sourceName,
              fileObjectId: stored.id,
              width: image.width!,
              height: image.height!,
              orderIndex: index,
            });
          }
          await this.db.$transaction(async (tx) => {
            await this.assertActor(actorId, tx);
            await this.jobs?.assertCurrentLease(tx);
            await tx.typesetUploadFile.update({
              where: { id: file.id },
              data: {
                status: "processed",
                error: null,
                images: { create: images },
              },
            });
          });
          await this.db.typesetUploadSession.update({
            where: { id },
            data: { updatedAt: new Date() },
          });
          storedIds.length = 0;
          totalBytes += expanded;
          totalImages += group.images.length;
          await this.files
            .deleteStagingObject(file.objectKey)
            .catch(() => undefined);
        } catch (error) {
          signal?.throwIfAborted();
          await this.jobs?.assertCurrentLease(this.db);
          for (const fileId of storedIds)
            await this.files.purgeUnreferenced(fileId).catch(() => undefined);
          await this.db.typesetUploadFile.update({
            where: { id: file.id },
            data: {
              status: "failed",
              error: (error instanceof Error
                ? error.message
                : "无法解析成图"
              ).slice(0, 500),
            },
          });
        }
      }
      finished = true;
    } finally {
      await this.jobs?.assertCurrentLease(this.db);
      await this.db.typesetUploadSession.update({
        where: { id },
        data: { status: finished ? "previewed" : "extracting" },
      });
    }
    return this.get(actorId, id);
  }

  async imageUrl(
    actorId: string,
    id: string,
    imageId: string,
    variant: "original" | "thumbnail" = "original",
  ) {
    await this.find(actorId, id);
    const image = await this.db.typesetUploadImage.findFirst({
      where: {
        id: imageId,
        uploadFile: { sessionId: id, session: { actorId } },
      },
      select: { fileObjectId: true },
    });
    if (!image) throw new NotFoundException("预览图片不存在");
    return this.files.imageUrl(image.fileObjectId, variant);
  }

  async plans(
    actorId: string,
    id: string,
    input: PreviewTypesetUploadGroupsDto,
  ): Promise<TypesetUploadPlansDto> {
    const session = await this.find(actorId, id);
    if (session.status === "extracting")
      throw new ConflictException("请等待成图解析完成");
    if (input.groups.length > this.environment.typesetBatchMaxWorks)
      throw new BadRequestException("本次确认的作品数量超过队列上限");
    if (
      new Set(input.groups.map((group) => group.workNumber)).size !==
      input.groups.length
    )
      throw new BadRequestException("同作品只能建立一个上传项，请先合并");
    const ids = input.groups.flatMap((group) => group.imageIds);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException("同一张图片不能重复归入多个作品");
    const imageMap = new Map(
      session.files.flatMap((file) =>
        file.images.map(
          (image) =>
            [
              image.id,
              {
                ...image,
                archive: file.contentType === "application/zip",
                uploadFileId: file.id,
                size: Number(image.fileObject.size),
              },
            ] as const,
        ),
      ),
    );
    const suggested = new Map(
      (await this.dto(session)).files.flatMap((file) =>
        file.images.map((image) => [image.id, image.workNumber] as const),
      ),
    );
    const items: TypesetUploadPlanDto[] = [];
    for (const group of input.groups) {
      const result: TypesetUploadPlanDto = {
        workNumber: group.workNumber,
        workId: null,
        title: null,
        previewId: null,
        workRevision: null,
        editorEpoch: null,
        handoffStartedAt: null,
        imageCount: group.imageIds.length,
        error: null,
      };
      try {
        const images = group.imageIds.map((imageId) => {
          const image = imageMap.get(imageId);
          if (!image) throw new Error("图片不属于当前上传会话");
          return image;
        });
        validateTypesetSelection(images, group.mergeConfirmed);
        if (!group.contentConfirmed) throw new Error("请确认所选图片为成图");
        if (
          group.imageIds.some(
            (imageId) => suggested.get(imageId) !== group.workNumber,
          ) &&
          !group.manualTargetConfirmed
        )
          throw new Error("编号缺失或冲突，请明确确认人工指定的目标");
        await this.db.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM typeset_upload_sessions WHERE id = ${id}::uuid FOR UPDATE`,
          );
          const work = await tx.work.findUnique({
            where: { workNumber: group.workNumber },
          });
          if (!work) throw new NotFoundException("作品编号不存在");
          result.workId = work.id;
          result.title = work.title;
          await this.assertWork(actorId, work.id, tx);
          const existing = await tx.typesetUploadPreview.findUnique({
            where: { sessionId_workId: { sessionId: id, workId: work.id } },
          });
          if (existing?.versionId)
            throw new ConflictException(
              "本批次已经为该作品创建成图版本，请勿重复上传",
            );
          const data = {
            id: randomUUID(),
            workRevision: work.revision,
            editorEpoch: work.editorEpoch,
            handoffStartedAt: work.typesetHandoffStartedAt!,
            imageIds: group.imageIds,
            idempotencyKey: existing?.idempotencyKey ?? randomUUID(),
          };
          const preview = await tx.typesetUploadPreview.upsert({
            where: { sessionId_workId: { sessionId: id, workId: work.id } },
            create: { ...data, sessionId: id, workId: work.id },
            update: data,
          });
          result.previewId = preview.id;
          result.workRevision = preview.workRevision;
          result.editorEpoch = preview.editorEpoch;
          result.handoffStartedAt = preview.handoffStartedAt.toISOString();
        });
      } catch (error) {
        result.error =
          error instanceof Error ? error.message : "无法确认上传目标";
      }
      items.push(result);
    }
    return { items };
  }

  private async assertWork(
    actorId: string,
    workId: string,
    tx: Prisma.TransactionClient,
  ) {
    await this.assertActor(actorId, tx);
    const participant = await tx.workStageParticipant.findFirst({
      where: {
        workId,
        userId: actorId,
        stage: WorkStage.typeset,
        leftAt: null,
        submittedAt: null,
      },
      select: { id: true },
    });
    if (!participant)
      throw new ForbiddenException("需要认领当前作品的嵌字任务");
    const work = await tx.work.findUniqueOrThrow({ where: { id: workId } });
    if (
      work.reviewStatus !== ReviewStatus.normal ||
      ![WorkflowStatus.pending_typeset, WorkflowStatus.typesetting].some(
        (status) => status === work.workflowStatus,
      )
    )
      throw new ConflictException("作品当前不允许批量上传成图");
    if (
      !work.typesetHandoffStartedAt ||
      work.workflowStatus !== WorkflowStatus.typesetting
    )
      throw new ConflictException("请先下载该作品的嵌字交接包，再重新预览上传");
    await assertCurrentHandoff(tx, work);
    return work;
  }

  async confirm(actorId: string, id: string, previewId: string) {
    await this.find(actorId, id);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM typeset_upload_sessions WHERE id = ${id}::uuid FOR UPDATE`,
      );
      const session = await tx.typesetUploadSession.findFirst({
        where: { id, actorId },
      });
      if (
        !session ||
        session.expiresAt.getTime() <= Date.now() ||
        session.status === "expired"
      )
        throw new ConflictException("上传会话已过期");
      const preview = await tx.typesetUploadPreview.findFirst({
        where: { id: previewId, sessionId: id },
      });
      if (!preview) throw new ConflictException("上传预览已更新，请重新确认");
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM works WHERE id = ${preview.workId}::uuid FOR UPDATE`,
      );
      if (preview.versionId) {
        const submitted = await tx.workEvent.findFirst({
          where: {
            workId: preview.workId,
            action: WorkEventAction.stage_submitted,
            idempotencyKey: preview.id,
            detail: { path: ["operation"], equals: "submit:typeset" },
          },
          select: { id: true },
        });
        return {
          workId: preview.workId,
          versionId: preview.versionId,
          stageSubmitted: Boolean(submitted),
        };
      }
      const work = await this.assertWork(actorId, preview.workId, tx);
      if (
        work.revision !== preview.workRevision ||
        work.editorEpoch !== preview.editorEpoch ||
        work.typesetHandoffStartedAt?.getTime() !==
          preview.handoffStartedAt.getTime()
      )
        throw new ConflictException("作品或交接基线已变化，请重新预览并确认");
      const ids = preview.imageIds as string[];
      const images = await tx.typesetUploadImage.findMany({
        where: { id: { in: ids }, uploadFile: { sessionId: id } },
      });
      const ordered = ids.map((imageId) => {
        const image = images.find((row) => row.id === imageId);
        if (!image) throw new ConflictException("预览图片已失效");
        return image;
      });
      const versionId = await this.typesetting.createStagedVersionTx(
        tx,
        actorId,
        work,
        preview.idempotencyKey,
        ordered,
      );
      await this.works.submitStageTx(tx, actorId, work.id, {
        stage: WorkStage.typeset,
        expectedRevision: work.revision + 1,
        expectedEditorEpoch: work.editorEpoch,
        // Upload and submission have separate event keys; both remain stable on retry.
        idempotencyKey: preview.id,
      });
      await tx.typesetUploadPreview.update({
        where: { id: preview.id },
        data: { versionId },
      });
      return { workId: work.id, versionId, stageSubmitted: true };
    });
  }

  async cleanupExpired() {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      await this.cleanupBatch();
    } finally {
      this.cleanupRunning = false;
    }
  }

  private async cleanupBatch() {
    const sessions = await this.db.typesetUploadSession.findMany({
      where: {
        expiresAt: { lte: new Date() },
        OR: [
          { status: { notIn: ["expired", "extracting"] } },
          {
            status: "extracting",
            updatedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
          },
        ],
      },
      include: details,
      take: 20,
    });
    for (const session of sessions) {
      const orphanIds = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM typeset_upload_sessions WHERE id = ${session.id}::uuid FOR UPDATE`,
        );
        await tx.typesetUploadSession.update({
          where: { id: session.id },
          data: { status: "expired" },
        });
        const images = await tx.typesetUploadImage.findMany({
          where: { uploadFile: { sessionId: session.id } },
        });
        await tx.typesetUploadImage.deleteMany({
          where: { uploadFile: { sessionId: session.id } },
        });
        const ids = images.map((image) => image.fileObjectId);
        const referenced = await tx.typesetImageVersionImage.findMany({
          where: { fileObjectId: { in: ids } },
          select: { fileObjectId: true },
        });
        const retained = new Set(referenced.map((image) => image.fileObjectId));
        const orphanIds = ids.filter((fileId) => !retained.has(fileId));
        await tx.fileObject.updateMany({
          where: { id: { in: orphanIds } },
          data: { lifecycleStatus: "pending_deletion" },
        });
        return orphanIds;
      });
      let stagingFailed = false;
      for (const file of session.files)
        await this.files.deleteStagingObject(file.objectKey).catch(() => {
          stagingFailed = true;
        });
      if (stagingFailed)
        await this.db.typesetUploadSession.update({
          where: { id: session.id },
          data: { status: "cleanup_pending" },
        });
      for (const fileId of orphanIds)
        await this.files.purgeUnreferenced(fileId).catch(() => undefined);
    }
    const retryFiles = await this.db.fileObject.findMany({
      where: {
        kind: "typeset-upload-preview",
        lifecycleStatus: "pending_deletion",
        typesetImages: { none: {} },
        typesetUploadImages: { none: {} },
      },
      select: { id: true },
      take: 100,
    });
    for (const file of retryFiles)
      await this.files.purgeUnreferenced(file.id).catch(() => undefined);
  }
}
