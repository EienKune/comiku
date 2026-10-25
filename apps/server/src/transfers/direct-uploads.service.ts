import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import {
  type DirectUploadSession,
  type DirectUploadPurpose,
  type Prisma,
} from "../generated/prisma/client.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";
import type {
  CreateDirectUploadDto,
  DirectUploadDto,
} from "./transfers.dto.js";
import { inspectImage } from "../files/image-inspection.js";

type ManifestFile = {
  key: string;
  sourceName: string;
  contentType: string;
  size: number;
  checksum: string;
};
export type DirectUploadHandler = (
  session: DirectUploadSession,
  files: ManualUploadFile[],
  signal: AbortSignal,
) => Promise<unknown>;

@Injectable()
export class DirectUploadsService {
  private readonly activeLease = new AsyncLocalStorage<{
    id: string;
    leaseId: string;
  }>();
  private handlers = new Map<DirectUploadPurpose, DirectUploadHandler>();
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  register(purpose: DirectUploadPurpose, handler: DirectUploadHandler) {
    this.handlers.set(purpose, handler);
    this.jobs.register(`direct_${purpose}`, async (job, signal) => {
      const session = await this.db.directUploadSession.findUnique({
        where: { id: job.resourceId },
      });
      if (!session || session.status === "completed") return;
      try {
        await this.assertActor(session.actorId, purpose);
        if (session.expiresAt <= new Date())
          throw new ConflictException("上传会话已过期，请重新选择文件");
        await this.db.directUploadSession.update({
          where: { id: session.id },
          data: { status: "processing", error: null },
        });
        const uploads: ManualUploadFile[] = [];
        for (const file of session.manifest as unknown as ManifestFile[]) {
          signal.throwIfAborted();
          const head = await this.files.headStagingObject(file.key);
          if (
            !head ||
            head.size !== file.size ||
            head.contentType !== file.contentType ||
            head.checksum !== file.checksum
          )
            throw new BadRequestException(
              "文件大小、类型或校验值与上传会话不一致",
            );
          const body = await this.files.readStagingObject(file.key);
          if (
            body.byteLength !== file.size ||
            createHash("sha256").update(body).digest("hex") !== file.checksum
          )
            throw new BadRequestException("上传内容校验失败");
          const image = inspectImage(file.sourceName, body);
          if (image.contentType !== file.contentType)
            throw new BadRequestException("图片实际格式与声明类型不一致");
          uploads.push({
            originalname: file.sourceName,
            mimetype: file.contentType,
            size: body.byteLength,
            buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
          });
        }
        signal.throwIfAborted();
        await this.activeLease.run({ id: job.id, leaseId: job.leaseId! }, () =>
          handler(session, uploads, signal),
        );
        if (
          (
            await this.db.directUploadSession.findUniqueOrThrow({
              where: { id: session.id },
            })
          ).status !== "completed"
        )
          throw new Error("Upload adoption must commit with session");
        for (const file of session.manifest as unknown as ManifestFile[])
          await this.files.deleteStagingObject(file.key).catch(() => {});
      } catch (error) {
        if (
          !(await this.db.backgroundJob.count({
            where: {
              id: job.id,
              leaseId: job.leaseId,
              status: "running",
              leaseUntil: { gt: new Date() },
            },
          }))
        )
          throw error;
        if (
          (
            await this.db.directUploadSession.findUnique({
              where: { id: session.id },
            })
          )?.status === "completed"
        )
          return;
        const terminal = error instanceof HttpException || job.attempts >= 3;
        await this.db.directUploadSession.update({
          where: { id: session.id },
          data: {
            status: terminal ? "failed" : "queued",
            error:
              error instanceof HttpException
                ? error.message
                : "后台上传处理未完成，请稍后重试",
          },
        });
        if (!terminal) throw error;
      }
    });
  }

  private async assertActor(actorId: string, purpose: DirectUploadPurpose) {
    const roles =
      purpose === "typeset_single"
        ? ["typesetter" as const]
        : ["source" as const, "admin" as const];
    if (
      !(await this.db.user.count({
        where: {
          id: actorId,
          isActive: true,
          mustChangePassword: false,
          roles: { some: { role: { in: roles } } },
        },
      }))
    )
      throw new ForbiddenException("当前职务无权完成该用途上传");
  }

  async create(
    actorId: string,
    input: CreateDirectUploadDto,
  ): Promise<DirectUploadDto> {
    await this.assertActor(actorId, input.purpose);
    if (input.purpose === "typeset_single") {
      const work = await this.db.work.findFirst({
        where: {
          id: input.resourceId,
          revision: input.expectedRevision,
          reviewStatus: "normal",
          workflowStatus: "typesetting",
          typesetHandoffStartedAt: { not: null },
          stageParticipants: {
            some: {
              userId: actorId,
              stage: "typeset",
              leftAt: null,
              submittedAt: null,
            },
          },
        },
        select: { id: true },
      });
      if (!work)
        throw new ConflictException("请确认已认领、取得交接包且作品基线有效");
    } else if (
      !(await this.db.author.count({
        where: {
          id: input.resourceId,
          deletedAt: null,
          revision: input.expectedRevision,
        },
      }))
    )
      throw new ConflictException("作者已更新或不存在，请刷新后重试");
    const count =
      input.purpose === "author_avatar"
        ? 1
        : input.purpose === "author_evidence"
          ? 10
          : 100;
    const max =
      (input.purpose === "author_avatar"
        ? 5
        : input.purpose === "author_evidence"
          ? 10
          : 25) *
      1024 *
      1024;
    if (
      input.files.length > count ||
      input.files.some(
        (file) =>
          file.size > max ||
          !["image/png", "image/jpeg", "image/webp"].includes(file.contentType),
      )
    )
      throw new BadRequestException("文件格式、数量或容量超过当前用途上限");
    if (
      input.files.reduce((sum, file) => sum + file.size, 0) >
      250 * 1024 * 1024
    )
      throw new BadRequestException("单个上传会话不能超过 250 MiB");
    const id = randomUUID();
    const manifest = input.files.map((file, index) => ({
      ...file,
      checksum: file.checksum.toLowerCase(),
      key: `staging/direct-upload/${input.purpose}/${id}/${index}`,
    }));
    const session = await this.db.directUploadSession.create({
      data: {
        id,
        actorId,
        resourceId: input.resourceId,
        purpose: input.purpose,
        expectedRevision: input.expectedRevision,
        options: {
          note: input.note ?? null,
          mode: input.mode ?? "new_version",
          sourceImageIds: input.sourceImageIds ?? "",
        },
        manifest,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    return this.dto(session);
  }

  async get(actorId: string, id: string) {
    let session = await this.find(actorId, id);
    if (
      ["queued", "processing"].includes(session.status) &&
      (await this.db.backgroundJob.count({
        where: { resourceId: id, status: "failed" },
      }))
    )
      session = await this.db.directUploadSession.update({
        where: { id },
        data: { status: "failed", error: "处理重试次数已用尽，请重新选择文件" },
      });
    return this.dto(session);
  }
  async cleanupExpired() {
    const sessions = await this.db.directUploadSession.findMany({
      where: { expiresAt: { lt: new Date() } },
      take: 100,
    });
    for (const session of sessions) {
      if (
        await this.db.backgroundJob.count({
          where: {
            resourceId: session.id,
            status: "running",
            leaseUntil: { gt: new Date() },
          },
        })
      )
        continue;
      for (const file of session.manifest as unknown as ManifestFile[])
        await this.files.deleteStagingObject(file.key);
      await this.db.directUploadSession.delete({ where: { id: session.id } });
    }
  }
  private async find(actorId: string, id: string) {
    const session = await this.db.directUploadSession.findFirst({
      where: { id, actorId },
    });
    if (!session) throw new NotFoundException("上传会话不存在");
    await this.assertActor(actorId, session.purpose);
    return session;
  }
  async finalize(actorId: string, id: string) {
    const session = await this.find(actorId, id);
    if (
      session.status === "completed" ||
      ["queued", "processing"].includes(session.status)
    )
      return this.dto(session);
    if (session.status !== "pending" || session.expiresAt <= new Date())
      throw new ConflictException("上传会话不可确认，请重新选择文件");
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.directUploadSession.updateMany({
        where: { id, actorId, status: "pending" },
        data: { status: "queued" },
      });
      if (claimed.count)
        await this.jobs.enqueue(
          {
            kind: `direct_${session.purpose}`,
            resourceId: id,
            actorId,
            idempotencyKey: `direct:${id}`,
          },
          tx,
        );
    });
    return this.get(actorId, id);
  }
  private async dto(session: DirectUploadSession): Promise<DirectUploadDto> {
    const canUpload =
      session.status === "pending" && session.expiresAt > new Date();
    return {
      id: session.id,
      status: session.status,
      error: session.error,
      expiresAt: session.expiresAt.toISOString(),
      files: await Promise.all(
        (session.manifest as unknown as ManifestFile[]).map(async (file) => {
          const upload = canUpload
            ? await this.files.signedStagingWriteUrl(
                {
                  key: file.key,
                  size: file.size,
                  contentType: file.contentType,
                  checksum: file.checksum,
                },
                900,
              )
            : null;
          return {
            sourceName: file.sourceName,
            upload: upload
              ? {
                  ...upload,
                  method: "PUT",
                  expiresAt: new Date(
                    Date.now() + upload.expiresInSeconds * 1_000,
                  ).toISOString(),
                }
              : null,
          };
        }),
      ),
    };
  }
  async completeTx(
    tx: Prisma.TransactionClient,
    id: string,
    result: Prisma.InputJsonValue,
  ) {
    const lease = this.activeLease.getStore();
    if (
      !lease ||
      !(await tx.backgroundJob.count({
        where: {
          id: lease.id,
          leaseId: lease.leaseId,
          status: "running",
          leaseUntil: { gt: new Date() },
        },
      }))
    )
      throw new ConflictException("后台处理租约已变化，请刷新上传结果");
    await tx.directUploadSession.update({
      where: { id },
      data: { status: "completed", result, error: null },
    });
  }
}
