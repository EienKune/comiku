import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import {
  type BackgroundJob,
  type Prisma,
  JobLane,
} from "../generated/prisma/client.js";

export type JobHandler = (
  job: BackgroundJob,
  signal: AbortSignal,
) => Promise<void>;
export const JOB_LEASE_MS = 60_000;
export function retryDelay(attempt: number): number {
  return Math.min(300_000, 5_000 * 2 ** (attempt - 1));
}

@Injectable()
export class JobsService {
  private readonly leaseContext = new AsyncLocalStorage<BackgroundJob>();
  private handlers = new Map<string, JobHandler>();
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  register(kind: string, handler: JobHandler) {
    if (this.handlers.has(kind))
      throw new Error("Duplicate background handler");
    this.handlers.set(kind, handler);
  }

  async enqueue(
    input: {
      kind: string;
      resourceId: string;
      actorId?: string | null;
      idempotencyKey: string;
      lane?: JobLane;
      priority?: number;
      payload?: Prisma.InputJsonValue;
    },
    db: Prisma.TransactionClient | PrismaService = this.db,
  ) {
    await db.backgroundJob.createMany({
      data: {
        ...input,
        lane: input.lane ?? "heavy",
        payload: input.payload ?? {},
      },
      skipDuplicates: true,
    });
    return db.backgroundJob.findUniqueOrThrow({
      where: { idempotencyKey: input.idempotencyKey },
    });
  }

  /** Advisory transaction lock serializes claims across processes; one live job per global lane. */
  async claim(lane: JobLane, now = new Date()): Promise<BackgroundJob | null> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comiku:jobs:${lane}`}))`;
      await tx.backgroundJob.updateMany({
        where: { lane, status: "running", leaseUntil: { lte: now } },
        data: {
          status: "queued",
          leaseId: null,
          leaseUntil: null,
          availableAt: now,
          lastError: "执行租约过期，已排队恢复",
        },
      });
      if (
        await tx.backgroundJob.count({
          where: { lane, status: "running", leaseUntil: { gt: now } },
        })
      )
        return null;
      await tx.backgroundJob.updateMany({
        where: { lane, status: "queued", attempts: { gte: 3 } },
        data: {
          status: "failed",
          completedAt: now,
          lastError: "重试次数已用尽",
        },
      });
      let next = await tx.backgroundJob.findFirst({
        where: {
          lane,
          status: "queued",
          availableAt: { lte: now },
          kind: { in: [...this.handlers.keys()] },
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      const aged = await tx.backgroundJob.findFirst({
        where: {
          lane,
          status: "queued",
          availableAt: { lte: now },
          kind: { in: [...this.handlers.keys()] },
          createdAt: { lte: new Date(now.getTime() - 10 * 60_000) },
        },
        orderBy: { createdAt: "asc" },
      });
      if (aged) next = aged;
      if (!next) return null;
      return tx.backgroundJob.update({
        where: { id: next.id },
        data: {
          status: "running",
          leaseId: randomUUID(),
          leaseUntil: new Date(now.getTime() + JOB_LEASE_MS),
          attempts: { increment: 1 },
          startedAt: now,
        },
      });
    });
  }

  async execute(job: BackgroundJob, stopping?: AbortSignal) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    stopping?.addEventListener("abort", stop, { once: true });
    if (stopping?.aborted) stop();
    const heartbeat = setInterval(() => {
      void this.db.backgroundJob
        .updateMany({
          where: { id: job.id, status: "running", leaseId: job.leaseId },
          data: { leaseUntil: new Date(Date.now() + JOB_LEASE_MS) },
        })
        .then((result) => {
          if (!result.count) controller.abort();
        })
        .catch(() => controller.abort());
    }, 15_000);
    try {
      controller.signal.throwIfAborted();
      await this.leaseContext.run(job, () =>
        this.handlers.get(job.kind)!(job, controller.signal),
      );
      controller.signal.throwIfAborted();
      await this.db.backgroundJob.updateMany({
        where: { id: job.id, leaseId: job.leaseId, status: "running" },
        data: {
          status: "succeeded",
          leaseId: null,
          leaseUntil: null,
          completedAt: new Date(),
          lastError: null,
        },
      });
    } catch {
      await this.db.backgroundJob.updateMany({
        where: { id: job.id, leaseId: job.leaseId, status: "running" },
        data: {
          status: job.attempts >= 3 ? "failed" : "queued",
          availableAt: new Date(Date.now() + retryDelay(job.attempts)),
          leaseId: null,
          leaseUntil: null,
          lastError: "后台处理未完成，请检查资源权限或配置后重试",
          ...(job.attempts >= 3 ? { completedAt: new Date() } : {}),
        },
      });
    } finally {
      clearInterval(heartbeat);
      stopping?.removeEventListener("abort", stop);
    }
  }

  async assertCurrentLease(tx: Prisma.TransactionClient) {
    const job = this.leaseContext.getStore();
    if (
      job &&
      !(await tx.backgroundJob.count({
        where: {
          id: job.id,
          leaseId: job.leaseId,
          status: "running",
          leaseUntil: { gt: new Date() },
        },
      }))
    )
      throw new ConflictException("后台任务租约已变化");
  }

  async runNext(lane: JobLane, stopping?: AbortSignal) {
    const job = await this.claim(lane);
    if (!job) return false;
    await this.execute(job, stopping);
    return true;
  }
}
