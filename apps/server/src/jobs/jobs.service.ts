import { jobEvent } from "./job-events.js";
import { selectQueue, type QueuePolicy } from "./queue-policy.js";
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
export type JobDeferredReason =
  "capacity" | "credential_unavailable" | "platform_cooldown" | "scope_paused";
export class JobDeferred extends Error {
  constructor(
    readonly retryAt: Date,
    readonly reason: JobDeferredReason,
  ) {
    super("Background job deferred");
    if (!Number.isFinite(retryAt.getTime()))
      throw new Error("Invalid retry time");
    if (
      ![
        "capacity",
        "credential_unavailable",
        "platform_cooldown",
        "scope_paused",
      ].includes(reason)
    )
      throw new Error("Invalid deferred reason");
  }
}
function deferredRetryAt(deferred: JobDeferred, now = new Date()): Date {
  return new Date(Math.max(deferred.retryAt.getTime(), now.getTime() + 5000));
}
/** Runs under job row lock: DB validation/pinning only, never network work. */
export type JobClaimGate = (
  job: BackgroundJob,
  tx: Prisma.TransactionClient,
  now: Date,
) => Promise<void | JobDeferred>;
export function retryDelay(attempt: number): number {
  return Math.min(300_000, 5_000 * 2 ** (attempt - 1));
}

@Injectable()
export class JobsService {
  private readonly leaseContext = new AsyncLocalStorage<BackgroundJob>();
  private handlers = new Map<string, JobHandler>();
  private gates = new Map<string, JobClaimGate>();
  private policies = new Map<string, QueuePolicy>();

  registerClaimGate(kind: string, gate: JobClaimGate) {
    if (this.gates.has(kind)) throw new Error("Duplicate job claim gate");
    this.gates.set(kind, gate);
  }

  registerQueuePolicy(lane: JobLane, scope: string, policy: QueuePolicy) {
    if (
      !Number.isInteger(policy.primaryWeight) ||
      policy.primaryWeight < 1 ||
      policy.primary === policy.secondary
    )
      throw new Error("Invalid queue policy");
    const key = JSON.stringify([lane, scope]);
    if (this.policies.has(key)) throw new Error("Duplicate queue policy");
    this.policies.set(key, Object.freeze({ ...policy }));
  }
  /** Read-only log correlation; never expose job payload or mutable lease state. */
  diagnosticContext(): Readonly<{ jobId?: string; attempt?: number }> {
    const job = this.leaseContext.getStore();
    return Object.freeze(job ? { jobId: job.id, attempt: job.attempts } : {});
  }
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
      executionScope?: string;
      queueName?: string;
      priority?: number;
      payload?: Prisma.InputJsonValue;
    },
    db: Prisma.TransactionClient | PrismaService = this.db,
  ) {
    await db.backgroundJob.createMany({
      data: {
        ...input,
        lane: input.lane ?? "heavy",
        executionScope: input.executionScope ?? "global",
        queueName: input.queueName ?? "default",
        payload: input.payload ?? {},
      },
      skipDuplicates: true,
    });
    return db.backgroundJob.findUniqueOrThrow({
      where: { idempotencyKey: input.idempotencyKey },
    });
  }

  /** Scope lock serializes claims across processes; gates run before consuming an attempt. */
  async lockScope(tx: Prisma.TransactionClient, lane: JobLane, scope: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify(["comiku:jobs", lane, scope])}))`;
  }

  async claim(
    lane: JobLane,
    now = new Date(),
    executionScope = "global",
  ): Promise<BackgroundJob | null> {
    let deferredEvent: ReturnType<typeof jobEvent> | undefined;
    const claimed = await this.db.$transaction(async (tx) => {
      await this.lockScope(tx, lane, executionScope);
      await tx.backgroundJob.updateMany({
        where: {
          lane,
          executionScope,
          status: "running",
          leaseUntil: { lte: now },
        },
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
          where: {
            lane,
            executionScope,
            status: "running",
            leaseUntil: { gt: now },
          },
        })
      )
        return null;
      await tx.backgroundJob.updateMany({
        where: { lane, executionScope, status: "queued", attempts: { gte: 3 } },
        data: {
          status: "failed",
          completedAt: now,
          lastError: "重试次数已用尽",
        },
      });
      const eligible = {
        lane,
        executionScope,
        status: "queued" as const,
        availableAt: { lte: now },
        kind: { in: [...this.handlers.keys()] },
      };
      const policy = this.policies.get(JSON.stringify([lane, executionScope]));
      const state = policy
        ? await tx.jobQueueState.findUnique({
            where: { lane_scope: { lane, scope: executionScope } },
          })
        : null;
      let queueName: string | undefined;
      if (policy) {
        const queues = await tx.backgroundJob.groupBy({
          by: ["queueName"],
          where: eligible,
          orderBy: { queueName: "asc" },
        });
        queueName =
          selectQueue(
            queues.map((q) => q.queueName),
            state,
            policy,
          ) ?? undefined;
        if (!queueName) return null;
      }
      let next = await tx.backgroundJob.findFirst({
        where: {
          lane,
          executionScope,
          ...(queueName ? { queueName } : {}),
          status: "queued",
          availableAt: { lte: now },
          kind: { in: [...this.handlers.keys()] },
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      const aged = await tx.backgroundJob.findFirst({
        where: {
          lane,
          executionScope,
          ...(queueName ? { queueName } : {}),
          status: "queued",
          availableAt: { lte: now },
          kind: { in: [...this.handlers.keys()] },
          createdAt: { lte: new Date(now.getTime() - 10 * 60_000) },
        },
        orderBy: { createdAt: "asc" },
      });
      if (aged) next = aged;
      if (!next) return null;
      await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${next.id}::uuid FOR UPDATE`;
      // Ordinary management writes do not hold the scope advisory lock. Re-read
      // after acquiring the row lock so retirement/moves cannot be resurrected,
      // and gates validate the currently committed payload.
      next = await tx.backgroundJob.findUnique({ where: { id: next.id } });
      if (
        !next ||
        next.lane !== lane ||
        next.executionScope !== executionScope ||
        (queueName !== undefined && next.queueName !== queueName) ||
        next.status !== "queued" ||
        next.availableAt > now ||
        next.attempts >= 3 ||
        !this.handlers.has(next.kind)
      )
        return null;
      const deferred = await this.gates.get(next.kind)?.(next, tx, now);
      if (deferred) {
        const retryAt = deferredRetryAt(deferred, now);
        await tx.backgroundJob.update({
          where: { id: next.id },
          data: { availableAt: retryAt, lastError: deferred.reason },
        });
        deferredEvent = jobEvent("deferred", next, retryAt);
        return null;
      }
      if (policy) {
        const consecutive =
          state?.lastQueue === next.queueName
            ? Math.min(policy.primaryWeight, state.consecutive + 1)
            : 1;
        await tx.jobQueueState.upsert({
          where: { lane_scope: { lane, scope: executionScope } },
          create: {
            lane,
            scope: executionScope,
            lastQueue: next.queueName,
            consecutive,
          },
          update: { lastQueue: next.queueName, consecutive },
        });
      }
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
    if (deferredEvent) console.info(JSON.stringify(deferredEvent));
    return claimed;
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
      console.info(JSON.stringify(jobEvent("started", job)));
      controller.signal.throwIfAborted();
      await this.leaseContext.run(job, () =>
        this.handlers.get(job.kind)!(job, controller.signal),
      );
      controller.signal.throwIfAborted();
      const completed = await this.db.backgroundJob.updateMany({
        where: { id: job.id, leaseId: job.leaseId, status: "running" },
        data: {
          status: "succeeded",
          leaseId: null,
          leaseUntil: null,
          completedAt: new Date(),
          lastError: null,
        },
      });
      if (completed.count)
        console.info(JSON.stringify(jobEvent("succeeded", job)));
    } catch (error) {
      if (error instanceof JobDeferred) {
        const retryAt = deferredRetryAt(error);
        const changed = await this.db.backgroundJob.updateMany({
          where: {
            id: job.id,
            leaseId: job.leaseId,
            status: "running",
            leaseUntil: { gt: new Date() },
          },
          data: {
            status: "queued",
            availableAt: retryAt,
            leaseId: null,
            leaseUntil: null,
            attempts: { decrement: 1 },
            completedAt: null,
            lastError: error.reason,
          },
        });
        if (changed.count)
          console.info(
            JSON.stringify({
              ...jobEvent("deferred", job, retryAt),
              reason: error.reason,
            }),
          );
        return;
      }
      const retryAt = new Date(Date.now() + retryDelay(job.attempts));
      const changed = await this.db.backgroundJob.updateMany({
        where: { id: job.id, leaseId: job.leaseId, status: "running" },
        data: {
          status: job.attempts >= 3 ? "failed" : "queued",
          availableAt: retryAt,
          leaseId: null,
          leaseUntil: null,
          lastError: "后台处理未完成，请检查资源权限或配置后重试",
          ...(job.attempts >= 3 ? { completedAt: new Date() } : {}),
        },
      });
      if (changed.count)
        console.info(
          JSON.stringify(
            jobEvent(
              job.attempts >= 3 ? "failed" : "retry_scheduled",
              job,
              job.attempts >= 3 ? undefined : retryAt,
            ),
          ),
        );
    } finally {
      clearInterval(heartbeat);
      stopping?.removeEventListener("abort", stop);
    }
  }

  async assertCurrentLease(tx: Prisma.TransactionClient) {
    const job = this.leaseContext.getStore();
    if (!job) return;
    // Hold ownership until this short protected transaction commits. A count
    // alone allows a peer to replace the lease between verification and writes.
    await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
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
      throw new ConflictException("后台任务租约已变化");
  }

  async runNext(
    lane: JobLane,
    stopping?: AbortSignal,
    executionScope = "global",
  ) {
    const job = await this.claim(lane, new Date(), executionScope);
    if (!job) return false;
    await this.execute(job, stopping);
    return true;
  }
}
