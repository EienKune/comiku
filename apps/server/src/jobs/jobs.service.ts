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
const EXPIRED_LEASE_ERROR = "执行租约过期，已排队恢复";
export type JobDeferredReason =
  | "capacity"
  | "credential_unavailable"
  | "platform_cooldown"
  | "scope_paused"
  | "platform_maintenance";
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
        "platform_maintenance",
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
  admission: JobAdmissionContext,
) => Promise<void | JobDeferred>;
export interface JobAdmissionContext {
  leaseId: string;
  ownerId: string;
  budgetAttempt: number;
}
export interface JobExecutionLifecycle {
  run<T>(job: BackgroundJob, action: () => Promise<T>): Promise<T>;
  business(
    tx: Prisma.TransactionClient,
    job: BackgroundJob,
    outcome: "succeeded" | "failed" | "deferred",
    error?: unknown,
    refunded?: boolean,
  ): Promise<void>;
  settled(job: BackgroundJob): Promise<void>;
}
export function retryDelay(attempt: number): number {
  return Math.min(300_000, 5_000 * 2 ** (attempt - 1));
}

@Injectable()
export class JobsService {
  readonly ownerId = randomUUID();
  private readonly leaseContext = new AsyncLocalStorage<BackgroundJob>();
  private handlers = new Map<string, JobHandler>();
  private retryDelays = new Map<string, number>();
  private gates = new Map<string, JobClaimGate>();
  private lifecycles = new Map<string, JobExecutionLifecycle>();
  private policies = new Map<string, QueuePolicy>();
  private availability = new Map<
    string,
    (tx: Prisma.TransactionClient) => Promise<readonly string[]>
  >();

  /** Eligibility runs under the scope barrier, before fairness selection. DB reads only. */
  registerQueueAvailability(
    lane: JobLane,
    scope: string,
    available: (tx: Prisma.TransactionClient) => Promise<readonly string[]>,
  ) {
    const key = JSON.stringify([lane, scope]);
    if (this.availability.has(key))
      throw new Error("Duplicate queue availability");
    this.availability.set(key, available);
  }

  registerClaimGate(kind: string, gate: JobClaimGate) {
    if (this.gates.has(kind)) throw new Error("Duplicate job claim gate");
    this.gates.set(kind, gate);
  }
  registerExecutionLifecycle(kind: string, lifecycle: JobExecutionLifecycle) {
    if (this.lifecycles.has(kind)) throw new Error("Duplicate job lifecycle");
    this.lifecycles.set(kind, lifecycle);
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

  register(
    kind: string,
    handler: JobHandler,
    options?: { retryDelayMs: number },
  ) {
    if (this.handlers.has(kind))
      throw new Error("Duplicate background handler");
    if (options) {
      if (
        !Number.isSafeInteger(options.retryDelayMs) ||
        options.retryDelayMs < 1
      )
        throw new Error("Invalid background retry delay");
      this.retryDelays.set(kind, options.retryDelayMs);
    }
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
    let deferredEvent:
      (ReturnType<typeof jobEvent> & { reason: JobDeferredReason }) | undefined;
    const claimed = await this.db.$transaction(async (tx) => {
      await this.lockScope(tx, lane, executionScope);
      // Interactive profile calls cannot be replayed after their HTTP owner dies.
      // Also retire rows requeued by an older runtime before this cleanup existed.
      if (lane === "network" && executionScope.startsWith("source:"))
        await tx.backgroundJob.updateMany({
          where: {
            lane,
            executionScope,
            kind: "source_profile_resolve",
            OR: [
              { status: "running", leaseUntil: { lte: now } },
              { status: "queued" },
            ],
          },
          data: {
            status: "failed",
            leaseId: null,
            leaseUntil: null,
            completedAt: now,
            lastError: "资料同步执行已中断，请重新提交请求",
          },
        });
      const recovered = await tx.backgroundJob.updateMany({
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
          lastError: EXPIRED_LEASE_ERROR,
        },
      });
      if (recovered.count && this.retryDelays.size) {
        const byDelay = new Map<number, string[]>();
        for (const [kind, ms] of this.retryDelays)
          byDelay.set(ms, [...(byDelay.get(ms) ?? []), kind]);
        // Scope serialization keeps this recovery stamp stable. Only actual
        // recovered handlers pay for an additional write; ordinary claims do not.
        for (const [ms, kinds] of byDelay)
          await tx.backgroundJob.updateMany({
            where: {
              lane,
              executionScope,
              status: "queued",
              availableAt: now,
              lastError: EXPIRED_LEASE_ERROR,
              kind: { in: kinds },
            },
            data: { availableAt: new Date(now.getTime() + ms) },
          });
      }
      if (
        await tx.backgroundJob.count({
          where: {
            lane,
            executionScope,
            status: "running",
            leaseUntil: { gt: now },
            ...(lane === "network" && executionScope.startsWith("source:")
              ? { kind: { not: "source_profile_resolve" } }
              : {}),
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
      const availableQueues = await this.availability.get(
        JSON.stringify([lane, executionScope]),
      )?.(tx);
      const eligible = {
        ...(availableQueues ? { queueName: { in: [...availableQueues] } } : {}),
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
          ...eligible,
          ...(queueName ? { queueName } : {}),
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      const aged = await tx.backgroundJob.findFirst({
        where: {
          ...eligible,
          ...(queueName ? { queueName } : {}),
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
        (availableQueues !== undefined &&
          !availableQueues.includes(next.queueName)) ||
        (queueName !== undefined && next.queueName !== queueName) ||
        next.status !== "queued" ||
        next.availableAt > now ||
        next.attempts >= 3 ||
        !this.handlers.has(next.kind)
      )
        return null;
      const leaseId = randomUUID();
      const deferred = await this.gates.get(next.kind)?.(next, tx, now, {
        leaseId,
        ownerId: this.ownerId,
        budgetAttempt: next.attempts + 1,
      });
      if (deferred) {
        const retryAt = deferredRetryAt(deferred, now);
        await tx.backgroundJob.update({
          where: { id: next.id },
          data: { availableAt: retryAt, lastError: deferred.reason },
        });
        deferredEvent = {
          ...jobEvent("deferred", next, retryAt),
          reason: deferred.reason,
        };
        return null;
      }
      if (policy) {
        const refund = {
          advanceLeaseId: leaseId,
          priorLastQueue: state?.lastQueue ?? null,
          priorConsecutive: state?.consecutive ?? null,
        };
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
            ...refund,
          },
          update: { lastQueue: next.queueName, consecutive, ...refund },
        });
      }
      return tx.backgroundJob.update({
        where: { id: next.id },
        data: {
          status: "running",
          leaseId,
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
    const lifecycle = this.lifecycles.get(job.kind);
    const run = () => this.executeOwned(job, stopping, lifecycle);
    return lifecycle ? lifecycle.run(job, run) : run();
  }

  private async executeOwned(
    job: BackgroundJob,
    stopping?: AbortSignal,
    lifecycle?: JobExecutionLifecycle,
  ) {
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
      const complete = async (tx: Prisma.TransactionClient) => {
        const completed = await tx.backgroundJob.updateMany({
          where: { id: job.id, leaseId: job.leaseId, status: "running" },
          data: {
            status: "succeeded",
            leaseId: null,
            leaseUntil: null,
            completedAt: new Date(),
            lastError: null,
          },
        });
        if (completed.count) await lifecycle?.business(tx, job, "succeeded");
        return completed;
      };
      const completed = lifecycle
        ? await this.db.$transaction(complete)
        : await complete(this.db);
      if (completed.count)
        console.info(JSON.stringify(jobEvent("succeeded", job)));
    } catch (error) {
      if (error instanceof JobDeferred) {
        const retryAt = deferredRetryAt(error);
        const changed = await this.db.$transaction(async (tx) => {
          await this.lockScope(tx, job.lane, job.executionScope);
          await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
          const changed = await tx.backgroundJob.updateMany({
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
          if (changed.count) {
            await lifecycle?.business(tx, job, "deferred", error, true);
            const where = {
              lane_scope: { lane: job.lane, scope: job.executionScope },
            };
            const state = await tx.jobQueueState.findUnique({ where });
            // A later claim must never lose its budget to a stale executor.
            if (state?.advanceLeaseId === job.leaseId) {
              if (state.priorConsecutive === null)
                await tx.jobQueueState.delete({ where });
              else
                await tx.jobQueueState.update({
                  where,
                  data: {
                    lastQueue: state.priorLastQueue!,
                    consecutive: state.priorConsecutive,
                    advanceLeaseId: null,
                    priorLastQueue: null,
                    priorConsecutive: null,
                  },
                });
            }
          }
          return changed;
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
      const retryAt = new Date(
        Date.now() +
          (this.retryDelays.get(job.kind) ?? retryDelay(job.attempts)),
      );
      const fail = async (tx: Prisma.TransactionClient) => {
        const changed = await tx.backgroundJob.updateMany({
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
        if (changed.count) await lifecycle?.business(tx, job, "failed", error);
        return changed;
      };
      const changed = lifecycle
        ? await this.db.$transaction(fail)
        : await fail(this.db);
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
      // Handler promises must include child/stream/cleanup completion. Lease loss
      // never settles another owner's admission and does not imply local shutdown.
      await lifecycle?.settled(job);
    }
  }

  async assertCurrentLease(tx: Prisma.TransactionClient) {
    const job = this.leaseContext.getStore();
    if (!job) return;
    return this.assertLease(tx, job);
  }

  async assertLease(
    tx: Prisma.TransactionClient,
    job: { id: string; leaseId: string | null },
  ) {
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
