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
  type BackgroundJob,
  type DirectUploadSession,
  type DirectUploadPurpose,
  type Prisma,
} from "../generated/prisma/client.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";
import type {
  CreateDirectUploadDto,
  DirectUploadDto,
} from "./transfers.dto.js";
import {
  DIRECT_UPLOAD_WINDOW_MS,
  DIRECT_UPLOAD_RECEIPT_MS,
  DIRECT_UPLOAD_WRITE_GRACE_MS,
  terminalUpload,
  recoverableDirectUploadJob,
  directUploadGrantSeconds,
} from "./direct-upload-policy.js";
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
      const session = await this.db.$transaction(async (tx) => {
        await this.jobs.assertLease(tx, { id: job.id, leaseId: job.leaseId });
        await this.lockSession(tx, job.resourceId);
        const current = await tx.directUploadSession.findUnique({
          where: { id: job.resourceId },
        });
        if (!current || terminalUpload(current.status)) return null;
        if (!recoverableDirectUploadJob(current, job, new Date()))
          throw new ConflictException("上传任务身份不一致");
        if (!["queued", "processing"].includes(current.status))
          throw new ConflictException("上传会话尚未确认");
        return tx.directUploadSession.update({
          where: { id: current.id },
          data: { status: "processing", error: null },
        });
      });
      if (!session) return;
      try {
        await this.assertActor(session.actorId, purpose);
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
      } catch (error) {
        const terminal = error instanceof HttpException || job.attempts >= 3;
        const changed = await this.db.$transaction(async (tx) => {
          await this.jobs.assertLease(tx, { id: job.id, leaseId: job.leaseId });
          await this.lockSession(tx, session.id);
          const current = await tx.directUploadSession.findUnique({
            where: { id: session.id },
          });
          if (!current || terminalUpload(current.status)) return false;
          await tx.directUploadSession.update({
            where: { id: session.id },
            data: {
              status: terminal ? "failed" : "queued",
              terminalAt: terminal ? new Date() : null,
              error:
                error instanceof HttpException
                  ? error.message
                  : "后台上传处理未完成，请稍后重试",
            },
          });
          return true;
        });
        if (changed && !terminal) throw error;
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
        expiresAt: new Date(Date.now() + DIRECT_UPLOAD_WINDOW_MS),
      },
    });
    return this.dto(session);
  }

  private async lockSession(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM direct_upload_sessions WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /** Never lock an existing job after its session: retry from the job if finalization won. */
  private async withSession<T>(
    id: string,
    operation: (
      tx: Prisma.TransactionClient,
      session: DirectUploadSession | null,
      job: BackgroundJob | null,
    ) => Promise<T>,
  ): Promise<T> {
    const retry = Symbol("upload job appeared");
    for (let attempt = 0; attempt < 3; attempt++) {
      const known = await this.db.backgroundJob.findUnique({
        where: { idempotencyKey: `direct:${id}` },
      });
      try {
        return await this.db.$transaction(async (tx) => {
          if (known)
            await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${known.id}::uuid FOR UPDATE`;
          await this.lockSession(tx, id);
          const job = await tx.backgroundJob.findUnique({
            where: { idempotencyKey: `direct:${id}` },
          });
          if (job && job.id !== known?.id) throw retry;
          return operation(
            tx,
            await tx.directUploadSession.findUnique({ where: { id } }),
            job,
          );
        });
      } catch (error) {
        if (error !== retry) throw error;
      }
    }
    throw new ConflictException("上传状态已变化，请重试");
  }

  private async reconcile(
    tx: Prisma.TransactionClient,
    session: DirectUploadSession,
    job: BackgroundJob | null,
    now: Date,
  ) {
    if (terminalUpload(session.status)) return session;
    const pendingExpired =
      session.status === "pending" && session.expiresAt <= now;
    const orphaned =
      ["queued", "processing"].includes(session.status) &&
      !recoverableDirectUploadJob(session, job, now);
    if (!pendingExpired && !orphaned) return session;
    return tx.directUploadSession.update({
      where: { id: session.id },
      data: {
        status: pendingExpired ? "expired" : "failed",
        terminalAt: now,
        error: pendingExpired
          ? "上传会话已过期，请重新选择文件"
          : "后台处理已中断或重试次数已用尽，请重新选择文件",
      },
    });
  }

  async get(actorId: string, id: string) {
    await this.find(actorId, id);
    const session = await this.withSession(id, async (tx, current, job) => {
      if (!current || current.actorId !== actorId)
        throw new NotFoundException("上传会话不存在");
      return this.reconcile(tx, current, job, new Date());
    });
    return this.dto(session);
  }

  async cleanupExpired() {
    const now = new Date();
    // Indexed job identity excludes protected jobs before LIMIT, so long queues cannot starve cleanup.
    const expired = await this.db.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM direct_upload_sessions s WHERE s.terminal_at IS NULL AND s.expires_at <= ${now}
      AND NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.idempotency_key = 'direct:' || s.id::text
        AND j.resource_id = s.id AND j.actor_id = s.actor_id AND j.kind = 'direct_' || s.purpose::text
        AND ((j.status = 'queued' AND j.attempts < 3) OR (j.status = 'running' AND j.lease_until IS NOT NULL AND (j.lease_until > ${now} OR j.attempts < 3))))
      ORDER BY s.expires_at, s.id LIMIT 100`;
    for (const { id } of expired)
      await this.withSession(id, async (tx, current, job) => {
        if (current) await this.reconcile(tx, current, job, new Date());
      });
    const batches = [
      await this.db.directUploadSession.findMany({
        where: {
          terminalAt: {
            lte: new Date(now.getTime() - DIRECT_UPLOAD_WRITE_GRACE_MS),
          },
          stagingCleanedAt: null,
        },
        orderBy: [{ terminalAt: "asc" }, { id: "asc" }],
        take: 100,
      }),
      await this.db.directUploadSession.findMany({
        where: {
          terminalAt: {
            lte: new Date(now.getTime() - DIRECT_UPLOAD_RECEIPT_MS),
          },
          stagingCleanedAt: { not: null },
        },
        orderBy: [{ terminalAt: "asc" }, { id: "asc" }],
        take: 100,
      }),
    ];
    const failures: unknown[] = [];
    for (const [phase, sessions] of batches.entries())
      for (const session of sessions) {
        try {
          if (!terminalUpload(session.status)) continue;
          // Terminal states cannot be adopted. Network work stays outside transactions; retry is idempotent.
          const keys = (session.manifest as unknown as { key: string }[]).map(
            ({ key }) => ({ key }),
          );
          for (const { key } of keys) await this.files.deleteStagingObject(key);
          const where = {
            id: session.id,
            status: session.status,
            terminalAt: session.terminalAt,
            stagingCleanedAt: session.stagingCleanedAt,
          };
          if (phase === 0)
            await this.db.directUploadSession.updateMany({
              where,
              data: { stagingCleanedAt: new Date(), manifest: keys },
            });
          else await this.db.directUploadSession.deleteMany({ where });
        } catch (error) {
          failures.push(error);
        }
      }
    if (failures.length) throw failures[0];
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
    await this.find(actorId, id);
    const session = await this.withSession(id, async (tx, current, job) => {
      if (!current || current.actorId !== actorId)
        throw new NotFoundException("上传会话不存在");
      if (
        current.status === "completed" ||
        ["queued", "processing"].includes(current.status)
      )
        return this.reconcile(tx, current, job, new Date());
      // Clock is sampled after the row lock, not before waiting for a peer.
      if (current.status !== "pending" || current.expiresAt <= new Date())
        throw new ConflictException("上传会话不可确认，请重新选择文件");
      if (job) throw new ConflictException("上传任务状态不一致，请刷新结果");
      const updated = await tx.directUploadSession.update({
        where: { id },
        data: { status: "queued" },
      });
      await this.jobs.enqueue(
        {
          kind: `direct_${current.purpose}`,
          resourceId: id,
          actorId,
          idempotencyKey: `direct:${id}`,
        },
        tx,
      );
      return updated;
    });
    return this.dto(session);
  }
  private async dto(session: DirectUploadSession): Promise<DirectUploadDto> {
    const grant =
      session.status === "pending"
        ? directUploadGrantSeconds(session.expiresAt, new Date())
        : 0;
    return {
      id: session.id,
      status: session.status,
      error: session.error,
      expiresAt: session.expiresAt.toISOString(),
      files: await Promise.all(
        (terminalUpload(session.status)
          ? []
          : (session.manifest as unknown as ManifestFile[])
        ).map(async (file) => {
          const upload =
            grant > 0
              ? await this.files.signedStagingWriteUrl(
                  {
                    key: file.key,
                    size: file.size,
                    contentType: file.contentType,
                    checksum: file.checksum,
                  },
                  grant,
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
  /** First statement in every adoption transaction, before actor/resource locks. */
  async assertAdoptionLeaseTx(tx: Prisma.TransactionClient, id: string) {
    const lease = this.activeLease.getStore();
    if (!lease) throw new ConflictException("后台上传处理租约不存在");
    await this.jobs.assertLease(tx, lease);
    const job = await tx.backgroundJob.findUniqueOrThrow({
      where: { id: lease.id },
    });
    const session = await tx.directUploadSession.findUnique({ where: { id } });
    if (
      !session ||
      !recoverableDirectUploadJob(session, job, new Date()) ||
      !["queued", "processing"].includes(session.status)
    )
      throw new ConflictException("后台上传任务或会话已变化");
  }

  async completeTx(
    tx: Prisma.TransactionClient,
    id: string,
    result: Prisma.InputJsonValue,
  ) {
    if (!this.activeLease.getStore())
      throw new ConflictException("后台上传处理租约不存在");
    await this.lockSession(tx, id);
    const updated = await tx.directUploadSession.updateMany({
      where: { id, status: { in: ["queued", "processing"] }, terminalAt: null },
      data: {
        status: "completed",
        terminalAt: new Date(),
        result,
        error: null,
      },
    });
    if (!updated.count)
      throw new ConflictException("上传会话已变化，请刷新结果");
  }
}
