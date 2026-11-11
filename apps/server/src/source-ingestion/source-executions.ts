import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { PrismaService } from "../database/prisma.service.js";
import type { BackgroundJob, Prisma } from "../generated/prisma/client.js";
import {
  JobDeferred,
  type JobExecutionLifecycle,
} from "../jobs/jobs.service.js";
import { SourceResponseError } from "./source-response.js";
import { controlledFailureDetails } from "./source-diagnostics.js";

export type SourceExecutionOutcome =
  "succeeded" | "partial_failed" | "failed" | "deferred";
const stages = new Set(
  "execution prepare_scan recovery_prepare fetch_page fetch_post validate_post download store sign missing cleanup".split(
    " ",
  ),
);
const numericFields = {
  http_status: "httpStatus",
  limit_bytes: "limitBytes",
  declared_bytes: "declaredBytes",
  observed_bytes: "observedBytes",
  duration: "durationMs",
} as const;
/** Persisted/API-safe diagnostics deliberately exclude all upstream free text. */
export function executionDiagnosticSample(error: unknown, stage = "execution") {
  const details =
    error instanceof SourceResponseError ? error.details : undefined;
  const safe = controlledFailureDetails(
    details ?? { scope: "protocol", reason: "unknown_failure" },
  );
  const sample: Record<string, string | number | boolean> = {
    stage: stages.has(stage) ? stage : "execution",
    reason: safe.reason,
    scope: safe.scope,
    occurredAt: new Date().toISOString(),
  };
  const diagnostic = safe.diagnostic as Record<string, unknown>;
  for (const [key, target] of Object.entries(numericFields)) {
    const value = diagnostic[key];
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{1,15}$/.test(value)
          ? Number(value)
          : NaN;
    if (
      Number.isSafeInteger(n) &&
      n >= 0 &&
      (key !== "http_status" || (n >= 100 && n <= 599))
    )
      sample[target] = n;
  }
  if (diagnostic.timeout === true || diagnostic.timeout === "true")
    sample.timeout = true;
  if (error instanceof JobDeferred) {
    sample.reason = error.reason;
    sample.scope = "configuration";
  }
  return sample;
}

interface DiagnosticBuffer {
  samples: ReturnType<typeof executionDiagnosticSample>[];
  omitted: number;
  unconfirmed?: boolean;
}
const executionContext = new AsyncLocalStorage<DiagnosticBuffer>();
export function sourceResourceUnconfirmed() {
  const context = executionContext.getStore();
  if (context) context.unconfirmed = true;
}
/** Abort can reject execFile's callback before stdio/child close. Await both. */
export async function waitForSourceChildClose<T>(
  child: ChildProcess,
  result: Promise<T>,
): Promise<T> {
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const [outcome] = await Promise.allSettled([result, closed]);
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}
/** Each admitted local owner settles only after its complete awaited resource boundary. */
export class SourceExecutions implements JobExecutionLifecycle {
  constructor(
    private readonly db: PrismaService,
    readonly ownerId: string,
  ) {}
  async admit(
    tx: Prisma.TransactionClient,
    input: {
      platform: string;
      kind: string;
      credentialGeneration: string;
      jobId: string;
      leaseId: string;
      budgetAttempt: number;
      taskId?: string;
      campaignId?: string;
    },
  ) {
    return tx.sourcePlatformExecution.create({
      data: {
        id: randomUUID(),
        ...input,
        ownerId: this.ownerId,
        budgetRefunded: false,
      },
    });
  }
  run<T>(
    _job: Pick<BackgroundJob, "id" | "leaseId">,
    action: () => Promise<T>,
  ): Promise<T> {
    return executionContext.run({ samples: [], omitted: 0 }, action);
  }
  record(error: unknown, stage = "execution") {
    const context = executionContext.getStore();
    if (!context) return;
    if (context.samples.length < 8)
      context.samples.push(executionDiagnosticSample(error, stage));
    else
      context.omitted = Math.min(Number.MAX_SAFE_INTEGER, context.omitted + 1);
  }
  async business(
    tx: Prisma.TransactionClient,
    job: Pick<BackgroundJob, "id" | "leaseId">,
    outcome: SourceExecutionOutcome,
    error?: unknown,
    refunded = false,
  ) {
    if (error !== undefined) this.record(error);
    const context = executionContext.getStore();
    const diagnostic = {
      samples: context?.samples ?? [],
      omitted: context?.omitted ?? 0,
    };
    await tx.sourcePlatformExecution.updateMany({
      where: {
        jobId: job.id,
        leaseId: job.leaseId!,
        ownerId: this.ownerId,
        businessOutcome: null,
      },
      data: {
        businessOutcome:
          outcome === "succeeded" && diagnostic.samples.length
            ? "partial_failed"
            : outcome,
        businessFinishedAt: new Date(),
        budgetRefunded: refunded,
        diagnosticJson: diagnostic as unknown as Prisma.InputJsonValue,
      },
    });
  }
  async settled(job: Pick<BackgroundJob, "id" | "leaseId">) {
    return this.settle(job);
  }
  async settle(job: Pick<BackgroundJob, "id" | "leaseId">) {
    if (executionContext.getStore()?.unconfirmed) return;
    await this.db.sourcePlatformExecution.updateMany({
      where: {
        jobId: job.id,
        leaseId: job.leaseId!,
        ownerId: this.ownerId,
        settledAt: null,
      },
      data: { settledAt: new Date() },
    });
  }
  /** One bounded maintenance batch; a missing optional test delegate is a no-op. */
  async pruneSettled(now = new Date(), limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Execution retention batch must be between 1 and 100");
    if (!this.db?.sourcePlatformExecution) return 0;
    const cutoff = new Date(now.getTime() - 30 * 86400_000);
    return this.db
      .$executeRaw`DELETE FROM source_platform_executions WHERE id IN (
      SELECT id FROM source_platform_executions WHERE settled_at < ${cutoff}
      ORDER BY settled_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )`;
  }
}
