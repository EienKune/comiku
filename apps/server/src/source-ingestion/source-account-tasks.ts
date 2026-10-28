import type { PrismaService } from "../database/prisma.service.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { JobsService } from "../jobs/jobs.service.js";

export function accountBatchStatus(statuses: readonly string[]) {
  if (
    !statuses.length ||
    statuses.some((status) => !["succeeded", "failed"].includes(status))
  )
    return null;
  const successes = statuses.filter((status) => status === "succeeded").length;
  return successes === statuses.length
    ? ("succeeded" as const)
    : successes
      ? ("partial_failed" as const)
      : ("failed" as const);
}
/** Durable targets are created in the same transaction as the batch and queue entries. */
export class SourceAccountTasks {
  constructor(
    private readonly db: PrismaService,
    private readonly jobs: JobsService,
  ) {}
  async create(
    tx: Prisma.TransactionClient,
    runId: string,
    actorId: string | null,
    accountIds: string[],
  ) {
    const accounts = await tx.authorExternalAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, platform: true },
    });
    for (const account of accounts) {
      const task = await tx.sourceFetchAccountTask.create({
        data: { runId, accountId: account.id, platform: account.platform },
      });
      const job = await this.jobs.enqueue(
        {
          kind: "source_account_fetch",
          resourceId: task.id,
          actorId,
          idempotencyKey: `source-account:${task.id}`,
          lane: "network",
          executionScope: `source:${account.platform}`,
          queueName: "scan",
        },
        tx,
      );
      await tx.sourceFetchAccountTask.update({
        where: { id: task.id },
        data: { jobId: job.id },
      });
    }
  }
  async aggregate(tx: Prisma.TransactionClient, runId: string) {
    await tx.$queryRaw`SELECT id FROM source_fetch_runs WHERE id = ${runId}::uuid FOR UPDATE`;
    const tasks = await tx.sourceFetchAccountTask.findMany({
      where: { runId },
      select: { status: true },
    });
    const status = accountBatchStatus(tasks.map((task) => task.status));
    await tx.sourceFetchRun.updateMany({
      where: { id: runId, completedAt: null },
      data: status
        ? { status, completedAt: new Date() }
        : {
            status: tasks.some((task) => task.status === "running")
              ? "running"
              : "queued",
          },
    });
  }
}
