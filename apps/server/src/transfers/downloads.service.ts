import { cleanupExpiredExportDirectories } from "../typesetting/handoff-package.js";
import { DirectUploadsService } from "./direct-uploads.service.js";
import {
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
  type DownloadPreparation,
  type DownloadPurpose,
  type Prisma,
} from "../generated/prisma/client.js";
import type {
  PrepareDownloadDto,
  DownloadPreparationDto,
  DownloadDeliveryDto,
} from "./transfers.dto.js";

export type DownloadTask = DownloadPreparation & {
  requireCurrentParticipation: boolean;
};
type Prepared = { fileObjectId: string; fileName: string; packageId?: string };
type Handler = {
  prepare: (task: DownloadTask, signal: AbortSignal) => Promise<Prepared>;
  deliver: (task: DownloadTask) => Promise<DownloadDeliveryDto>;
};

@Injectable()
export class DownloadsService {
  private handlers = new Map<DownloadPurpose, Handler>();
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(DirectUploadsService)
    private readonly uploads: DirectUploadsService,
  ) {}
  onModuleInit() {
    this.jobs.register("transfer_cleanup", async () => {
      await this.uploads.cleanupExpired();
      await cleanupExpiredExportDirectories();
      const expired = await this.db.downloadPreparation.findMany({
        where: { expiresAt: { lt: new Date() } },
        take: 100,
      });
      for (const task of expired) {
        if (
          await this.db.backgroundJob.count({
            where: {
              resourceId: task.id,
              status: "running",
              leaseUntil: { gt: new Date() },
            },
          })
        )
          continue;
        await this.db.downloadPreparation.delete({ where: { id: task.id } });
      }
      // Handoff packages are durable workflow history; only disposable publication caches expire.
      const orphans = await this.db.fileObject.findMany({
        where: {
          kind: "publication-package",
          createdAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) },
          downloadPreparations: { none: {} },
        },
        take: 100,
      });
      for (const file of orphans) await this.files.purgeUnreferenced(file.id);
    });
  }
  async scheduleCleanup() {
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.workerSchedule.createMany({
        data: { name: "transfer-cleanup", dueAt: now },
        skipDuplicates: true,
      });
      const claimed = await tx.workerSchedule.updateMany({
        where: { name: "transfer-cleanup", dueAt: { lte: now } },
        data: { dueAt: new Date(now.getTime() + 15 * 60_000) },
      });
      if (claimed.count) {
        await this.jobs.enqueue(
          {
            kind: "transfer_cleanup",
            resourceId: "00000000-0000-0000-0000-000000000004",
            idempotencyKey: `transfer-cleanup:${now.toISOString()}`,
            priority: 1,
          },
          tx,
        );
        if (claimed.count)
          for (const kind of [
            "candidate_upload_cleanup",
            "typeset_upload_cleanup",
          ])
            await this.jobs.enqueue(
              {
                kind,
                resourceId: "00000000-0000-0000-0000-000000000004",
                idempotencyKey: `${kind}:${now.toISOString()}`,
                priority: 1,
              },
              tx,
            );
      }
    });
  }

  register(purpose: DownloadPurpose, handler: Handler) {
    this.handlers.set(purpose, handler);
    this.jobs.register(`download_${purpose}`, async (job, signal) => {
      const task = await this.db.downloadPreparation.findUnique({
        where: { id: job.resourceId },
      });
      if (!task || task.status === "succeeded") return;
      try {
        await this.assertActor(task.actorId, purpose);
        await this.db.downloadPreparation.update({
          where: { id: task.id },
          data: { status: "running", error: null },
        });
        const result = await handler.prepare(
          {
            ...task,
            requireCurrentParticipation:
              (job.payload as { requireCurrentParticipation?: boolean })
                .requireCurrentParticipation !== false,
          },
          signal,
        );
        signal.throwIfAborted();
        await this.db.$transaction(async (tx) => {
          if (
            !(await tx.backgroundJob.count({
              where: {
                id: job.id,
                leaseId: job.leaseId,
                status: "running",
                leaseUntil: { gt: new Date() },
              },
            }))
          )
            throw new ConflictException("后台生成租约已变化，请重新生成");
          await this.assertActor(task.actorId, purpose, tx);
          const work = await tx.work.findFirst({
            where: {
              id: task.workId,
              revision: task.expectedRevision,
              editorEpoch: task.expectedEditorEpoch,
              reviewStatus: "normal",
              workflowStatus: {
                in:
                  purpose === "handoff"
                    ? ["pending_typeset", "typesetting"]
                    : ["pending_publish", "published"],
              },
            },
          });
          if (!work)
            throw new ConflictException("生成期间作品已变化，请重新生成");
          if (
            purpose === "handoff" &&
            (job.payload as { requireCurrentParticipation?: boolean })
              .requireCurrentParticipation !== false &&
            !(await tx.workStageParticipant.count({
              where: {
                workId: task.workId,
                userId: task.actorId,
                stage: "typeset",
                leftAt: null,
                submittedAt: null,
              },
            }))
          )
            throw new ForbiddenException("需要认领当前嵌字任务");
          await tx.downloadPreparation.update({
            where: { id: task.id },
            data: { ...result, status: "succeeded" },
          });
        });
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
        const terminal = error instanceof HttpException || job.attempts >= 3;
        await this.db.downloadPreparation.update({
          where: { id: task.id },
          data: {
            status: terminal ? "failed" : "queued",
            error:
              error instanceof HttpException
                ? error.message
                : "后台生成未完成，请稍后重试",
          },
        });
        if (!terminal) throw error;
      }
    });
  }
  private async assertActor(
    actorId: string,
    purpose: DownloadPurpose,
    db: Prisma.TransactionClient = this.db,
  ) {
    const roles =
      purpose === "handoff"
        ? [
            "typesetter" as const,
            "admin" as const,
            "source" as const,
            "reviewer" as const,
            "translator" as const,
            "proofreader" as const,
          ]
        : [
            "operator" as const,
            "admin" as const,
            "reviewer" as const,
            "typesetter" as const,
          ];
    if (
      !(await db.user.count({
        where: {
          id: actorId,
          isActive: true,
          mustChangePassword: false,
          roles: { some: { role: { in: roles } } },
        },
      }))
    )
      throw new ForbiddenException("当前职务不能取得该用途文件");
  }
  async prepare(actorId: string, input: PrepareDownloadDto) {
    await this.assertActor(actorId, input.purpose);
    const task = await this.db.$transaction(async (tx) => {
      await tx.downloadPreparation.createMany({
        data: {
          actorId,
          purpose: input.purpose,
          workId: input.workId,
          expectedRevision: input.expectedRevision,
          expectedEditorEpoch: input.expectedEditorEpoch,
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
        skipDuplicates: true,
      });
      const current = await tx.downloadPreparation.findUniqueOrThrow({
        where: {
          actorId_idempotencyKey: {
            actorId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (current.purpose !== input.purpose || current.workId !== input.workId)
        throw new ConflictException("该幂等标识已用于其他下载");
      await this.jobs.enqueue(
        {
          kind: `download_${input.purpose}`,
          resourceId: current.id,
          actorId,
          idempotencyKey: `download:${current.id}`,
          payload: {
            requireCurrentParticipation:
              input.requireCurrentParticipation !== false,
          },
        },
        tx,
      );
      return current;
    });
    return this.dto(task);
  }
  private async find(actorId: string, id: string) {
    const task = await this.db.downloadPreparation.findFirst({
      where: { id, actorId },
    });
    if (!task) throw new NotFoundException("下载任务不存在");
    await this.assertActor(actorId, task.purpose);
    return task;
  }
  async get(actorId: string, id: string): Promise<DownloadPreparationDto> {
    const task = await this.find(actorId, id);
    if (
      ["queued", "running"].includes(task.status) &&
      (await this.db.backgroundJob.count({
        where: { resourceId: id, status: "failed" },
      }))
    ) {
      return this.dto(
        await this.db.downloadPreparation.update({
          where: { id },
          data: { status: "failed", error: "生成重试次数已用尽，请重新生成" },
        }),
      );
    }
    return this.dto(task);
  }
  async deliver(actorId: string, id: string) {
    const task = await this.find(actorId, id);
    if (task.status !== "succeeded" || task.expiresAt <= new Date())
      throw new ConflictException("文件尚未生成或下载会话已过期，请重新生成");
    const job = await this.db.backgroundJob.findUniqueOrThrow({
      where: { idempotencyKey: `download:${id}` },
    });
    return this.handlers.get(task.purpose)!.deliver({
      ...task,
      requireCurrentParticipation:
        (job.payload as { requireCurrentParticipation?: boolean })
          .requireCurrentParticipation !== false,
    });
  }
  private dto(task: DownloadPreparation): DownloadPreparationDto {
    return {
      id: task.id,
      status: task.status,
      fileName: task.fileName,
      error: task.error,
    };
  }
  async signedFile(task: DownloadPreparation) {
    if (!task.fileObjectId || !task.fileName)
      throw new NotFoundException("文件尚未生成");
    return {
      ...(await this.files.signedDownloadUrl(task.fileObjectId, task.fileName)),
      fileName: task.fileName,
    };
  }
}
