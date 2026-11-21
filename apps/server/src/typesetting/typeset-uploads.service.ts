import {
  planTypesetPageMappings,
  type BatchPageMapping,
} from "./typeset-batch-mapping.js";
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
import { TypesetCollaborationService } from "./typeset-collaboration.service.js";
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
  TypesetUploadFileDto,
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
    @Optional()
    @Inject(TypesetCollaborationService)
    private readonly collaboration?: TypesetCollaborationService,
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

  private async dto(
    session: Session,
    signWrites = true,
  ): Promise<TypesetUploadSessionDto> {
    const previews =
      signWrites && session.status === "previewed"
        ? await this.db.typesetUploadPreview.findMany({
            where: { sessionId: session.id },
            select: {
              id: true,
              workId: true,
              versionId: true,
              imageIds: true,
              work: { select: { workNumber: true } },
            },
          })
        : [];
    const submissions = previews.length
      ? await this.db.workEvent.findMany({
          where: {
            workId: { in: previews.map((p) => p.workId) },
            idempotencyKey: { in: previews.map((p) => p.id) },
            action: "stage_submitted",
            actorId: session.actorId,
            detail: { path: ["operation"], equals: "submit:typeset" },
          },
          select: {
            workId: true,
            idempotencyKey: true,
            toWorkflowStatus: true,
            detail: true,
          },
        })
      : [];
    const receipts = previews.flatMap((preview) => {
      const submitted = submissions.find(
        (event) =>
          event.workId === preview.workId &&
          event.idempotencyKey === preview.id,
      );
      if (!preview.versionId && !submitted) return [];
      const detail = submitted?.detail as { versionId?: string } | undefined;
      const imageIds = Array.isArray(preview.imageIds)
        ? (preview.imageIds as string[])
        : (preview.imageIds as { imageIds: string[] }).imageIds;
      return [
        {
          workNumber: preview.work.workNumber,
          workId: preview.workId,
          versionId: detail?.versionId ?? preview.versionId,
          stageSubmitted: !!submitted,
          workCompleted: submitted?.toWorkflowStatus === "pending_publish",
          imageIds,
        },
      ];
    });
    return {
      receipts,
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt.toISOString(),
      maxWorks: this.environment.typesetBatchMaxWorks,
      maxTotalBytes: this.environment.typesetBatchMaxBytes,
      files: await Promise.all(
        session.files.map(async (file) => {
          const target =
            signWrites &&
            !["processed", "verifying"].includes(file.status) &&
            session.status !== "extracting"
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

  /** A PUT is only staging. Snapshot, validate actual bytes, then atomically adopt. */
  async verifyFile(
    actorId: string,
    id: string,
    fileId: string,
  ): Promise<TypesetUploadFileDto> {
    await this.assertActor(actorId);
    const attempt = await this.db.$transaction(async (tx) => {
      // Atomic, cluster-wide admission; no network work holds this lock.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(1869833076, 1)`;
      await tx.$queryRaw`SELECT id FROM typeset_upload_sessions WHERE id=${id}::uuid FOR UPDATE`;
      const session = await tx.typesetUploadSession.findFirst({
        where: { id, actorId },
        include: { files: { ...details.files, where: { id: fileId } } },
      });
      if (!session) throw new NotFoundException("成图上传会话不存在");
      if (session.expiresAt <= new Date() || session.status === "expired")
        throw new ConflictException("成图上传会话已过期");
      if (session.status === "extracting")
        throw new ConflictException("会话正在后台解析，请稍后重试");
      const file = session.files.find((row) => row.id === fileId);
      if (!file) throw new NotFoundException("上传文件不存在");
      if (file.status === "processed") return null;
      if (file.contentType === "application/zip")
        throw new BadRequestException("请先在本地解包，再逐张验证成图");
      const now = new Date();
      if (
        await tx.typesetUploadVerification.count({
          where: {
            uploadFileId: fileId,
            status: "processing",
            expiresAt: { gt: now },
          },
        })
      )
        return null;
      if (
        (await tx.typesetUploadVerification.count({
          where: { status: "processing", expiresAt: { gt: now } },
        })) >= 2
      )
        throw new ConflictException("当前图片验证繁忙，请稍后重试");
      await tx.typesetUploadVerification.updateMany({
        where: {
          uploadFileId: fileId,
          status: "processing",
          expiresAt: { lte: now },
        },
        data: { status: "failed" },
      });
      const attemptId = randomUUID();
      const created = await tx.typesetUploadVerification.create({
        data: {
          id: attemptId,
          uploadFileId: fileId,
          objectKey: `works/typeset-upload-preview/${id}/${attemptId}`,
          expiresAt: new Date(now.getTime() + 2 * 60_000),
        },
      });
      await tx.typesetUploadFile.update({
        where: { id: fileId },
        data: { status: "verifying", error: null },
      });
      return { ...created, file };
    });
    if (attempt) {
      const signal = AbortSignal.timeout(90_000);
      try {
        const file = attempt.file;
        const metadata = await this.files.headStagingObject(
          file.objectKey,
          signal,
        );
        if (
          !metadata ||
          metadata.size !== Number(file.size) ||
          metadata.contentType !== file.contentType ||
          metadata.checksum?.toLowerCase() !== file.checksum
        )
          throw new Error("文件未上传完成，或大小、类型、校验值与会话不一致");
        // No client ever receives a write capability for the copied key.
        await this.files.copyStagingObject(
          file.objectKey,
          attempt.objectKey,
          signal,
        );
        const body = await this.files.readStagingObjectLimited(
          attempt.objectKey,
          Number(file.size),
          signal,
        );
        if (
          body.byteLength !== Number(file.size) ||
          createHash("sha256").update(body).digest("hex") !== file.checksum
        )
          throw new Error("上传内容校验失败");
        const prepared = prepareTypesetBatchFile({
          originalname: file.sourceName,
          mimetype: file.contentType,
          size: body.byteLength,
          buffer: body,
        });
        const image = prepared.images[0];
        if (
          prepared.images.length !== 1 ||
          image.contentType !== file.contentType
        )
          throw new Error("图片实际格式与上传类型不一致");
        await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM typeset_upload_sessions WHERE id=${id}::uuid FOR UPDATE`;
          await this.assertActor(actorId, tx);
          const session = await tx.typesetUploadSession.findFirst({
            where: { id, actorId },
            include: { files: { ...details.files, where: { id: fileId } } },
          });
          const current = await tx.typesetUploadVerification.findUnique({
            where: { id: attempt.id },
          });
          if (
            !session ||
            session.status === "expired" ||
            session.expiresAt <= new Date() ||
            current?.status !== "processing" ||
            current.expiresAt <= new Date()
          )
            throw new ConflictException("本次验证已过期，请重试当前文件");
          if (
            session.files.find((row) => row.id === fileId)?.status ===
            "processed"
          )
            throw new ConflictException("文件已由其他请求验证完成");
          const totals = await tx.fileObject.aggregate({
            where: {
              typesetUploadImages: { some: { uploadFile: { sessionId: id } } },
            },
            _sum: { size: true },
          });
          const imageCount = await tx.typesetUploadImage.count({
            where: { uploadFile: { sessionId: id } },
          });
          if (
            Number(totals._sum.size ?? 0) + body.byteLength >
              this.environment.typesetBatchMaxBytes ||
            imageCount + 1 > this.environment.typesetBatchMaxWorks * 100
          )
            throw new BadRequestException("整批图片超过容量或数量上限");
          const completed = await tx.typesetUploadVerification.updateMany({
            where: {
              id: attempt.id,
              status: "processing",
              expiresAt: { gt: new Date() },
            },
            data: { status: "completed" },
          });
          if (!completed.count)
            throw new ConflictException("本次验证已失效，请重试当前文件");
          const adopted = await this.files.adoptCopiedObjectTx(tx, {
            objectKey: attempt.objectKey,
            contentType: image.contentType,
            size: body.byteLength,
            checksum: file.checksum,
            createdById: actorId,
          });
          await tx.typesetUploadFile.update({
            where: { id: fileId },
            data: {
              status: "processed",
              error: null,
              images: {
                create: [
                  {
                    fileObjectId: adopted.id,
                    sourceName: file.sourceName,
                    width: image.width!,
                    height: image.height!,
                    orderIndex: 0,
                  },
                ],
              },
            },
          });
          await tx.typesetUploadSession.update({
            where: { id },
            data: { status: "previewed" },
          });
        });
        await this.files
          .deleteStagingObject(file.objectKey)
          .catch(() => undefined);
      } catch (error) {
        // A lost commit reply must never delete the adopted snapshot.
        const failed = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM typeset_upload_sessions WHERE id=${id}::uuid FOR UPDATE`;
          const current = await tx.typesetUploadVerification.findUnique({
            where: { id: attempt.id },
          });
          if (current?.status === "completed") return false;
          await tx.typesetUploadVerification.updateMany({
            where: { id: attempt.id, status: "processing" },
            data: { status: "failed" },
          });
          const newer = await tx.typesetUploadVerification.count({
            where: {
              uploadFileId: fileId,
              id: { not: attempt.id },
              status: "processing",
              expiresAt: { gt: new Date() },
            },
          });
          if (!newer)
            await tx.typesetUploadFile.updateMany({
              where: { id: fileId, status: { not: "processed" } },
              data: {
                status: "failed",
                error: (error instanceof Error
                  ? error.message
                  : "无法验证成图"
                ).slice(0, 500),
              },
            });
          return true;
        });
        if (failed)
          await this.files
            .deleteStagingObject(attempt.objectKey)
            .catch(() => undefined);
      }
    }
    const session = await this.db.typesetUploadSession.findFirst({
      where: { id, actorId },
      include: { files: { ...details.files, where: { id: fileId } } },
    });
    if (
      !session ||
      session.expiresAt <= new Date() ||
      session.status === "expired"
    )
      throw new ConflictException("成图上传会话已过期");
    const file = session.files[0];
    return (await this.dto({ ...session, files: [file] }, false)).files[0];
  }

  async queueExtract(actorId: string, id: string) {
    const session = await this.find(actorId, id);
    if (
      await this.db.typesetUploadVerification.count({
        where: {
          uploadFile: { sessionId: id },
          status: "processing",
          expiresAt: { gt: new Date() },
        },
      })
    )
      throw new ConflictException("图片正在逐张验证，请稍后重试");
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
      await tx.$queryRaw`SELECT id FROM typeset_upload_sessions WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.typesetUploadSession.findFirst({
        where: { id, actorId },
      });
      if (
        !current ||
        current.expiresAt <= new Date() ||
        current.status === "expired"
      )
        throw new ConflictException("成图上传会话已过期");
      if (
        await tx.typesetUploadVerification.count({
          where: {
            uploadFile: { sessionId: id },
            status: "processing",
            expiresAt: { gt: new Date() },
          },
        })
      )
        throw new ConflictException("图片正在逐张验证，请稍后重试");
      if (current.status === "extracting") return;
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
          // Bound object-storage/DB writes without allowing failed siblings to outlive cleanup.
          for (let offset = 0; offset < group.images.length; offset += 3) {
            signal?.throwIfAborted();
            const stored = await Promise.allSettled(
              group.images
                .slice(offset, offset + 3)
                .map(async (image, localIndex) => {
                  const file = await this.files.store({
                    body: image.body,
                    contentType: image.contentType,
                    bucketScope: "works",
                    kind: "typeset-upload-preview",
                    sourceName: image.sourceName,
                    createdById: actorId,
                  });
                  storedIds.push(file.id);
                  return {
                    sourceName: image.sourceName,
                    fileObjectId: file.id,
                    width: image.width!,
                    height: image.height!,
                    orderIndex: offset + localIndex,
                  };
                }),
            );
            const failure = stored.find(
              (result) => result.status === "rejected",
            );
            if (failure?.status === "rejected") throw failure.reason;
            for (const result of stored)
              if (result.status === "fulfilled") images.push(result.value);
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
          // Only this attempt's settled stores are candidates. Reference guards
          // preserve a completed file even if a later heartbeat/lease check fails.
          for (const fileId of storedIds)
            await this.files.purgeUnreferenced(fileId).catch(() => undefined);
          signal?.throwIfAborted();
          await this.jobs?.assertCurrentLease(this.db);
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
    await this.assertActor(actorId);
    const session = await this.db.typesetUploadSession.findFirst({
      where: { id, actorId },
      select: { id: true, status: true, expiresAt: true },
    });
    if (!session) throw new NotFoundException("成图上传会话不存在");
    if (
      session.status === "expired" ||
      session.expiresAt.getTime() <= Date.now()
    )
      throw new ConflictException("成图上传会话已过期，请重新选择文件");
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
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM works WHERE id = ${work.id}::uuid FOR UPDATE`,
          );
          result.workId = work.id;
          result.title = work.title;
          const currentWork = await this.assertWork(actorId, work.id, tx);
          const existing = await tx.typesetUploadPreview.findUnique({
            where: { sessionId_workId: { sessionId: id, workId: work.id } },
          });
          const submitted =
            existing &&
            (await tx.workEvent.findUnique({
              where: {
                workId_idempotencyKey: {
                  workId: work.id,
                  idempotencyKey: existing.id,
                },
              },
            }));
          if (existing?.versionId || submitted)
            throw new ConflictException(
              "本批次已经为该作品创建成图版本，请勿重复上传",
            );
          let selection: Prisma.InputJsonValue = group.imageIds;
          if (currentWork.collaborationMode === "multi") {
            const participant = await tx.workStageParticipant.findFirst({
              where: {
                workId: work.id,
                stage: "typeset",
                userId: actorId,
                leftAt: null,
              },
              select: { id: true },
            });
            const pages = await tx.workImage.findMany({
              where: { workId: work.id },
              select: { id: true },
            });
            const assignments = await tx.workPageAssignment.findMany({
              where: { workId: work.id, stage: "typeset" },
            });
            const mapped = planTypesetPageMappings(
              images,
              group.pageMappings,
              pages.map((page) => ({
                id: page.id,
                participantId:
                  assignments.find((a) => a.workImageId === page.id)
                    ?.participantId ?? null,
              })),
              participant?.id,
            );
            const currentDrafts = await tx.workTypesetDraft.findMany({
              where: { workId: work.id, participantId: participant!.id },
            });
            if (
              assignments.some(
                (a) =>
                  a.participantId === participant!.id &&
                  !mapped.mappings.some(
                    (m) => m.workImageId === a.workImageId,
                  ) &&
                  !currentDrafts.some(
                    (d) =>
                      d.workImageId === a.workImageId &&
                      d.assignmentGeneration === a.generation,
                  ),
              )
            )
              throw new ConflictException(
                "本人负责页尚有缺图，请补齐对应页后检查提交条件",
              );
            result.ignored = mapped.ignored;
            result.savedImageCount = mapped.mappings.length;
            selection = {
              imageIds: group.imageIds,
              mappings: mapped.mappings,
              ignored: mapped.ignored,
            };
          }
          const data = {
            id: randomUUID(),
            workRevision: currentWork.revision,
            editorEpoch: currentWork.editorEpoch,
            handoffStartedAt: currentWork.typesetHandoffStartedAt!,
            imageIds: selection,
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
    const multiPreview = await this.db.typesetUploadPreview.findFirst({
      where: { id: previewId, sessionId: id },
      include: { work: true },
    });
    if (multiPreview?.work.collaborationMode === "multi") {
      if (!this.collaboration)
        throw new ConflictException("请在作品详情完成多人页映射");
      const selection = multiPreview.imageIds as unknown as {
        mappings?: (BatchPageMapping & { position: "page" })[];
        ignored?: string[];
      };
      if (!selection.mappings?.length)
        throw new ConflictException("旧预览缺少明确页映射，请重新检查提交条件");
      return this.collaboration.apply(
        actorId,
        multiPreview.workId,
        {
          sessionId: id,
          expectedRevision: multiPreview.workRevision,
          expectedEditorEpoch: multiPreview.editorEpoch,
          idempotencyKey: multiPreview.idempotencyKey,
          mappings: selection.mappings,
        },
        {
          previewId,
          submissionKey: multiPreview.id,
          ignored: selection.ignored ?? [],
        },
      );
    }

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
      return {
        workId: work.id,
        versionId,
        stageSubmitted: true,
        workCompleted: true,
      };
    });
  }

  async cleanupExpired() {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      await this.cleanupBatch();
      await this.cleanupVerifications();
    } finally {
      this.cleanupRunning = false;
    }
  }

  private async cleanupVerifications() {
    // Unique keys fence unknown old owners away from all later adopted images.
    // Keep tombstones and repeat deletion after an interrupted/late storage call.
    const before = new Date(Date.now() - 10 * 60_000);
    const retryBefore = new Date(Date.now() - 15 * 60_000);
    const attempts = await this.db.typesetUploadVerification.findMany({
      where: {
        status: { not: "completed" },
        expiresAt: { lt: before },
        OR: [{ cleanedAt: null }, { cleanedAt: { lt: retryBefore } }],
      },
      orderBy: [
        { cleanedAt: { sort: "asc", nulls: "first" } },
        { expiresAt: "asc" },
      ],
      take: 50,
      include: { uploadFile: { select: { sessionId: true } } },
    });
    for (const attempt of attempts) {
      const claimed = await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM typeset_upload_sessions WHERE id=${attempt.uploadFile.sessionId}::uuid FOR UPDATE`;
        return tx.typesetUploadVerification.updateMany({
          where: {
            id: attempt.id,
            status: { not: "completed" },
            expiresAt: { lt: before },
          },
          data: { status: "failed" },
        });
      });
      if (!claimed.count) continue;
      try {
        await this.files.deleteStagingObject(attempt.objectKey);
        await this.db.typesetUploadVerification.updateMany({
          where: { id: attempt.id, status: "failed" },
          data: { cleanedAt: new Date() },
        });
      } catch {
        /* Next bounded sweep retries the same tombstone. */
      }
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
        const draftReferences = await tx.workTypesetDraft.findMany({
          where: { fileObjectId: { in: ids } },
          select: { fileObjectId: true },
        });
        for (const draft of draftReferences) retained.add(draft.fileObjectId);
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
        typesetDrafts: { none: {} },
      },
      select: { id: true },
      take: 100,
    });
    for (const file of retryFiles)
      await this.files.purgeUnreferenced(file.id).catch(() => undefined);
  }
}
