import { AsyncLocalStorage } from "node:async_hooks";
import { SourceAccountTasks } from "./source-account-tasks.js";
import {
  SourcePlatformStates,
  platformFailure,
} from "./source-platform-state.js";
import type { BackgroundJob } from "../generated/prisma/client.js";
import { JobDeferred, JobsService } from "../jobs/jobs.service.js";
import { jsonObject, SourceResponseError } from "./source-response.js";
import { sourceDiagnostic } from "./source-diagnostics.js";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import {
  CandidateTagDisposition,
  Prisma,
  SourceFetchTrigger,
  type JobStatus,
  type SourceAdapterState,
  type SourceFetchRun,
} from "../generated/prisma/client.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import { FileObjectsService } from "../files/file-objects.service.js";
import {
  CANDIDATE_MEDIA_CLASSIFIER,
  type CandidateMediaClassifier,
} from "./candidate-classifier.js";
import type {
  ContentSourceClient,
  NormalizedSourceContent,
  SourceCursor,
} from "./content-source.js";
import { collectHashtags } from "./hashtags.js";
import { MEDIA_DOWNLOADER, type MediaDownloader } from "./media-downloader.js";
import { ContentSourceRegistry } from "./source-registry.js";
import type {
  RunSourceFetchDto,
  SourceFetchProgressDto,
  SourceFetchProgressSnapshotDto,
  SourceFetchRunDto,
} from "./source-fetch.dto.js";

const SOURCE_LEASE_MS = 30 * 60_000;
const SOURCE_LEASE_RENEW_MS = 5 * 60_000;

const runDetails = {
  accountTasks: true,
  items: {
    include: {
      externalAccount: {
        include: { author: { select: { displayName: true } } },
      },
      adapterState: { omit: { discoveryCheckpointJson: true } },
    },
    orderBy: { startedAt: "asc" },
  },
} as const;
type RunDetails = Prisma.SourceFetchRunGetPayload<{
  include: typeof runDetails;
}>;
type Account = Prisma.AuthorExternalAccountGetPayload<{
  include: {
    author: true;
    adapterStates: { omit: { discoveryCheckpointJson: true } };
  };
}>;
type FetchState = Omit<SourceAdapterState, "discoveryCheckpointJson"> & {
  scanEpoch?: number;
  scanOwnerJobId?: string;
};
type ProgressRun = Pick<
  SourceFetchRun,
  "id" | "trigger" | "status" | "startedAt" | "completedAt"
> & {
  pagesFetched: bigint;
  candidatesCreated: bigint;
  mediaStored: bigint;
  jobStatus: JobStatus | null;
  attempts: number | null;
  availableAt: Date | null;
  leaseUntil: Date | null;
  isActive: boolean;
  isLastManual: boolean;
  targetCount?: bigint;
  completedTargets?: bigint;
  waitingTargets?: bigint;
  waitingReason?: string | null;
};

@Injectable()
export class SourceFetchService {
  readonly platforms: SourcePlatformStates;
  private readonly tasks: SourceAccountTasks;
  private readonly accountExecution = new AsyncLocalStorage<{
    job: BackgroundJob;
    platform: string;
    generation: string;
  }>();
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ContentSourceRegistry)
    private readonly sources: ContentSourceRegistry,
    @Inject(MEDIA_DOWNLOADER) private readonly downloader: MediaDownloader,
    @Inject(FileObjectsService) private readonly files: FileObjectsService,
    @Inject(CANDIDATE_MEDIA_CLASSIFIER)
    private readonly classifier: CandidateMediaClassifier,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {
    this.platforms = new SourcePlatformStates(db, jobs, environment);
    this.tasks = new SourceAccountTasks(db, jobs);
  }

  onModuleInit() {
    for (const platform of ["x", "pixiv"])
      this.jobs.registerQueuePolicy("network", `source:${platform}`, {
        primary: "scan",
        secondary: "recovery",
        primaryWeight: 3,
      });
    // Pre-upgrade queued whole-run jobs must be drained on the old runtime or
    // explicitly retired by maintenance; never run that handler alongside scopes.
    this.jobs.register("source_fetch", async () => {
      throw new Error("Legacy source batch requires drain");
    });
    this.jobs.registerClaimGate(
      "source_fetch",
      async () =>
        new JobDeferred(new Date(Date.now() + 900000), "scope_paused"),
    );
    this.jobs.register("source_account_fetch", (job, signal) =>
      this.runAccountTask(job, signal),
    );
    this.jobs.registerClaimGate("source_account_fetch", (job, tx, now) =>
      this.platforms.claim(job, tx, now),
    );
  }

  private async runAccountTask(job: BackgroundJob, signal: AbortSignal) {
    const task = await this.db.sourceFetchAccountTask.findUnique({
      where: { id: job.resourceId },
      include: { run: true },
    });
    if (!task || task.jobId !== job.id || task.completedAt) return;
    const payload = jsonObject(job.payload);
    const generation = payload?.credentialGeneration;
    if (typeof generation !== "string" || payload?.platform !== task.platform)
      throw new Error("Unpinned source task");
    await this.accountExecution.run(
      { job, platform: task.platform, generation },
      async () => {
        try {
          await this.assertActor(task.run.requestedById);
          await this.platforms.beforeNetwork(task.platform, generation);
          let accounts = await this.accounts([task.accountId]);
          if (accounts.length !== 1)
            throw new BadRequestException("来源账号或授权已失效");
          await this.ensureAdapterStates(accounts);
          accounts = await this.accounts([task.accountId]);
          if (accounts.length !== 1)
            throw new BadRequestException("来源账号或授权已失效");
          await this.db.$transaction(async (tx) => {
            await this.jobs.assertCurrentLease(tx);
            await this.platforms.actor(tx, task.run.requestedById);
            await tx.sourceFetchRunItem.updateMany({
              where: {
                runId: task.runId,
                externalAccountId: task.accountId,
                status: { not: "succeeded" },
              },
              data: {
                status: "failed",
                errorCode: "interrupted",
                errorMessage: "账号任务恢复",
                completedAt: new Date(),
              },
            });
            await tx.sourceFetchRun.updateMany({
              where: { id: task.runId, completedAt: null },
              data: { status: "running" },
            });
          });
          signal.throwIfAborted();
          await this.fetchWithFallback(
            task.runId,
            accounts[0],
            task.run.requestedById,
            signal,
          );
          signal.throwIfAborted();
          const succeeded = await this.db.sourceFetchRunItem.count({
            where: {
              runId: task.runId,
              externalAccountId: task.accountId,
              status: "succeeded",
            },
          });
          if (!succeeded) throw new Error("No account adapter completed");
          await this.db.$transaction(async (tx) => {
            await this.jobs.assertCurrentLease(tx);
            await this.platforms.actor(tx, task.run.requestedById);
            await tx.sourceFetchAccountTask.update({
              where: { id: task.id },
              data: {
                status: "succeeded",
                completedAt: new Date(),
                failureCode: null,
                deferredUntil: null,
              },
            });
            await this.tasks.aggregate(tx, task.runId);
          });
        } catch (error) {
          if (signal.aborted) throw error;
          await this.db.$transaction(async (tx) => {
            await this.jobs.assertCurrentLease(tx);
            const deferred = error instanceof JobDeferred;
            const terminal =
              !deferred &&
              (job.attempts >= 3 || error instanceof BadRequestException);
            await tx.sourceFetchAccountTask.update({
              where: { id: task.id },
              data: {
                status: deferred ? "waiting" : terminal ? "failed" : "queued",
                completedAt: terminal ? new Date() : null,
                deferredUntil: deferred ? error.retryAt : null,
                failureCode: deferred
                  ? error.reason
                  : terminal
                    ? "account_failed"
                    : "retry_pending",
              },
            });
            await this.tasks.aggregate(tx, task.runId);
          });
          if (error instanceof BadRequestException) return;
          throw error;
        }
      },
    );
  }

  async reconcileExhausted() {
    const now = new Date();
    const terminalTasks = await this.db.$queryRaw<
      { id: string; jobId: string; runId: string; accountId: string }[]
    >`
      SELECT t.id,t.job_id AS "jobId",t.run_id AS "runId",t.account_id AS "accountId"
      FROM source_fetch_account_tasks t JOIN background_jobs j ON j.id=t.job_id
      WHERE t.completed_at IS NULL AND (j.status='failed' OR
        (j.status='queued' AND j.attempts>=3) OR
        (j.status='running' AND j.attempts>=3 AND (j.lease_until IS NULL OR j.lease_until<=${now})))
      ORDER BY t.id LIMIT 100
    `;
    for (const task of terminalTasks)
      await this.db.$transaction((tx) =>
        this.settleAccountTerminal(tx, task, now),
      );
    const runs = await this.db.sourceFetchRun.findMany({
      where: { completedAt: null },
      select: { id: true },
      orderBy: { startedAt: "asc" },
      take: 100,
    });
    const jobs = await this.db.backgroundJob.findMany({
      where: {
        kind: "source_fetch",
        ...this.terminalJobs(now),
        resourceId: { in: runs.map((r) => r.id) },
      },
      select: { id: true, resourceId: true },
    });
    for (const job of jobs)
      await this.db.$transaction((tx) =>
        this.settleTerminalJob(tx, job.id, now),
      );
  }

  private async settleAccountTerminal(
    tx: Prisma.TransactionClient,
    task: {
      id: string;
      jobId: string | null;
      runId: string;
      accountId: string;
    },
    now: Date,
  ) {
    if (!task.jobId) return;
    await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${task.jobId}::uuid FOR UPDATE`;
    const failed = await tx.backgroundJob.findFirst({
      where: { id: task.jobId, ...this.terminalJobs(now) },
    });
    if (!failed) return;
    await tx.backgroundJob.update({
      where: { id: failed.id },
      data: {
        status: "failed",
        leaseId: null,
        leaseUntil: null,
        completedAt: failed.completedAt ?? now,
      },
    });
    await tx.sourceFetchAccountTask.updateMany({
      where: { id: task.id, completedAt: null },
      data: {
        status: "failed",
        completedAt: now,
        failureCode: "worker_attempts_exhausted",
        deferredUntil: null,
      },
    });
    await tx.sourceFetchRunItem.updateMany({
      where: {
        runId: task.runId,
        externalAccountId: task.accountId,
        status: "running",
      },
      data: {
        status: "failed",
        completedAt: now,
        errorCode: "worker_attempts_exhausted",
        errorMessage: "后台重试已耗尽",
      },
    });
    const cleared = await tx.sourceAccountScanState.updateMany({
      where: { accountId: task.accountId, leaseOwnerJobId: failed.id },
      data: {
        leaseOwnerJobId: null,
        leaseUntil: null,
        epoch: { increment: 1 },
      },
    });
    if (cleared.count)
      await tx.sourceAdapterState.updateMany({
        where: { externalAccountId: task.accountId, fetchLeaseId: task.runId },
        data: { fetchLeaseId: null, fetchLeaseUntil: null },
      });
    await this.tasks.aggregate(tx, task.runId);
  }

  private terminalJobs(now: Date): Prisma.BackgroundJobWhereInput {
    return {
      OR: [
        { status: "failed" },
        { status: "queued", attempts: { gte: 3 } },
        {
          status: "running",
          attempts: { gte: 3 },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
      ],
    };
  }

  private async settleTerminalJob(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ) {
    // Serialize with worker claims/commits, then re-read terminal eligibility.
    // A live final attempt is never reclaimed by a manual or scheduled request.
    await tx.$queryRaw`SELECT id FROM background_jobs WHERE id = ${id}::uuid FOR UPDATE`;
    const job = await tx.backgroundJob.findFirst({
      where: { id, kind: "source_fetch", ...this.terminalJobs(now) },
      select: { id: true, resourceId: true, status: true, completedAt: true },
    });
    if (!job) return;
    await tx.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        leaseId: null,
        leaseUntil: null,
        completedAt: job.completedAt ?? now,
        ...(job.status === "failed" ? {} : { lastError: "重试次数已用尽" }),
      },
    });
    await tx.sourceFetchRun.updateMany({
      where: { id: job.resourceId, completedAt: null },
      data: { status: "failed", completedAt: now },
    });
    await tx.sourceFetchRunItem.updateMany({
      where: { runId: job.resourceId, status: "running" },
      data: {
        status: "failed",
        errorCode: "worker_attempts_exhausted",
        errorMessage: "后台重试已耗尽，请检查后重新抓取",
        completedAt: now,
      },
    });
    await tx.sourceAccountScanState.updateMany({
      where: { leaseOwnerJobId: job.id },
      data: {
        leaseOwnerJobId: null,
        leaseUntil: null,
        epoch: { increment: 1 },
      },
    });
    await tx.sourceAdapterState.updateMany({
      where: { fetchLeaseId: job.resourceId },
      data: { fetchLeaseId: null, fetchLeaseUntil: null },
    });
  }

  private async settleTerminalLeases(
    tx: Prisma.TransactionClient,
    accountIds: string[],
    now: Date,
  ) {
    const leases = await tx.sourceAdapterState.findMany({
      where: {
        externalAccountId: { in: accountIds },
        fetchLeaseId: { not: null },
      },
      select: { fetchLeaseId: true },
    });
    const runIds = [
      ...new Set(
        leases.flatMap((state) =>
          state.fetchLeaseId ? [state.fetchLeaseId] : [],
        ),
      ),
    ];
    if (!runIds.length) return;
    const jobs = await tx.backgroundJob.findMany({
      where: {
        kind: "source_fetch",
        resourceId: { in: runIds },
        ...this.terminalJobs(now),
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    for (const job of jobs) await this.settleTerminalJob(tx, job.id, now);
  }

  async runManual(requestedById: string, input: RunSourceFetchDto) {
    const ids = [...new Set(input.accountIds ?? [])].sort();
    const run = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:source-schedule'))`;
      await this.assertActor(requestedById, tx);
      const accounts = await this.accounts(ids, tx);
      if (!accounts.length || (ids.length && accounts.length !== ids.length))
        throw new BadRequestException("没有可抓取的授权账号");
      const accountIds = accounts.map((item) => item.id).sort();
      const active = await this.activeRun(tx, accountIds);
      if (active) return active;
      return this.enqueueRun(tx, "manual", requestedById, accountIds);
    });
    return this.get(run.id);
  }

  private async activeRun(tx: Prisma.TransactionClient, accountIds: string[]) {
    const now = new Date();
    const pendingTasks = await tx.sourceFetchAccountTask.findMany({
      where: { accountId: { in: accountIds }, completedAt: null },
      select: { id: true, jobId: true, runId: true, accountId: true },
    });
    const jobIds = [
      ...new Set(
        pendingTasks.flatMap((task) => (task.jobId ? [task.jobId] : [])),
      ),
    ].sort();
    // Lock every sibling before the first aggregate acquires its run. A live
    // sibling finalizes job -> run, so this transaction must never hold run -> new job.
    if (jobIds.length)
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM background_jobs WHERE id IN (${Prisma.join(jobIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
      );
    await this.settleTerminalLeases(tx, accountIds, now);
    for (const task of pendingTasks)
      await this.settleAccountTerminal(tx, task, now);

    const batches = await tx.sourceFetchRun.findMany({
      where: { completedAt: null, accountTasks: { some: {} } },
      select: {
        id: true,
        accountTasks: { select: { accountId: true, completedAt: true } },
      },
    });
    for (const batch of batches) {
      const ids = batch.accountTasks.map((task) => task.accountId);
      if (
        ids.length === accountIds.length &&
        ids.every((id) => accountIds.includes(id))
      )
        return { id: batch.id };
      const activeIds = batch.accountTasks
        .filter((task) => !task.completedAt)
        .map((task) => task.accountId);
      if (activeIds.some((id) => accountIds.includes(id)))
        throw new ConflictException(
          "所选账号已有重叠的同步批次，请等待完成后重试",
        );
    }
    // Expired executions with retries left still own a recoverable batch. Exhausted
    // queued/expired jobs do not prevent a fresh request while reconciliation runs.
    const jobs = await tx.backgroundJob.findMany({
      where: {
        kind: "source_fetch",
        OR: [
          { status: "queued", attempts: { lt: 3 } },
          {
            status: "running",
            OR: [{ attempts: { lt: 3 } }, { leaseUntil: { gt: now } }],
          },
        ],
      },
      select: { resourceId: true, payload: true },
    });
    if (!jobs.length) return null;
    const runs = await tx.sourceFetchRun.findMany({
      where: {
        id: { in: jobs.map((job) => job.resourceId) },
        completedAt: null,
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
    });
    const activeIds = new Set(runs.map((run) => run.id));
    const requested = new Set(accountIds);
    let equivalent: { id: string } | null = null;
    for (const job of jobs) {
      if (!activeIds.has(job.resourceId)) continue;
      const payload = job.payload as { accountIds?: unknown } | null;
      const ids = Array.isArray(payload?.accountIds)
        ? [
            ...new Set(
              payload.accountIds.filter(
                (id): id is string => typeof id === "string",
              ),
            ),
          ].sort()
        : [];
      if (!ids.length || ids.some((id) => requested.has(id))) {
        if (
          ids.length === accountIds.length &&
          ids.every((id) => requested.has(id))
        )
          equivalent = { id: job.resourceId };
        else
          throw new ConflictException(
            "所选账号已有重叠的同步批次，请等待完成后重试",
          );
      }
    }
    return equivalent;
  }

  private async enqueueRun(
    tx: Prisma.TransactionClient,
    trigger: SourceFetchTrigger,
    actorId: string | null,
    accountIds: string[],
  ) {
    const run = await tx.sourceFetchRun.create({
      data: { trigger, requestedById: actorId, status: "queued" },
    });
    await this.tasks.create(tx, run.id, actorId, accountIds);
    return run;
  }

  async scheduleDue(now = new Date()) {
    if (!this.environment.sourceScheduleEnabled) return false;
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:source-schedule'))`;
      const schedule = await tx.workerSchedule.upsert({
        where: { name: "sources" },
        create: { name: "sources", dueAt: now },
        update: {},
      });
      if (schedule.dueAt > now) return false;
      await tx.workerSchedule.update({
        where: { name: "sources" },
        data: {
          dueAt: new Date(
            now.getTime() + this.environment.sourceScheduleMinutes * 60_000,
          ),
        },
      });
      const accounts = await tx.authorExternalAccount.findMany({
        where: {
          fetchEnabled: true,
          deletedAt: null,
          author: { authorizationStatus: "authorized", deletedAt: null },
        },
        select: { id: true },
      });
      if (!accounts.length) return false;
      const busy = await tx.sourceFetchAccountTask.findMany({
        where: { completedAt: null, run: { completedAt: null } },
        select: { accountId: true },
      });
      const reserved = new Set(busy.map((task) => task.accountId));
      const legacy = await tx.backgroundJob.findMany({
        where: {
          kind: "source_fetch",
          OR: [
            { status: "queued", attempts: { lt: 3 } },
            {
              status: "running",
              OR: [{ attempts: { lt: 3 } }, { leaseUntil: { gt: now } }],
            },
          ],
        },
        select: { payload: true },
      });
      for (const job of legacy) {
        const ids = jsonObject(job.payload)?.accountIds;
        if (Array.isArray(ids))
          for (const id of ids) if (typeof id === "string") reserved.add(id);
      }
      const accountIds = accounts
        .map((item) => item.id)
        .filter((id) => !reserved.has(id))
        .sort();
      if (!accountIds.length) return false;
      try {
        if (await this.activeRun(tx, accountIds)) return false;
      } catch (error) {
        if (error instanceof ConflictException) return false;
        throw error;
      }
      await this.enqueueRun(tx, "scheduled", null, accountIds);
      return true;
    });
  }

  async get(id: string): Promise<SourceFetchRunDto> {
    const run = await this.db.sourceFetchRun.findUniqueOrThrow({
      where: { id },
      include: runDetails,
    });
    return (await this.withExecution([run]))[0];
  }

  async progress(now = new Date()): Promise<SourceFetchProgressDto> {
    // Select two shared business summaries in one read snapshot. The unique job
    // key avoids loading the queue; only these run IDs enter item aggregation.
    const runs = await this.db.$queryRaw<ProgressRun[]>`
      WITH active AS (
        SELECT r.id
        FROM source_fetch_runs r
        WHERE r.status IN ('queued', 'running') AND r.completed_at IS NULL
          AND (EXISTS (
            SELECT 1 FROM source_fetch_account_tasks t JOIN background_jobs j ON j.id=t.job_id
            WHERE t.run_id=r.id AND t.completed_at IS NULL AND
              ((j.status='queued' AND j.attempts<3) OR
               (j.status='running' AND j.lease_until IS NOT NULL AND (j.attempts<3 OR j.lease_until>${now})))
          ) OR EXISTS (
            SELECT 1 FROM background_jobs j WHERE j.idempotency_key='source:'||r.id::text
              AND j.kind='source_fetch' AND j.resource_id=r.id AND
              ((j.status='queued' AND j.attempts<3) OR
               (j.status='running' AND j.lease_until IS NOT NULL AND (j.attempts<3 OR j.lease_until>${now})))
          ))
        ORDER BY CASE WHEN EXISTS (
          SELECT 1 FROM source_fetch_account_tasks t JOIN background_jobs j ON j.id=t.job_id
          WHERE t.run_id=r.id AND t.completed_at IS NULL AND j.status='running' AND j.lease_until>${now}
        ) OR EXISTS (
          SELECT 1 FROM background_jobs j WHERE j.idempotency_key='source:'||r.id::text
            AND j.resource_id=r.id AND j.kind='source_fetch' AND j.status='running' AND j.lease_until>${now}
        ) THEN 0 ELSE 1 END,r.started_at DESC,r.id DESC
        LIMIT 1
      ), last_manual AS (
        SELECT id FROM source_fetch_runs WHERE trigger = 'manual'
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      ), selected AS (
        SELECT id FROM active UNION SELECT id FROM last_manual
      )
      SELECT r.id, r.trigger, r.status,
        r.started_at AS "startedAt", r.completed_at AS "completedAt",
        totals.pages_fetched AS "pagesFetched",
        totals.candidates_created AS "candidatesCreated",
        totals.media_stored AS "mediaStored",
        COALESCE(child.status,j.status) AS "jobStatus", COALESCE(child.attempts,j.attempts) AS attempts,
        COALESCE(child.available_at,j.available_at) AS "availableAt", COALESCE(child.lease_until,j.lease_until) AS "leaseUntil",
        targets.total AS "targetCount", targets.completed AS "completedTargets", targets.waiting AS "waitingTargets", targets.reason AS "waitingReason",
        EXISTS (SELECT 1 FROM active WHERE active.id = r.id) AS "isActive",
        EXISTS (SELECT 1 FROM last_manual WHERE last_manual.id = r.id) AS "isLastManual"
      FROM selected
      JOIN source_fetch_runs r ON r.id = selected.id
      LEFT JOIN background_jobs j
        ON j.idempotency_key = 'source:' || r.id::text
        AND j.resource_id = r.id AND j.kind = 'source_fetch'
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE t.completed_at IS NOT NULL) AS completed,
          COUNT(*) FILTER (WHERE t.status='waiting') AS waiting,
          CASE WHEN BOOL_OR(t.status='waiting' AND t.failure_code IN ('credential_unavailable','scope_paused')) THEN 'credential_unavailable'
            WHEN BOOL_OR(t.status='waiting' AND t.failure_code='platform_cooldown') THEN 'platform_cooldown'
            WHEN BOOL_OR(t.status='waiting') THEN 'capacity' ELSE NULL END AS reason
        FROM source_fetch_account_tasks t WHERE t.run_id=r.id
      ) targets ON true
      LEFT JOIN LATERAL (
        SELECT j.status,j.attempts,j.available_at,j.lease_until
        FROM source_fetch_account_tasks t JOIN background_jobs j ON j.id=t.job_id
        WHERE t.run_id=r.id AND t.completed_at IS NULL
        ORDER BY CASE WHEN j.status='running' AND j.lease_until>${now} THEN 0 WHEN j.status='queued' AND j.attempts<3 THEN 1 ELSE 2 END,j.available_at
        FETCH FIRST 1 ROW ONLY
      ) child ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(i.pages_fetched), 0) AS pages_fetched,
          COALESCE(SUM(i.candidates_created), 0) AS candidates_created,
          COALESCE(SUM(i.media_stored), 0) AS media_stored
        FROM source_fetch_run_items i WHERE i.run_id = r.id
      ) totals ON true
    `;
    const result: SourceFetchProgressDto = { active: null, lastManual: null };
    for (const run of runs) {
      const live =
        run.jobStatus === "running" &&
        run.leaseUntil !== null &&
        run.leaseUntil > now;
      const terminal = run.status !== "queued" && run.status !== "running";
      const recoverable =
        !terminal &&
        run.completedAt === null &&
        ((run.jobStatus === "queued" && (run.attempts ?? 3) < 3) ||
          (run.jobStatus === "running" &&
            run.leaseUntil !== null &&
            ((run.attempts ?? 3) < 3 || live)));
      const snapshot: SourceFetchProgressSnapshotDto = {
        id: run.id,
        trigger: run.trigger,
        status: terminal
          ? run.status
          : recoverable
            ? live
              ? "running"
              : "queued"
            : "failed",
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        pagesFetched: Number(run.pagesFetched),
        candidatesCreated: Number(run.candidatesCreated),
        mediaStored: Number(run.mediaStored),
        ...(Number(run.targetCount ?? 0) > 0
          ? {
              targetCount: Number(run.targetCount),
              completedTargets: Number(run.completedTargets ?? 0),
              waitingTargets: Number(run.waitingTargets ?? 0),
              waitingReason: run.waitingReason ?? null,
            }
          : {}),
        nextRetryAt:
          recoverable &&
          run.jobStatus === "queued" &&
          ((run.attempts ?? 0) > 0 || Number(run.waitingTargets ?? 0) > 0)
            ? (run.availableAt?.toISOString() ?? null)
            : null,
      };
      if (run.isActive && recoverable) result.active = snapshot;
      if (run.isLastManual) result.lastManual = snapshot;
    }
    return result;
  }

  private async withExecution(
    runs: RunDetails[],
  ): Promise<SourceFetchRunDto[]> {
    const jobs = await this.db.backgroundJob.findMany({
      where: {
        OR: [
          {
            kind: "source_fetch",
            idempotencyKey: { in: runs.map((run) => `source:${run.id}`) },
          },
          {
            kind: "source_account_fetch",
            resourceId: {
              in: runs.flatMap((run) =>
                (run.accountTasks ?? []).map((task) => task.id),
              ),
            },
          },
        ],
      },
      select: {
        resourceId: true,
        status: true,
        attempts: true,
        availableAt: true,
      },
    });
    const byRun = new Map(jobs.map((job) => [job.resourceId, job]));
    return runs.map((run) => {
      const tasks = run.accountTasks ?? [];
      const children = tasks.flatMap((task) =>
        byRun.has(task.id) ? [byRun.get(task.id)!] : [],
      );
      const job =
        children.find((job) => job.status === "running") ??
        children.find((job) => job.status === "queued") ??
        byRun.get(run.id);
      const waiting = tasks.filter((task) => task.status === "waiting");
      return {
        ...this.dto(run),
        ...(tasks.length
          ? {
              targetCount: tasks.length,
              completedTargets: tasks.filter((task) => task.completedAt).length,
              waitingTargets: waiting.length,
              waitingReason: waiting.some((task) =>
                ["credential_unavailable", "scope_paused"].includes(
                  task.failureCode ?? "",
                ),
              )
                ? "credential_unavailable"
                : waiting.length
                  ? "platform_cooldown"
                  : null,
            }
          : {}),
        attempts: children.length
          ? children.reduce((sum, child) => sum + child.attempts, 0)
          : (job?.attempts ?? 0),
        jobStatus: job?.status ?? null,
        nextRetryAt:
          job?.status === "queued" && (job.attempts > 0 || waiting.length > 0)
            ? job.availableAt.toISOString()
            : null,
      };
    });
  }

  private async assertActor(
    id: string | null,
    db: Prisma.TransactionClient | PrismaService = this.db,
  ) {
    if (!id) return;
    const allowed = await db.user.count({
      where: {
        id,
        isActive: true,
        mustChangePassword: false,
        roles: { some: { role: { in: ["admin", "source"] } } },
      },
    });
    if (!allowed) throw new BadRequestException("抓取发起人的当前权限已失效");
  }
  async recheckPlatform(platform: string, actorId: string) {
    const result = await this.platforms.recheck(platform, actorId);
    if (result.status !== "unverified") return result;
    if (
      !(await this.db.sourceFetchAccountTask.count({
        where: { platform, completedAt: null },
      }))
    ) {
      const accounts = (await this.accounts()).filter(
        (account) => account.platform === platform,
      );
      if (accounts.length)
        await this.runManual(actorId, {
          accountIds: accounts.map((account) => account.id),
        });
    }
    return result;
  }

  async list(): Promise<SourceFetchRunDto[]> {
    const runs = await this.db.sourceFetchRun.findMany({
      include: runDetails,
      orderBy: { startedAt: "desc" },
      take: 20,
    });
    return this.withExecution(runs);
  }

  private accounts(
    accountIds?: string[],
    db: Prisma.TransactionClient | PrismaService = this.db,
  ): Promise<Account[]> {
    return db.authorExternalAccount.findMany({
      where: {
        ...(accountIds?.length ? { id: { in: accountIds } } : {}),
        fetchEnabled: true,
        deletedAt: null,
        author: { deletedAt: null, authorizationStatus: "authorized" },
      },
      include: {
        author: true,
        adapterStates: { omit: { discoveryCheckpointJson: true } },
      },
      orderBy: { id: "asc" },
    });
  }

  private async ensureAdapterStates(accounts: Account[]) {
    if (accounts.length)
      await this.db.sourceAccountScanState.createMany({
        data: accounts.map((account) => ({ accountId: account.id })),
        skipDuplicates: true,
      });
    for (const account of accounts) {
      const known = new Set(
        account.adapterStates.map((state) => state.adapterKey),
      );
      const data = this.sources
        .forPlatform(account.platform)
        .filter((client) => !known.has(client.adapterKey))
        .map((client) => ({
          externalAccountId: account.id,
          adapterKey: client.adapterKey,
          health: client.available
            ? ("idle" as const)
            : ("unavailable" as const),
        }));
      if (data.length)
        await this.db.sourceAdapterState.createMany({
          data,
          skipDuplicates: true,
        });
    }
  }

  private async fetchWithFallback(
    runId: string,
    account: Account,
    createdById: string | null,
    signal: AbortSignal,
  ) {
    let allowMeteredFallback = true;
    let lastFailure: unknown;
    let deferredAdapter: JobDeferred | undefined;
    for (const client of this.sources.forPlatform(account.platform)) {
      const state: FetchState | undefined = account.adapterStates.find(
        (item) => item.adapterKey === client.adapterKey,
      );
      if (!state) continue;
      const previous = await this.db.sourceFetchRunItem.findUnique({
        where: {
          runId_externalAccountId_adapterKey: {
            runId,
            externalAccountId: account.id,
            adapterKey: client.adapterKey,
          },
        },
      });
      if (previous?.status === "succeeded") return;
      // One durable item per run/account/adapter. Resume it instead of violating its unique key.
      if (previous && previous.errorCode !== "interrupted") {
        if (!client.metered && previous.status === "failed")
          allowMeteredFallback =
            state.consecutiveFailures >=
            this.environment.sourceFailureThreshold;
        continue;
      }
      const now = new Date();
      if (
        this.accountExecution.getStore() &&
        state.nextAttemptAt &&
        state.nextAttemptAt > now
      ) {
        if (!deferredAdapter || state.nextAttemptAt < deferredAdapter.retryAt)
          deferredAdapter = new JobDeferred(
            state.nextAttemptAt,
            "platform_cooldown",
          );
        await this.createSkippedItem(runId, account, state, client);
        if (!client.metered) allowMeteredFallback = true;
        continue;
      }
      if (client.metered && !allowMeteredFallback) {
        await this.createSkippedItem(
          runId,
          account,
          state,
          client,
          "fallback_not_ready",
        );
        continue;
      }
      if (
        !state.enabled ||
        !client.available ||
        Boolean(state.nextAttemptAt && state.nextAttemptAt > now) ||
        (client.metered &&
          (this.environment.xOfficialDailyBudget < 1 ||
            this.environment.xOfficialMonthlyBudget < 1))
      ) {
        await this.createSkippedItem(runId, account, state, client);
        continue;
      }
      const leased = await this.db.$transaction(async (tx) => {
        await this.lockSource(tx, account, state, createdById);
        await this.assertEligible(account, state, undefined, tx);
        const scan = await tx.sourceAccountScanState.findUniqueOrThrow({
          where: { accountId: account.id },
        });
        const owner = this.jobs.diagnosticContext?.().jobId ?? runId;
        if (
          scan.leaseUntil &&
          scan.leaseUntil > now &&
          scan.leaseOwnerJobId !== owner
        )
          return { count: 0 };
        const leased = await tx.sourceAdapterState.updateMany({
          where: {
            id: state.id,
            revision: state.revision,
            enabled: true,
            OR: [
              { fetchLeaseUntil: null },
              { fetchLeaseUntil: { lt: now } },
              { fetchLeaseId: runId },
            ],
          },
          data: {
            fetchLeaseId: runId,
            fetchLeaseUntil: new Date(now.getTime() + SOURCE_LEASE_MS),
            lastAttemptAt: now,
            ...(["unavailable", "disabled"].includes(state.health)
              ? { health: "idle" as const }
              : {}),
          },
        });
        if (leased.count) {
          const claimed = await tx.sourceAccountScanState.update({
            where: { accountId: account.id },
            data: {
              leaseOwnerJobId: owner,
              leaseUntil: new Date(now.getTime() + SOURCE_LEASE_MS),
              epoch: { increment: 1 },
              revision: { increment: 1 },
            },
          });
          state.scanEpoch = claimed.epoch;
          state.scanOwnerJobId = owner;
        }
        return leased;
      });
      const item = previous
        ? await this.db.sourceFetchRunItem.update({
            where: { id: previous.id },
            data: {
              status: leased.count ? "running" : "skipped",
              completedAt: null,
              errorCode: leased.count ? null : "already_running",
              errorMessage: leased.count ? null : "该适配器已有抓取任务",
            },
          })
        : await this.db.sourceFetchRunItem.create({
            data: {
              runId,
              externalAccountId: account.id,
              adapterStateId: state.id,
              adapterKey: client.adapterKey,
              cursorBefore: state.cursorJson as Prisma.InputJsonValue,
              status: leased.count ? "running" : "skipped",
              ...(!leased.count
                ? {
                    errorCode: "already_running",
                    errorMessage: "该适配器已有抓取任务",
                  }
                : {}),
            },
          });
      if (!leased.count) {
        await this.db.sourceFetchRunItem.update({
          where: { id: item.id },
          data: { completedAt: new Date() },
        });
        continue;
      }
      if (previous)
        console.info(
          JSON.stringify({
            scope: "source_fetch",
            event: "adapter_resumed",
            runId,
            accountId: account.id,
            adapter: client.adapterKey,
            previousErrorCode: previous.errorCode,
            pagesFetched: previous.pagesFetched,
            mediaStored: previous.mediaStored,
          }),
        );
      const diagnosticContext: Record<string, unknown> = {};
      diagnosticContext.stage = "prepare_scan";
      try {
        await this.fetchAdapter(
          item.id,
          runId,
          account,
          state,
          client,
          createdById,
          signal,
          diagnosticContext,
        );
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof JobDeferred) throw error;
        const execution = this.accountExecution.getStore();
        const shared = platformFailure(error, new Date());
        if (execution && shared) {
          await this.db.$transaction(async (tx) => {
            await this.lockSource(tx, account, state, createdById);
            await this.assertEligible(account, state, runId, tx);
            await this.platforms.outcome(
              tx,
              execution.platform,
              execution.generation,
              error,
            );
            await tx.sourceFetchRunItem.update({
              where: { id: item.id },
              data: {
                status: "failed",
                errorCode: "interrupted",
                errorMessage: "等待平台凭据或冷却恢复",
                completedAt: new Date(),
              },
            });
          });
          throw new JobDeferred(
            shared.cooldownUntil ?? new Date(Date.now() + 900000),
            shared.status === "auth_paused"
              ? "scope_paused"
              : "platform_cooldown",
          );
        }
        const safe = this.safeError(error);
        console.info(
          JSON.stringify({
            scope: "source_fetch",
            event: "adapter_failed",
            runId,
            accountId: account.id,
            adapter: client.adapterKey,
            errorCode: safe.code,
            ...sourceDiagnostic(error, {
              ...diagnosticContext,
              ...this.jobs.diagnosticContext?.(),
              runId,
              accountId: account.id,
              platform: account.platform,
              adapter: client.adapterKey,
            }),
          }),
        );
        const failures = state.consecutiveFailures + 1;
        const cooling = failures >= this.environment.sourceFailureThreshold;
        const current = await this.db.$transaction(async (tx) => {
          await this.lockSource(tx, account, state, createdById);
          await this.jobs.assertCurrentLease(tx);
          const eligible = await tx.authorExternalAccount.count({
            where: this.eligibility(account, state, runId),
          });
          // A pause, identity change or replacement lease invalidates this failure.
          // Only the still-current executor may change health or enable fallback.
          if (!eligible) {
            await tx.sourceFetchRunItem.updateMany({
              where: { id: item.id, status: "running" },
              data: {
                status: "failed",
                errorCode: "source_changed",
                errorMessage: "来源账号、授权或执行租约已变化，请重新同步",
                completedAt: new Date(),
              },
            });
            return false;
          }
          const changed = await tx.sourceAdapterState.updateMany({
            where: {
              id: state.id,
              revision: state.revision,
              fetchLeaseId: runId,
              fetchLeaseUntil: { gt: new Date() },
              enabled: true,
            },
            data: {
              health: cooling ? "cooling_down" : "degraded",
              consecutiveFailures: failures,
              nextAttemptAt: cooling
                ? new Date(
                    Date.now() +
                      this.environment.sourceCooldownMinutes * 60_000,
                  )
                : null,
              lastErrorCode: safe.code,
              lastErrorMessage: safe.message,
              fetchLeaseId: null,
              fetchLeaseUntil: null,
              revision: { increment: 1 },
            },
          });
          if (!changed.count) return false;
          await tx.sourceFetchRunItem.update({
            where: { id: item.id },
            data: {
              status: "failed",
              errorCode: safe.code,
              errorMessage: safe.message,
              completedAt: new Date(),
            },
          });
          return true;
        });
        if (!current) {
          if (execution)
            throw new Error("Source management fence changed", {
              cause: error,
            });
          return;
        }
        if (execution) lastFailure = error;
        if (!client.metered) allowMeteredFallback = cooling;
      } finally {
        await this.db.$transaction(async (tx) => {
          await this.lockSource(tx, account, state, createdById, true);
          const released = await tx.sourceAccountScanState.updateMany({
            where: {
              accountId: account.id,
              epoch: state.scanEpoch ?? -1,
              leaseOwnerJobId: state.scanOwnerJobId ?? runId,
            },
            data: { leaseOwnerJobId: null, leaseUntil: null },
          });
          if (!released.count) return;
          await tx.sourceAdapterState.updateMany({
            where: {
              id: state.id,
              fetchLeaseId: runId,
              revision: state.revision,
            },
            data: { fetchLeaseId: null, fetchLeaseUntil: null },
          });
        });
      }
    }
    if (deferredAdapter) throw deferredAdapter;
    if (lastFailure) throw lastFailure;
  }

  private async createSkippedItem(
    runId: string,
    account: Account,
    state: FetchState,
    client: ContentSourceClient,
    forcedReason?: string,
  ) {
    const reason =
      forcedReason ??
      (!state.enabled
        ? "adapter_disabled"
        : !client.available
          ? "adapter_unavailable"
          : client.metered &&
              (this.environment.xOfficialDailyBudget < 1 ||
                this.environment.xOfficialMonthlyBudget < 1)
            ? "budget_disabled"
            : "adapter_cooling_down");
    const health = !state.enabled
      ? "disabled"
      : !client.available
        ? "unavailable"
        : state.health;
    if (health !== state.health) {
      await this.db.sourceAdapterState.updateMany({
        where: {
          id: state.id,
          revision: state.revision,
          enabled: state.enabled,
          fetchLeaseId: null,
        },
        data: { health },
      });
    }
    return this.db.sourceFetchRunItem.upsert({
      where: {
        runId_externalAccountId_adapterKey: {
          runId,
          externalAccountId: account.id,
          adapterKey: client.adapterKey,
        },
      },
      update: { status: "skipped", errorCode: reason, completedAt: new Date() },
      create: {
        runId,
        externalAccountId: account.id,
        adapterStateId: state.id,
        adapterKey: client.adapterKey,
        cursorBefore: state.cursorJson as Prisma.InputJsonValue,
        status: "skipped",
        errorCode: reason,
        errorMessage:
          reason === "budget_disabled"
            ? "官方 API 回退预算尚未启用"
            : reason === "fallback_not_ready"
              ? "首选免费通道尚未达到回退阈值"
              : "适配器当前不可用",
        completedAt: new Date(),
      },
    });
  }

  private async fetchAdapter(
    itemId: string,
    leaseId: string,
    account: Account,
    state: FetchState,
    client: ContentSourceClient,
    createdById: string | null,
    signal: AbortSignal,
    diagnosticContext: Record<string, unknown> = {},
  ) {
    const scanStartedAt = new Date();
    const timestamp = (value: unknown): string | null => {
      if (typeof value !== "string") return null;
      const at = new Date(value);
      return Number.isFinite(at.getTime()) && at.toISOString() === value
        ? value
        : null;
    };
    const scan = await this.db.sourceAccountScanState.findUniqueOrThrow({
      where: { accountId: account.id },
    });
    const coverage = scan.discoveredThroughAt;
    const sharedWindow = jsonObject(scan.windowJson);
    const hasSharedWindow =
      sharedWindow && Object.keys(sharedWindow).length > 0;
    if (
      hasSharedWindow &&
      (sharedWindow.version !== 1 ||
        sharedWindow.sourceId !== account.externalUserId ||
        !timestamp(sharedWindow.endTime) ||
        (sharedWindow.startTime !== null &&
          !timestamp(sharedWindow.startTime)) ||
        (typeof sharedWindow.startTime === "string" &&
          sharedWindow.startTime > (sharedWindow.endTime as string)) ||
        (sharedWindow.endTime as string) > scanStartedAt.toISOString() ||
        (coverage && new Date(sharedWindow.endTime as string) < coverage))
    )
      throw new Error("Source account scan window binding changed");
    let previous = jsonObject(state.cursorJson) ?? {};
    let previousWindow = jsonObject(previous._sourceScanWindow);
    if (
      hasSharedWindow &&
      (!previousWindow ||
        previousWindow.startTime !== sharedWindow.startTime ||
        previousWindow.endTime !== sharedWindow.endTime)
    ) {
      previous = {};
      previousWindow = null;
    }
    if (!hasSharedWindow && coverage && previousWindow) {
      previous = {};
      previousWindow = null;
    }
    const restartForMode = Boolean(
      !coverage &&
      (hasSharedWindow
        ? sharedWindow.firstSyncMode !== account.firstSyncMode
        : previousWindow &&
          previousWindow.firstSyncMode !== account.firstSyncMode),
    );
    let cursor: SourceCursor;
    let startTime: string | null;
    let endTime: string;
    if (client.adapterKey !== state.adapterKey)
      throw new Error("Source scan adapter binding changed");
    if (previousWindow) {
      const lower = timestamp(previousWindow.startTime);
      const upper = timestamp(previousWindow.endTime);
      if (
        previousWindow.sourceId !== account.externalUserId ||
        previousWindow.adapterKey !== client.adapterKey ||
        (previousWindow.startTime !== null && !lower) ||
        !upper ||
        (previous.startTime ?? null) !== previousWindow.startTime ||
        previous.endTime !== upper ||
        (previous.sourceId !== undefined &&
          previous.sourceId !== account.externalUserId) ||
        (lower && lower > upper) ||
        upper > scanStartedAt.toISOString() ||
        (coverage && new Date(upper) < coverage)
      )
        throw new Error("Source scan window binding changed");
    }
    if (hasSharedWindow && !restartForMode) {
      startTime = sharedWindow.startTime as string | null;
      endTime = sharedWindow.endTime as string;
      cursor = previousWindow
        ? { ...previous }
        : { ...client.initialCursor(account.firstSyncMode, new Date(endTime)) };
    } else if (previousWindow && !restartForMode) {
      startTime = timestamp(previousWindow.startTime);
      endTime = previousWindow.endTime as string;
      cursor = { ...previous };
    } else {
      if (
        previous.sourceId !== undefined &&
        previous.sourceId !== account.externalUserId
      )
        throw new Error("Source scan account binding changed");
      endTime = scanStartedAt.toISOString();
      if (coverage && coverage > scanStartedAt)
        throw new Error("Source scan clock precedes completed coverage");
      const initial = client.initialCursor(
        account.firstSyncMode,
        scanStartedAt,
      );
      startTime = coverage
        ? new Date(
            coverage.getTime() - this.environment.sourceOverlapMinutes * 60_000,
          ).toISOString()
        : timestamp(initial.startTime);
      // Legacy cursors have no trustworthy upper bound. Start from the head,
      // retaining their lower bound only when it widens the required window.
      const legacyLower =
        restartForMode || coverage ? null : timestamp(previous.startTime);
      if (startTime && legacyLower && legacyLower < startTime)
        startTime = legacyLower;
      cursor = { ...initial };
      delete cursor._sourceWindowWatermark;
    }
    const scanWindow = {
      sourceId: account.externalUserId,
      adapterKey: client.adapterKey,
      firstSyncMode: account.firstSyncMode,
      startTime,
      endTime,
    };
    const bindWindow = (value: SourceCursor): SourceCursor => {
      const bound: SourceCursor = {
        ...value,
        endTime,
        _sourceScanWindow: scanWindow,
      };
      if (startTime) bound.startTime = startTime;
      else delete bound.startTime;
      return bound;
    };
    cursor = bindWindow(cursor);
    if (client.prepareCursor)
      cursor = client.prepareCursor(
        {
          externalUserId: account.externalUserId,
          handle: account.handle ?? undefined,
        },
        cursor,
      );
    if ((cursor.startTime ?? null) !== startTime || cursor.endTime !== endTime)
      throw new Error("Source adapter changed the scan window");
    cursor = bindWindow(cursor);
    const discovery = await this.db.sourceAdapterState.findUniqueOrThrow({
      where: { id: state.id },
      select: { discoveryCheckpointJson: true },
    });
    const context = {
      checkpoint: jsonObject(discovery.discoveryCheckpointJson) ?? {},
    };
    let terminalCheckpoint: Prisma.InputJsonValue | undefined;
    const keepLease = this.sourceLeaseKeeper(
      account,
      state,
      leaseId,
      createdById,
    );
    await this.db.$transaction(async (tx) => {
      await this.lockSource(tx, account, state, createdById);
      await this.assertEligible(account, state, leaseId, tx);
      await tx.sourceAccountScanState.updateMany({
        where: {
          accountId: account.id,
          epoch: state.scanEpoch ?? -1,
          leaseOwnerJobId: state.scanOwnerJobId ?? leaseId,
        },
        data: {
          windowJson: {
            version: 1,
            sourceId: account.externalUserId,
            firstSyncMode: account.firstSyncMode,
            startTime,
            endTime,
          },
          revision: { increment: 1 },
        },
      });
      await tx.sourceAdapterState.updateMany({
        where: {
          id: state.id,
          revision: state.revision,
          fetchLeaseId: leaseId,
        },
        data: { cursorJson: cursor as Prisma.InputJsonValue },
      });
    });
    const initialBoundary = startTime ? new Date(startTime) : null;
    const upperBoundary = new Date(endTime);
    const counters = await this.db.sourceFetchRunItem.findUniqueOrThrow({
      where: { id: itemId },
      select: {
        pagesFetched: true,
        itemsSeen: true,
        candidatesCreated: true,
        candidatesExisting: true,
        mediaStored: true,
        apiRequests: true,
      },
    });
    let highTime = state.highWaterPublishedAt;
    let highId = state.highWaterExternalId;
    let observed: { publishedAt: string; externalId: string } | null = null;
    const checkpoint = jsonObject(cursor._sourceWindowWatermark);
    const checkpointAt =
      typeof checkpoint?.publishedAt === "string"
        ? new Date(checkpoint.publishedAt)
        : null;
    if (
      checkpoint &&
      checkpoint.sourceId === account.externalUserId &&
      checkpoint.adapterKey === client.adapterKey &&
      client.adapterKey === state.adapterKey &&
      previousWindow &&
      checkpoint.startTime === startTime &&
      checkpoint.endTime === endTime &&
      (!cursor.sourceId || cursor.sourceId === account.externalUserId) &&
      checkpointAt &&
      Number.isFinite(checkpointAt.getTime()) &&
      checkpointAt.toISOString() === checkpoint.publishedAt &&
      (!initialBoundary || checkpointAt >= initialBoundary) &&
      checkpointAt < upperBoundary &&
      typeof checkpoint.externalId === "string" &&
      checkpoint.externalId.length > 0 &&
      checkpoint.externalId.length <= 200
    ) {
      observed = {
        publishedAt: checkpointAt.toISOString(),
        externalId: checkpoint.externalId,
      };
      if (
        !highTime ||
        checkpointAt > highTime ||
        (checkpointAt.getTime() === highTime.getTime() &&
          this.compareExternalIds(observed.externalId, highId) > 0)
      ) {
        highTime = checkpointAt;
        highId = observed.externalId;
      }
    }
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      Object.assign(diagnosticContext, {
        page: pageNumber + 1,
        windowStart: startTime,
        windowEnd: endTime,
      });
      delete diagnosticContext.postId;
      delete diagnosticContext.mediaId;
      signal.throwIfAborted();
      await keepLease();
      await this.assertActor(createdById);
      await this.assertEligible(account, state, leaseId);
      if (client.metered) await this.consumeMeteredBudget(client.adapterKey);
      counters.apiRequests += 1;
      await this.db.sourceFetchRunItem.update({
        where: { id: itemId },
        data: { apiRequests: counters.apiRequests },
      });
      diagnosticContext.stage = "fetch_page";
      const execution = this.accountExecution.getStore();
      if (execution)
        await this.platforms.beforeNetwork(
          execution.platform,
          execution.generation,
        );
      const page = await client.fetchPage(
        {
          externalUserId: account.externalUserId,
          handle: account.handle ?? undefined,
        },
        cursor,
        context,
      );
      signal.throwIfAborted();
      diagnosticContext.stage = "validate_page";
      await this.assertActor(createdById);
      await this.assertEligible(account, state, leaseId);
      counters.pagesFetched += 1;
      counters.itemsSeen += page.items.length;
      for (const content of page.items) {
        delete diagnosticContext.mediaId;
        diagnosticContext.stage = "validate_post";
        diagnosticContext.postId = content.externalContentId;
        const at = new Date(content.publishedAt);
        if (!Number.isFinite(at.getTime()))
          throw new Error("Source item has an invalid publication timestamp");
        if ((initialBoundary && at < initialBoundary) || at >= upperBoundary)
          continue;
        if (
          Number.isFinite(at.getTime()) &&
          content.externalContentId.length > 0 &&
          content.externalContentId.length <= 200 &&
          (!observed ||
            at > new Date(observed.publishedAt) ||
            (at.getTime() === Date.parse(observed.publishedAt) &&
              this.compareExternalIds(
                content.externalContentId,
                observed.externalId,
              ) > 0))
        )
          observed = {
            publishedAt: at.toISOString(),
            externalId: content.externalContentId,
          };
        if (
          !highTime ||
          at > highTime ||
          (at.getTime() === highTime.getTime() &&
            this.compareExternalIds(content.externalContentId, highId) > 0)
        ) {
          highTime = at;
          highId = content.externalContentId;
        }
        if (content.type === "repost" || !content.ownMedia.length) continue;
        const saved = await this.saveCandidate(
          account,
          state,
          client,
          content,
          createdById,
          leaseId,
          signal,
          keepLease,
          diagnosticContext,
        );
        if (saved.created) {
          counters.candidatesCreated += 1;
          counters.mediaStored += saved.mediaStored;
        } else counters.candidatesExisting += 1;
      }
      if (!page.nextCursor)
        throw new Error("Source adapter did not return a durable cursor");
      cursor = bindWindow(page.nextCursor);
      // The adapter cannot supply provenance for the service's observed data.
      delete cursor._sourceWindowWatermark;
      if (observed)
        cursor._sourceWindowWatermark = {
          sourceId: account.externalUserId,
          adapterKey: client.adapterKey,
          startTime,
          endTime,
          ...observed,
        };
      diagnosticContext.stage = "cursor_commit";
      await this.db.$transaction(async (tx) => {
        await this.lockSource(tx, account, state, createdById);
        await this.assertEligible(account, state, leaseId, tx);
        await tx.sourceAccountScanState.updateMany({
          where: {
            accountId: account.id,
            epoch: state.scanEpoch ?? -1,
            leaseOwnerJobId: state.scanOwnerJobId ?? leaseId,
          },
          data: { leaseUntil: new Date(Date.now() + SOURCE_LEASE_MS) },
        });
        await tx.sourceAdapterState.updateMany({
          where: {
            id: state.id,
            revision: state.revision,
            fetchLeaseId: leaseId,
          },
          data: {
            cursorJson: cursor as Prisma.InputJsonValue,
            fetchLeaseUntil: new Date(Date.now() + SOURCE_LEASE_MS),
          },
        });
        await tx.sourceFetchRunItem.update({
          where: { id: itemId },
          data: counters,
        });
      });
      const boundary = initialBoundary?.getTime() ?? null;
      const crossed =
        page.boundaryReached ??
        (boundary !== null &&
          page.items.length > 0 &&
          page.items.every(
            (item) => new Date(item.publishedAt).getTime() < boundary,
          ));
      if (page.complete || crossed) {
        if (page.checkpoint !== undefined) {
          if (
            !jsonObject(page.checkpoint) ||
            Buffer.byteLength(JSON.stringify(page.checkpoint)) > 4 * 1024 * 1024
          )
            throw new Error(
              "Source discovery checkpoint is invalid or exceeds the size limit",
            );
          terminalCheckpoint = page.checkpoint as Prisma.InputJsonValue;
        }
        break;
      }
      if (pageNumber === 99)
        throw new Error("Source pagination exceeded the safety limit");
    }
    await this.db.$transaction(async (tx) => {
      await this.lockSource(tx, account, state, createdById);
      await this.assertEligible(account, state, leaseId, tx);
      const execution = this.accountExecution.getStore();
      if (execution)
        await this.platforms.outcome(
          tx,
          execution.platform,
          execution.generation,
        );
      const changed = await tx.sourceAdapterState.updateMany({
        where: {
          id: state.id,
          revision: state.revision,
          fetchLeaseId: leaseId,
        },
        data: {
          cursorJson: {},
          highWaterPublishedAt: highTime,
          highWaterExternalId: highId,
          completedThroughAt: upperBoundary,
          ...(terminalCheckpoint === undefined
            ? {}
            : { discoveryCheckpointJson: terminalCheckpoint }),
          health: "healthy",
          lastSuccessAt: new Date(),
          consecutiveFailures: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          fetchLeaseId: null,
          fetchLeaseUntil: null,
          revision: { increment: 1 },
        },
      });
      if (!changed.count)
        throw new Error("Adapter lease expired before committing watermarks");
      const completed = await tx.sourceAccountScanState.updateMany({
        where: {
          accountId: account.id,
          epoch: state.scanEpoch ?? -1,
          leaseOwnerJobId: state.scanOwnerJobId ?? leaseId,
          leaseUntil: { gt: new Date() },
        },
        data: {
          discoveredThroughAt: upperBoundary,
          windowJson: {},
          leaseOwnerJobId: null,
          leaseUntil: null,
          revision: { increment: 1 },
        },
      });
      if (!completed.count)
        throw new Error(
          "Account scan epoch changed before committing coverage",
        );
      await tx.sourceFetchRunItem.update({
        where: { id: itemId },
        data: {
          status: "succeeded",
          errorCode: null,
          errorMessage: null,
          cursorAfter: {},
          ...counters,
          completedAt: new Date(),
        },
      });
    });
    console.info(
      JSON.stringify({
        scope: "source_fetch",
        event: "adapter_succeeded",
        runId: leaseId,
        accountId: account.id,
        adapter: client.adapterKey,
        ...counters,
      }),
    );
  }

  async consumeMeteredBudget(adapterKey: string) {
    const now = new Date();
    const limits = [
      [
        `d:${now.toISOString().slice(0, 10)}`,
        this.environment.xOfficialDailyBudget,
      ],
      [
        `m:${now.toISOString().slice(0, 7)}`,
        this.environment.xOfficialMonthlyBudget,
      ],
    ] as const;
    if (limits.some(([, limit]) => limit < 1))
      throw new Error("X official API fallback budget is disabled");
    await this.db.$transaction(async (tx) => {
      for (const [periodKey, limit] of limits) {
        await tx.sourceAdapterBudgetUsage.upsert({
          where: { adapterKey_periodKey: { adapterKey, periodKey } },
          create: { adapterKey, periodKey },
          update: {},
        });
        const consumed = await tx.sourceAdapterBudgetUsage.updateMany({
          where: { adapterKey, periodKey, used: { lt: limit } },
          data: { used: { increment: 1 } },
        });
        if (!consumed.count)
          throw new Error(
            `X official API ${periodKey[0] === "d" ? "daily" : "monthly"} budget exhausted`,
          );
      }
    });
  }

  private async saveCandidate(
    account: Account,
    state: FetchState,
    client: ContentSourceClient,
    content: NormalizedSourceContent,
    createdById: string | null,
    leaseId: string,
    signal: AbortSignal,
    keepLease = this.sourceLeaseKeeper(account, state, leaseId, createdById),
    diagnosticContext: Record<string, unknown> = {},
  ): Promise<{ created: boolean; mediaStored: number }> {
    diagnosticContext.stage = "candidate_lookup";
    const hashtags = collectHashtags(content.hashtags ?? [], content.text);
    const existing = await this.db.candidatePost.findUnique({
      where: {
        platform_externalPostId: {
          platform: account.platform,
          externalPostId: content.externalContentId,
        },
      },
    });
    if (existing) {
      diagnosticContext.stage = "candidate_observation";
      await this.db.$transaction(async (tx) => {
        await this.lockSource(tx, account, state, createdById);
        await this.assertEligible(account, state, leaseId, tx);
        signal.throwIfAborted();
        // Natural overlap can fill source metadata without downloading again or
        // changing a promoted Work, review status or human revision.
        if (account.platform === "pixiv" && content.description?.trim()) {
          await tx.$queryRaw`SELECT id FROM candidate_posts WHERE id = ${existing.id}::uuid FOR UPDATE`;
          const current = await tx.candidatePost.findUniqueOrThrow({
            where: { id: existing.id },
          });
          const raw =
            current.rawJson &&
            typeof current.rawJson === "object" &&
            !Array.isArray(current.rawJson)
              ? current.rawJson
              : {};
          const rawJson = {
            ...raw,
            ...(content.title?.trim() ? { title: content.title } : {}),
            description: content.description,
          };
          if (
            current.text !== content.description ||
            JSON.stringify(current.rawJson) !== JSON.stringify(rawJson)
          )
            await tx.candidatePost.update({
              where: { id: existing.id },
              data: { text: content.description, rawJson },
            });
        }
        await this.observe(
          tx,
          existing.id,
          account.id,
          state.id,
          client.adapterKey,
          content.rawJson,
        );
        await tx.candidateHashtag.createMany({
          data: hashtags.map((tag) => ({
            candidatePostId: existing.id,
            ...tag,
          })),
          skipDuplicates: true,
        });
        await this.refreshTagDisposition(tx, existing.id);
      });
      return { created: false, mediaStored: 0 };
    }
    const stored: Prisma.FileObjectGetPayload<object>[] = [];
    try {
      for (const media of content.ownMedia) {
        diagnosticContext.mediaId = media.externalMediaId;
        signal.throwIfAborted();
        await keepLease();
        await this.assertActor(createdById);
        await this.assertEligible(account, state, leaseId);
        diagnosticContext.stage = "download";
        const execution = this.accountExecution.getStore();
        if (execution)
          await this.platforms.beforeNetwork(
            execution.platform,
            execution.generation,
          );
        const downloaded = await this.downloader.download(
          media.url,
          client.allowedMediaHosts,
        );
        signal.throwIfAborted();
        await this.assertEligible(account, state, leaseId);
        diagnosticContext.stage = "store";
        stored.push(
          await this.files.store({
            body: downloaded.body,
            contentType: downloaded.contentType,
            bucketScope: "source",
            kind: "candidate-media",
            sourceName: media.url,
            createdById: createdById ?? undefined,
          }),
        );
      }
      await keepLease();
      diagnosticContext.stage = "candidate_commit";
      const candidate = await this.db.$transaction(async (tx) => {
        await this.lockSource(tx, account, state, createdById);
        await this.assertEligible(account, state, leaseId, tx);
        await this.assertActor(createdById, tx);
        signal.throwIfAborted();
        const tagDisposition = await this.tagDisposition(tx, hashtags);
        const created = await tx.candidatePost.create({
          data: {
            authorId: account.authorId,
            authorExternalAccountId: account.id,
            platform: account.platform,
            externalPostId: content.externalContentId,
            externalPostUrl: content.permalink,
            text: content.text,
            referencedPostType:
              content.type === "reply"
                ? "reply"
                : content.type === "quote"
                  ? "quote"
                  : null,
            referencedPostId: content.referencedContentId,
            postedAt: new Date(content.publishedAt),
            rawJson: content.rawJson as Prisma.InputJsonValue,
            tagDisposition,
            hashtags: { create: hashtags },
            sourceObservations: {
              create: {
                externalAccountId: account.id,
                adapterStateId: state.id,
                adapterKey: client.adapterKey,
                rawJson: content.rawJson as Prisma.InputJsonValue,
              },
            },
          },
        });
        await tx.candidateMedia.createMany({
          data: content.ownMedia.map((media, index) => ({
            candidatePostId: created.id,
            externalMediaId: media.externalMediaId,
            orderIndex: index,
            fileObjectId: stored[index].id,
            sourceUrl: media.url,
            width: media.width,
            height: media.height,
            mediaType: media.type,
          })),
        });
        return created;
      });
      if (this.classifier.available) {
        const result = await this.classifier
          .classify({
            candidateId: candidate.id,
            media: stored.map((file) => ({
              fileObjectId: file.id,
              contentType: file.contentType,
            })),
          })
          .catch(() => null);
        if (result) {
          await this.db.candidateClassificationSuggestion.create({
            data: { candidatePostId: candidate.id, ...result },
          });
        }
      }
      return { created: true, mediaStored: stored.length };
    } catch (error) {
      for (const file of stored.reverse())
        await this.files.purgeUnreferenced(file.id).catch(() => undefined);
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        await this.db.$transaction(async (tx) => {
          await this.lockSource(tx, account, state, createdById);
          await this.assertEligible(account, state, leaseId, tx);
          signal.throwIfAborted();
          const duplicate = await tx.candidatePost.findUniqueOrThrow({
            where: {
              platform_externalPostId: {
                platform: account.platform,
                externalPostId: content.externalContentId,
              },
            },
          });
          await this.observe(
            tx,
            duplicate.id,
            account.id,
            state.id,
            client.adapterKey,
            content.rawJson,
          );
          await tx.candidateHashtag.createMany({
            data: hashtags.map((tag) => ({
              candidatePostId: duplicate.id,
              ...tag,
            })),
            skipDuplicates: true,
          });
          await this.refreshTagDisposition(tx, duplicate.id);
        });
        return { created: false, mediaStored: 0 };
      }
      throw error;
    }
  }

  private observe(
    tx: Prisma.TransactionClient,
    candidatePostId: string,
    externalAccountId: string,
    adapterStateId: string,
    adapterKey: string,
    rawJson: Record<string, unknown>,
  ) {
    return tx.candidateSourceObservation.upsert({
      where: { candidatePostId_adapterKey: { candidatePostId, adapterKey } },
      create: {
        candidatePostId,
        externalAccountId,
        adapterStateId,
        adapterKey,
        rawJson: rawJson as Prisma.InputJsonValue,
      },
      update: {
        rawJson: rawJson as Prisma.InputJsonValue,
        lastObservedAt: new Date(),
        observationCount: { increment: 1 },
      },
    });
  }

  private async refreshTagDisposition(
    tx: Prisma.TransactionClient,
    candidatePostId: string,
  ) {
    const hashtags = await tx.candidateHashtag.findMany({
      where: { candidatePostId },
      select: { normalizedValue: true },
    });
    const tagDisposition = await this.tagDisposition(tx, hashtags);
    await tx.candidatePost.update({
      where: { id: candidatePostId },
      data: { tagDisposition },
    });
  }

  private async tagDisposition(
    db: Prisma.TransactionClient | PrismaService,
    hashtags: { normalizedValue: string }[],
  ): Promise<CandidateTagDisposition> {
    if (!hashtags.length) return CandidateTagDisposition.neutral;
    const matches = await db.candidateTagAlias.findMany({
      where: {
        normalizedValue: { in: hashtags.map((tag) => tag.normalizedValue) },
        group: { enabled: true, kind: { in: ["valid", "blocked"] } },
      },
      select: { group: { select: { kind: true } } },
    });
    if (matches.some(({ group }) => group.kind === "blocked"))
      return CandidateTagDisposition.blocked;
    if (matches.some(({ group }) => group.kind === "valid"))
      return CandidateTagDisposition.valid;
    return CandidateTagDisposition.neutral;
  }

  private compareExternalIds(left: string, right: string | null) {
    if (!right) return 1;
    if (/^\d+$/.test(left) && /^\d+$/.test(right))
      return BigInt(left) > BigInt(right)
        ? 1
        : BigInt(left) < BigInt(right)
          ? -1
          : 0;
    return left.localeCompare(right);
  }

  private sourceLeaseKeeper(
    account: Account,
    state: FetchState,
    leaseId: string,
    actorId: string | null,
  ) {
    let renewAt = Date.now() + SOURCE_LEASE_RENEW_MS;
    return async () => {
      if (Date.now() < renewAt) return;
      await this.db.$transaction(async (tx) => {
        await this.lockSource(tx, account, state, actorId);
        await this.assertEligible(account, state, leaseId, tx);
        const changed = await tx.sourceAdapterState.updateMany({
          where: {
            id: state.id,
            revision: state.revision,
            enabled: true,
            fetchLeaseId: leaseId,
            fetchLeaseUntil: { gt: new Date() },
          },
          data: { fetchLeaseUntil: new Date(Date.now() + SOURCE_LEASE_MS) },
        });
        if (!changed.count)
          throw new Error("Source account changed while renewing lease");
        await tx.sourceAccountScanState.updateMany({
          where: {
            accountId: account.id,
            epoch: state.scanEpoch ?? -1,
            leaseOwnerJobId: state.scanOwnerJobId ?? leaseId,
            leaseUntil: { gt: new Date() },
          },
          data: { leaseUntil: new Date(Date.now() + SOURCE_LEASE_MS) },
        });
      });
      renewAt = Date.now() + SOURCE_LEASE_RENEW_MS;
    };
  }

  private async lockSource(
    tx: Prisma.TransactionClient,
    account: Account,
    state: FetchState,
    actorId: string | null,
    cleanup = false,
  ) {
    // Match management writes: archive locks author before accounts; account
    // replacement/unbind locks account before states. Network I/O stays outside.
    await this.jobs.assertCurrentLease(tx);
    // Account administration updates the parent user before replacing roles.
    // Hold that same row while checking actor eligibility and committing writes.
    if (actorId) {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`;
      if (!cleanup) await this.assertActor(actorId, tx);
    }
    const execution = this.accountExecution.getStore();
    if (execution) {
      await this.platforms.lock(tx, execution.platform);
      if (
        !(await tx.sourcePlatformState.count({
          where: {
            platform: execution.platform,
            credentialGeneration: execution.generation,
          },
        }))
      )
        throw new ConflictException("Credential generation changed");
    }
    await tx.$queryRaw`SELECT id FROM authors WHERE id = ${account.authorId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM author_external_accounts WHERE id = ${account.id}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT account_id FROM source_account_scan_states WHERE account_id = ${account.id}::uuid FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM source_adapter_states WHERE id = ${state.id}::uuid FOR NO KEY UPDATE`;
  }

  private eligibility(
    account: Account,
    state: FetchState,
    leaseId: string | undefined,
  ): Prisma.AuthorExternalAccountWhereInput {
    return {
      id: account.id,
      revision: account.revision,
      fetchEnabled: true,
      deletedAt: null,
      author: {
        deletedAt: null,
        authorizationStatus: "authorized",
        revision: account.author.revision,
      },
      ...(leaseId
        ? {
            scanState: {
              is: {
                epoch: state.scanEpoch ?? -1,
                leaseOwnerJobId: state.scanOwnerJobId ?? leaseId,
                leaseUntil: { gt: new Date() },
              },
            },
          }
        : {}),
      adapterStates: {
        some: {
          id: state.id,
          revision: state.revision,
          enabled: true,
          ...(leaseId
            ? { fetchLeaseId: leaseId, fetchLeaseUntil: { gt: new Date() } }
            : {}),
        },
      },
    };
  }

  private async assertEligible(
    account: Account,
    state: FetchState,
    leaseId: string | undefined,
    db: Prisma.TransactionClient | PrismaService = this.db,
  ) {
    await this.jobs.assertCurrentLease(db);
    const eligible = await db.authorExternalAccount.count({
      where: this.eligibility(account, state, leaseId),
    });
    if (!eligible) {
      throw new Error("Source account changed while fetching");
    }
  }

  private safeError(error: unknown) {
    if (error instanceof SourceResponseError)
      return { code: error.code, message: error.message };
    const name = error instanceof Error ? error.name : "Error";
    const message = "抓取未完成，请检查适配器配置、预算及授权后重试";
    return {
      code: name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "Error",
      message: message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500),
    };
  }

  private dto(run: RunDetails): SourceFetchRunDto {
    return {
      attempts: 0,
      jobStatus: null,
      nextRetryAt: null,
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      requestedById: run.requestedById,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      items: run.items.map((item) => ({
        id: item.id,
        externalAccountId: item.externalAccountId,
        authorName: item.externalAccount.author.displayName,
        platform: item.externalAccount.platform,
        adapterKey: item.adapterKey,
        adapterHealth: item.adapterState.health,
        status: item.status,
        pagesFetched: item.pagesFetched,
        itemsSeen: item.itemsSeen,
        candidatesCreated: item.candidatesCreated,
        candidatesExisting: item.candidatesExisting,
        mediaStored: item.mediaStored,
        apiRequests: item.apiRequests,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        startedAt: item.startedAt.toISOString(),
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    };
  }
}
