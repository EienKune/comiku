import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isUUID } from "class-validator";
import {
  Prisma,
  type SourceAdapterHealth,
  type JobStatus,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  controlledFailureDetails,
  type SourceFailureScope,
} from "./source-diagnostics.js";
import { ContentSourceRegistry } from "./source-registry.js";
import { sourceExecutionEvidence } from "./source-execution-evidence.js";
import type {
  SourceRunPageDto,
  SourceRunQueryDto,
  SourceRunSummaryDto,
  SourceTaskDetailDto,
  SourceTaskPageDto,
  SourceTaskQueryDto,
  SourceTaskRowDto,
  SourceEvidenceQueryDto,
  SourceExecutionPageDto,
  SourceExecutionDto,
  SourceExecutionDiagnosticsDto,
  SourceDiagnosticSampleDto,
  SourceGapPageDto,
} from "./source-history.dto.js";

type RunRow = Omit<
  SourceRunSummaryDto,
  | "startedAt"
  | "completedAt"
  | "pagesFetched"
  | "candidatesCreated"
  | "mediaStored"
> & {
  startedAt: Date;
  completedAt: Date | null;
  pagesFetched: bigint;
  candidatesCreated: bigint;
  mediaStored: bigint;
};
type TaskRow = Omit<
  SourceTaskRowDto,
  | "startedAt"
  | "completedAt"
  | "deferredUntil"
  | "pagesFetched"
  | "candidatesCreated"
  | "mediaStored"
> & {
  startedAt: Date | null;
  completedAt: Date | null;
  deferredUntil: Date | null;
  pagesFetched: bigint;
  candidatesCreated: bigint;
  mediaStored: bigint;
};
type Db = Pick<Prisma.TransactionClient, "$queryRaw">;
type Cursor = {
  v: 1;
  scope: string;
  id: string;
  accountId?: string;
  startedAt?: string;
};
function decode(value: string | undefined, scope: string): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (
      cursor.v !== 1 ||
      cursor.scope !== scope ||
      !isUUID(cursor.id) ||
      (cursor.accountId !== undefined && !isUUID(cursor.accountId)) ||
      (cursor.startedAt !== undefined &&
        (!Number.isFinite(Date.parse(cursor.startedAt)) ||
          new Date(cursor.startedAt).toISOString() !== cursor.startedAt))
    )
      throw new Error();
    return cursor;
  } catch {
    throw new BadRequestException("Invalid history cursor");
  }
}
const encode = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
const iso = (value: Date | null) => value?.toISOString() ?? null;
function reason(code: string | null): string | null {
  if (code === null) return null;
  if (
    [
      "discovery_gaps",
      "worker_attempts_exhausted",
      "account_failed",
      "retry_pending",
      "interrupted",
      "already_running",
      "source_changed",
      "capacity",
      "credential_unavailable",
      "scope_paused",
      "platform_maintenance",
      "platform_auth_paused",
      "platform_cooldown",
      "scan_busy",
      "scan_epoch_stale",
      "account_unavailable",
      "source_unavailable",
      "outside_window_or_unsupported",
    ].includes(code)
  )
    return code;
  return controlledFailureDetails({ reason: code, scope: "source" }).reason;
}
function summary(row: RunRow): SourceRunSummaryDto {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    completedAt: iso(row.completedAt),
    legacy: row.legacy,
    targetCount: Number(row.targetCount),
    completedTargets: Number(row.completedTargets),
    succeededTargets: Number(row.succeededTargets),
    failedTargets: Number(row.failedTargets),
    runningTargets: Number(row.runningTargets),
    queuedTargets: Number(row.queuedTargets),
    waitingTargets: Number(row.waitingTargets),
    anomalyTargets: Number(row.anomalyTargets),
    pagesFetched: Number(row.pagesFetched),
    candidatesCreated: Number(row.candidatesCreated),
    mediaStored: Number(row.mediaStored),
  };
}
function taskRow(row: TaskRow): SourceTaskRowDto {
  return {
    id: row.id,
    accountId: row.accountId,
    authorName: row.authorName,
    platform: row.platform,
    handle: row.handle,
    externalUserId: row.externalUserId,
    status: row.status,
    failureCode: reason(row.failureCode),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    deferredUntil: iso(row.deferredUntil),
    legacy: row.legacy,
    pagesFetched: Number(row.pagesFetched),
    candidatesCreated: Number(row.candidatesCreated),
    mediaStored: Number(row.mediaStored),
  };
}
function limit(value: number | undefined, fallback: number, max: number) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw new BadRequestException("Invalid history limit");
  return result;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Revalidate persisted JSON at the API boundary; never trust a writer's historical sanitizer. */
function diagnostics(value: unknown): SourceExecutionDiagnosticsDto {
  const input = object(value);
  const raw = Array.isArray(input.samples) ? input.samples : [];
  const stages = new Set(
    "execution prepare_scan recovery_prepare fetch_page fetch_post validate_post download store sign missing cleanup".split(
      " ",
    ),
  );
  const samples: SourceDiagnosticSampleDto[] = [];
  for (let i = 0; i < Math.min(raw.length, 8); i++) {
    const entry = object(raw[i]);
    const failure = controlledFailureDetails({
      reason:
        typeof entry.reason === "string" ? entry.reason : "unknown_failure",
      scope: entry.scope as SourceFailureScope,
    });
    const occurredAt =
      typeof entry.occurredAt === "string" &&
      entry.occurredAt.length <= 32 &&
      Number.isFinite(Date.parse(entry.occurredAt))
        ? new Date(entry.occurredAt).toISOString()
        : null;
    const sample: SourceDiagnosticSampleDto = {
      stage:
        typeof entry.stage === "string" && stages.has(entry.stage)
          ? entry.stage
          : "execution",
      reason: reason(
        typeof entry.reason === "string" ? entry.reason : "unknown_failure",
      )!,
      scope: failure.scope,
      occurredAt,
    };
    for (const field of [
      "httpStatus",
      "limitBytes",
      "declaredBytes",
      "observedBytes",
      "durationMs",
    ] as const) {
      const number = entry[field];
      if (
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number >= 0 &&
        (field !== "httpStatus" || (number >= 100 && number <= 599))
      )
        sample[field] = number;
    }
    if (typeof entry.timeout === "boolean") sample.timeout = entry.timeout;
    samples.push({ ...sample, ...sourceExecutionEvidence(entry) });
  }
  const omitted =
    typeof input.omitted === "number" &&
    Number.isSafeInteger(input.omitted) &&
    input.omitted >= 0
      ? input.omitted
      : 0;
  return {
    samples,
    omitted: Math.min(
      Number.MAX_SAFE_INTEGER,
      omitted + Math.max(0, raw.length - 8),
    ),
  };
}

/** Technical history is database-only; registry availability is read without calling source clients. */
@Injectable()
export class SourceHistoryService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ContentSourceRegistry)
    private readonly sources: ContentSourceRegistry,
  ) {}

  private runs(db: Db, where: Prisma.Sql, take: number): Promise<RunRow[]> {
    // Bound the run IDs before independently aggregating tasks and result items.
    // Never join the two child sets: doing so multiplies every counter.
    return db.$queryRaw<RunRow[]>(Prisma.sql`
      WITH selected AS MATERIALIZED (
        SELECT id,trigger,status,started_at,completed_at FROM source_fetch_runs
        WHERE ${where} ORDER BY started_at DESC,id DESC LIMIT ${take}
      ), task_totals AS (
        SELECT t.run_id,count(*)::int AS targets,
          count(*) FILTER(WHERE t.status IN ('succeeded','failed'))::int AS completed,
          count(*) FILTER(WHERE t.status='succeeded' AND t.failure_code IS DISTINCT FROM 'discovery_gaps')::int AS succeeded,
          count(*) FILTER(WHERE t.status='failed')::int AS failed,
          count(*) FILTER(WHERE t.status='running')::int AS running,
          count(*) FILTER(WHERE t.status='queued')::int AS queued,
          count(*) FILTER(WHERE t.status='waiting')::int AS waiting,
          count(*) FILTER(WHERE t.status='failed' OR t.failure_code='discovery_gaps')::int AS anomalies
        FROM source_fetch_account_tasks t JOIN selected r ON r.id=t.run_id GROUP BY t.run_id
      ), item_accounts AS (
        SELECT i.run_id,i.external_account_id,
          bool_or(i.status='running') AS running,bool_or(i.status='failed') AS failed,
          bool_or(i.error_code='discovery_gaps') AS gaps
        FROM source_fetch_run_items i JOIN selected r ON r.id=i.run_id
        GROUP BY i.run_id,i.external_account_id
      ), legacy_totals AS (
        SELECT run_id,count(*)::int AS targets,count(*) FILTER(WHERE NOT running)::int AS completed,
          count(*) FILTER(WHERE NOT running AND NOT failed AND NOT coalesce(gaps,false))::int AS succeeded,
          count(*) FILTER(WHERE failed)::int AS failed,count(*) FILTER(WHERE running)::int AS running,
          count(*) FILTER(WHERE failed OR gaps)::int AS anomalies FROM item_accounts GROUP BY run_id
      ), item_totals AS (
        SELECT i.run_id,sum(i.pages_fetched) AS pages,sum(i.candidates_created) AS candidates,sum(i.media_stored) AS media
        FROM source_fetch_run_items i JOIN selected r ON r.id=i.run_id GROUP BY i.run_id
      )
      SELECT r.id,r.trigger,r.status,r.started_at AS "startedAt",r.completed_at AS "completedAt",
        (t.run_id IS NULL) AS legacy,
        coalesce(t.targets,l.targets,0)::int AS "targetCount",coalesce(t.completed,l.completed,0)::int AS "completedTargets",
        coalesce(t.succeeded,l.succeeded,0)::int AS "succeededTargets",coalesce(t.failed,l.failed,0)::int AS "failedTargets",
        coalesce(t.running,l.running,0)::int AS "runningTargets",coalesce(t.queued,0)::int AS "queuedTargets",
        coalesce(t.waiting,0)::int AS "waitingTargets",coalesce(t.anomalies,l.anomalies,0)::int AS "anomalyTargets",
        coalesce(i.pages,0)::bigint AS "pagesFetched",coalesce(i.candidates,0)::bigint AS "candidatesCreated",coalesce(i.media,0)::bigint AS "mediaStored"
      FROM selected r LEFT JOIN task_totals t ON t.run_id=r.id LEFT JOIN legacy_totals l ON l.run_id=r.id
      LEFT JOIN item_totals i ON i.run_id=r.id ORDER BY r.started_at DESC,r.id DESC
    `);
  }

  async list(query: SourceRunQueryDto): Promise<SourceRunPageDto> {
    const take = limit(query.limit, 10, 50);
    const scope = JSON.stringify([
      "runs",
      query.trigger ?? null,
      query.status ?? null,
    ]);
    const cursor = decode(query.cursor, scope);
    if (cursor && !cursor.startedAt)
      throw new BadRequestException("Invalid history cursor");
    const where = Prisma.join(
      [
        Prisma.sql`true`,
        ...(query.trigger
          ? [Prisma.sql`trigger=${query.trigger}::"SourceFetchTrigger"`]
          : []),
        ...(query.status
          ? [Prisma.sql`status=${query.status}::"SourceFetchRunStatus"`]
          : []),
        ...(cursor
          ? [
              Prisma.sql`(started_at,id)<(${new Date(cursor.startedAt!)},${cursor.id}::uuid)`,
            ]
          : []),
      ],
      " AND ",
    );
    const rows = await this.runs(this.db, where, take + 1);
    const hasMore = rows.length > take;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map(summary),
      nextCursor:
        hasMore && last
          ? encode({
              v: 1,
              scope,
              id: last.id,
              startedAt: last.startedAt.toISOString(),
            })
          : null,
      observedAt: new Date().toISOString(),
    };
  }
  private async run(db: Db, id: string) {
    const rows = await this.runs(db, Prisma.sql`id=${id}::uuid`, 1);
    if (!rows[0]) throw new NotFoundException("Source run not found");
    return rows[0];
  }
  async get(id: string): Promise<SourceRunSummaryDto> {
    return summary(await this.run(this.db, id));
  }

  private members(
    db: Db,
    runId: string,
    legacy: boolean,
    query: SourceTaskQueryDto,
    take: number,
    taskId?: string,
  ): Promise<TaskRow[]> {
    const scope = JSON.stringify([
      "tasks",
      runId,
      legacy,
      query.platform ?? null,
      query.status ?? "all",
      query.search?.trim() ?? "",
    ]);
    const cursor = decode(query.cursor, scope);
    if (cursor && !cursor.accountId)
      throw new BadRequestException("Invalid history cursor");
    const search = query.search?.trim().replace(/[\\%_]/g, "\\$&");
    const filters = [Prisma.sql`true`];
    if (query.platform) filters.push(Prisma.sql`m.platform=${query.platform}`);
    if (taskId) filters.push(Prisma.sql`m.id=${taskId}::uuid`);
    if (cursor)
      filters.push(
        Prisma.sql`(m.account_id,m.id)>(${cursor.accountId}::uuid,${cursor.id}::uuid)`,
      );
    if (search)
      filters.push(
        Prisma.sql`(a.external_user_id ILIKE ${`%${search}%`} OR a.handle ILIKE ${`%${search}%`} OR a.display_name_snapshot ILIKE ${`%${search}%`} OR u.display_name ILIKE ${`%${search}%`})`,
      );
    if (query.status === "anomalies")
      filters.push(
        Prisma.sql`(m.status='failed' OR m.failure_code='discovery_gaps')`,
      );
    else if (query.status === "active")
      filters.push(Prisma.sql`m.status IN ('queued','running','waiting')`);
    else if (query.status && query.status !== "all")
      filters.push(Prisma.sql`m.status=${query.status}`);
    const source = legacy
      ? Prisma.sql`
      SELECT i.id,i.external_account_id AS account_id,a.platform,i.status::text AS status,i.error_code AS failure_code,
        i.started_at,i.completed_at,NULL::timestamptz AS deferred_until,
        i.pages_fetched::bigint AS pages,i.candidates_created::bigint AS candidates,i.media_stored::bigint AS media
      FROM source_fetch_run_items i JOIN author_external_accounts a ON a.id=i.external_account_id WHERE i.run_id=${runId}::uuid
    `
      : Prisma.sql`
      SELECT t.id,t.account_id,t.platform,t.status::text AS status,t.failure_code,t.started_at,t.completed_at,t.deferred_until,
        0::bigint AS pages,0::bigint AS candidates,0::bigint AS media
      FROM source_fetch_account_tasks t WHERE t.run_id=${runId}::uuid
    `;
    return db.$queryRaw<TaskRow[]>(Prisma.sql`
      WITH members AS (${source}), selected AS MATERIALIZED (
        SELECT m.*,u.display_name AS author_name,a.handle,a.external_user_id
        FROM members m JOIN author_external_accounts a ON a.id=m.account_id JOIN authors u ON u.id=a.author_id
        WHERE ${Prisma.join(filters, " AND ")} ORDER BY m.account_id,m.id LIMIT ${take}
      ), totals AS (
        SELECT i.external_account_id,sum(i.pages_fetched) AS pages,sum(i.candidates_created) AS candidates,sum(i.media_stored) AS media,
          (array_agg(i.error_code ORDER BY i.started_at DESC,i.id DESC) FILTER(WHERE i.error_code IS NOT NULL))[1] AS error_code
        FROM source_fetch_run_items i JOIN (SELECT DISTINCT account_id FROM selected) p ON p.account_id=i.external_account_id
        WHERE i.run_id=${runId}::uuid GROUP BY i.external_account_id
      )
      SELECT p.id,p.account_id AS "accountId",p.author_name AS "authorName",p.platform,p.handle,p.external_user_id AS "externalUserId",
        p.status,coalesce(CASE WHEN p.failure_code IN ('account_failed','retry_pending') THEN i.error_code END,p.failure_code) AS "failureCode",p.started_at AS "startedAt",p.completed_at AS "completedAt",p.deferred_until AS "deferredUntil",
        ${legacy}::boolean AS legacy,
        CASE WHEN ${legacy} THEN p.pages ELSE coalesce(i.pages,0) END::bigint AS "pagesFetched",
        CASE WHEN ${legacy} THEN p.candidates ELSE coalesce(i.candidates,0) END::bigint AS "candidatesCreated",
        CASE WHEN ${legacy} THEN p.media ELSE coalesce(i.media,0) END::bigint AS "mediaStored"
      FROM selected p LEFT JOIN totals i ON i.external_account_id=p.account_id ORDER BY p.account_id,p.id
    `);
  }

  async tasks(
    runId: string,
    query: SourceTaskQueryDto,
  ): Promise<SourceTaskPageDto> {
    const take = limit(query.limit, 20, 100);
    return this.db.$transaction(
      async (tx) => {
        const run = await this.run(tx, runId);
        const rows = await this.members(tx, runId, run.legacy, query, take + 1);
        const hasMore = rows.length > take;
        if (hasMore) rows.pop();
        const last = rows.at(-1);
        const scope = JSON.stringify([
          "tasks",
          runId,
          run.legacy,
          query.platform ?? null,
          query.status ?? "all",
          query.search?.trim() ?? "",
        ]);
        return {
          items: rows.map(taskRow),
          legacy: run.legacy,
          observedAt: new Date().toISOString(),
          nextCursor:
            hasMore && last
              ? encode({ v: 1, scope, id: last.id, accountId: last.accountId })
              : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async task(runId: string, taskId: string): Promise<SourceTaskDetailDto> {
    return this.db.$transaction(
      async (tx) => {
        const run = await this.run(tx, runId);
        const rows = await this.members(tx, runId, run.legacy, {}, 1, taskId);
        const original = rows[0];
        if (!original) throw new NotFoundException("Source task not found");
        const activeAdapters = this.sources
          .forPlatform(original.platform)
          .filter((client) => client.available)
          .map((client) => client.adapterKey);
        const adapterFilter = activeAdapters.length
          ? Prisma.sql`s.adapter_key IN (${Prisma.join(activeAdapters)})`
          : Prisma.sql`false`;
        const currentRows = await tx.$queryRaw<
          {
            fetchEnabled: boolean;
            deletedAt: Date | null;
            adapterHealth: SourceAdapterHealth | null;
            unresolvedGapCount: bigint;
            excludedGapCount: bigint;
          }[]
        >(Prisma.sql`
        WITH gaps AS (
          SELECT count(*) FILTER(WHERE state NOT IN ('complete','excluded')) AS unresolved,
            count(*) FILTER(WHERE state='excluded') AS excluded FROM source_discovery_posts WHERE account_id=${original.accountId}::uuid
        )
        SELECT a.fetch_enabled AS "fetchEnabled",a.deleted_at AS "deletedAt",
          (SELECT CASE WHEN s.health IN ('unavailable','disabled') THEN 'idle'::"SourceAdapterHealth" ELSE s.health END
            FROM source_adapter_states s WHERE s.external_account_id=a.id AND s.enabled AND ${adapterFilter}
            ORDER BY CASE s.health WHEN 'unavailable' THEN 0 WHEN 'cooling_down' THEN 1 WHEN 'degraded' THEN 2 WHEN 'disabled' THEN 3 WHEN 'idle' THEN 4 ELSE 5 END,s.id LIMIT 1) AS "adapterHealth",
          g.unresolved AS "unresolvedGapCount",g.excluded AS "excludedGapCount"
        FROM author_external_accounts a CROSS JOIN gaps g WHERE a.id=${original.accountId}::uuid
      `);
        const successes = await tx.$queryRaw<
          { taskId: string; runId: string; completedAt: Date }[]
        >(Prisma.sql`
        SELECT t.id AS "taskId",t.run_id AS "runId",t.completed_at AS "completedAt"
        FROM source_fetch_account_tasks t JOIN source_fetch_runs r ON r.id=t.run_id
        WHERE t.account_id=${original.accountId}::uuid AND t.status='succeeded'
          AND t.failure_code IS NULL AND t.completed_at IS NOT NULL AND t.run_id<>${runId}::uuid
          AND t.completed_at>${original.completedAt ?? run.startedAt}
          AND (r.started_at,r.id)>(${run.startedAt},${runId}::uuid)
        ORDER BY t.completed_at DESC,t.id DESC LIMIT 1
      `);
        const current = currentRows[0];
        const success = successes[0];
        const jobs = run.legacy
          ? []
          : await tx.$queryRaw<
              { status: JobStatus; attempts: number; availableAt: Date }[]
            >(Prisma.sql`
          SELECT j.status,j.attempts,j.available_at AS "availableAt"
          FROM source_fetch_account_tasks t JOIN background_jobs j ON j.id=t.job_id
          WHERE t.id=${taskId}::uuid AND t.run_id=${runId}::uuid
        `);
        const job = jobs[0];
        const executionRecords = run.legacy
          ? []
          : await tx.$queryRaw<{ available: boolean }[]>(Prisma.sql`
          SELECT EXISTS(SELECT 1 FROM source_platform_executions WHERE task_id=${taskId}::uuid AND kind='scan') AS available
        `);
        return {
          original: taskRow(original),
          current: current
            ? {
                fetchEnabled: current.fetchEnabled,
                deletedAt: iso(current.deletedAt),
                adapterHealth: current.adapterHealth,
                unresolvedGapCount: Number(current.unresolvedGapCount),
                excludedGapCount: Number(current.excludedGapCount),
              }
            : null,
          followupSuccess: success
            ? {
                taskId: success.taskId,
                runId: success.runId,
                completedAt: success.completedAt.toISOString(),
              }
            : null,
          job: job
            ? {
                status: job.status,
                attempts: job.attempts,
                nextAvailableAt:
                  job.status === "queued"
                    ? job.availableAt.toISOString()
                    : null,
                nextRetryAt:
                  job.status === "queued" &&
                  job.attempts > 0 &&
                  job.attempts < 3 &&
                  original.status !== "waiting"
                    ? job.availableAt.toISOString()
                    : null,
              }
            : null,
          executionHistoryAvailable: executionRecords[0]?.available === true,
          observedAt: new Date().toISOString(),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async member(db: Db, runId: string, taskId: string) {
    const run = await this.run(db, runId);
    const rows = await this.members(db, runId, run.legacy, {}, 1, taskId);
    if (!rows[0]) throw new NotFoundException("Source task not found");
    return { run, original: rows[0] };
  }

  async executions(
    runId: string,
    taskId: string,
    query: SourceEvidenceQueryDto,
  ): Promise<SourceExecutionPageDto> {
    const take = limit(query.limit, 20, 100);
    const scope = JSON.stringify(["executions", runId, taskId]);
    const cursor = decode(query.cursor, scope);
    if (cursor && !cursor.startedAt)
      throw new BadRequestException("Invalid history cursor");
    return this.db.$transaction(
      async (tx) => {
        const { run } = await this.member(tx, runId, taskId);
        if (run.legacy)
          return {
            items: [],
            nextCursor: null,
            observedAt: new Date().toISOString(),
            scope: "scan",
            legacy: true,
          };
        const after = cursor
          ? Prisma.sql`AND (admitted_at,id)<(${new Date(cursor.startedAt!)},${cursor.id}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<
          {
            id: string;
            budgetAttempt: number;
            budgetRefunded: boolean;
            admittedAt: Date;
            businessOutcome: unknown;
            businessFinishedAt: Date | null;
            settledAt: Date | null;
            diagnosticJson: unknown;
          }[]
        >(Prisma.sql`
        SELECT id,budget_attempt AS "budgetAttempt",budget_refunded AS "budgetRefunded",admitted_at AS "admittedAt",
          business_outcome AS "businessOutcome",business_finished_at AS "businessFinishedAt",settled_at AS "settledAt",diagnostic_json AS "diagnosticJson"
        FROM source_platform_executions WHERE task_id=${taskId}::uuid AND kind='scan' ${after}
        ORDER BY admitted_at DESC,id DESC LIMIT ${take + 1}
      `);
        const hasMore = rows.length > take;
        if (hasMore) rows.pop();
        const last = rows.at(-1);
        const items: SourceExecutionDto[] = rows.map((row) => ({
          id: row.id,
          kind: "scan",
          budgetAttempt: row.budgetAttempt,
          budgetRefunded: row.budgetRefunded,
          admittedAt: row.admittedAt.toISOString(),
          businessOutcome:
            typeof row.businessOutcome === "string" &&
            ["succeeded", "partial_failed", "failed", "deferred"].includes(
              row.businessOutcome,
            )
              ? (row.businessOutcome as SourceExecutionDto["businessOutcome"])
              : null,
          businessFinishedAt: iso(row.businessFinishedAt),
          settledAt: iso(row.settledAt),
          diagnostics: diagnostics(row.diagnosticJson),
        }));
        return {
          items,
          nextCursor:
            hasMore && last
              ? encode({
                  v: 1,
                  scope,
                  id: last.id,
                  startedAt: last.admittedAt.toISOString(),
                })
              : null,
          observedAt: new Date().toISOString(),
          scope: "scan",
          legacy: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async gaps(
    runId: string,
    taskId: string,
    query: SourceEvidenceQueryDto,
  ): Promise<SourceGapPageDto> {
    const take = limit(query.limit, 20, 100);
    const scope = JSON.stringify(["gaps", runId, taskId]);
    const cursor = decode(query.cursor, scope);
    if (cursor && !cursor.startedAt)
      throw new BadRequestException("Invalid history cursor");
    return this.db.$transaction(
      async (tx) => {
        const { run, original } = await this.member(tx, runId, taskId);
        const after = cursor
          ? Prisma.sql`AND (created_at,id)<(${new Date(cursor.startedAt!)},${cursor.id}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<
          {
            id: string;
            postId: string;
            platform: string;
            state: string;
            failureCode: string | null;
            attempts: number;
            nextRetryAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
          }[]
        >(Prisma.sql`
        SELECT id,external_post_id AS "postId",platform,state,failure_code AS "failureCode",attempts,next_retry_at AS "nextRetryAt",
          created_at AS "createdAt",updated_at AS "updatedAt" FROM source_discovery_posts
        WHERE account_id=${original.accountId}::uuid AND state NOT IN ('complete','excluded') ${after}
        ORDER BY created_at DESC,id DESC LIMIT ${take + 1}
      `);
        const hasMore = rows.length > take;
        if (hasMore) rows.pop();
        const campaigns = rows.length
          ? await tx.$queryRaw<
              {
                discoveryPostId: string;
                number: number;
                state: string;
                failureCode: string | null;
                startedAt: Date;
                completedAt: Date | null;
              }[]
            >(Prisma.sql`
        SELECT DISTINCT ON (discovery_post_id) discovery_post_id AS "discoveryPostId",number,state,
          failure_code AS "failureCode",started_at AS "startedAt",completed_at AS "completedAt"
        FROM source_recovery_campaigns WHERE discovery_post_id IN (${Prisma.join(rows.map((row) => Prisma.sql`${row.id}::uuid`))})
        ORDER BY discovery_post_id,number DESC,id DESC
      `)
          : [];
        const campaignByPost = new Map(
          campaigns.map((campaign) => [campaign.discoveryPostId, campaign]),
        );
        const last = rows.at(-1);
        return {
          items: rows.map((row) => {
            const campaign = campaignByPost.get(row.id);
            return {
              id: row.id,
              postId: row.postId,
              platform: row.platform,
              state: [
                "metadata_pending",
                "media_pending",
                "needs_attention",
              ].includes(row.state)
                ? row.state
                : "unknown",
              failureCode: reason(row.failureCode),
              attempts: row.attempts,
              nextRetryAt: iso(row.nextRetryAt),
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              campaign: campaign
                ? {
                    number: campaign.number,
                    state: [
                      "queued",
                      "running",
                      "succeeded",
                      "failed",
                    ].includes(campaign.state)
                      ? campaign.state
                      : "unknown",
                    failureCode: reason(campaign.failureCode),
                    startedAt: campaign.startedAt.toISOString(),
                    completedAt: iso(campaign.completedAt),
                  }
                : null,
            };
          }),
          nextCursor:
            hasMore && last
              ? encode({
                  v: 1,
                  scope,
                  id: last.id,
                  startedAt: last.createdAt.toISOString(),
                })
              : null,
          observedAt: new Date().toISOString(),
          scope: "current_account",
          legacy: run.legacy,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
