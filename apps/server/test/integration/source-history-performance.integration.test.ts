import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { SourceHistoryService } from "../../src/source-ingestion/source-history.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import type { ContentSourceClient } from "../../src/source-ingestion/content-source.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");

type PlanNode = {
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Local Hit Blocks"?: number;
  "Local Read Blocks"?: number;
  "Temp Read Blocks"?: number;
  "Temp Written Blocks"?: number;
  Plans?: PlanNode[];
};
function planMetrics(node: PlanNode) {
  const rows = (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1);
  let operatorRows = rows;
  for (const child of node.Plans ?? [])
    operatorRows += planMetrics(child).operatorRows;
  return {
    rows,
    // Sum of operator outputs, including loops; this is work evidence, not distinct source rows.
    operatorRows,
    buffers: {
      sharedHit: node["Shared Hit Blocks"] ?? 0,
      sharedRead: node["Shared Read Blocks"] ?? 0,
      localHit: node["Local Hit Blocks"] ?? 0,
      localRead: node["Local Read Blocks"] ?? 0,
      tempRead: node["Temp Read Blocks"] ?? 0,
      tempWritten: node["Temp Written Blocks"] ?? 0,
    },
  };
}

/** No network adapters, application worker loops or real source/storage calls are used. */
test(
  "1000-account multi-run history keeps summary/task bytes bounded and database reads independent of page size",
  { timeout: 120_000 },
  async () => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    const prefix = `history_perf_${randomUUID()}`;
    const accountCount = 1000;
    const runCount = 14;
    const authorIds = Array.from({ length: accountCount }, () => randomUUID());
    const accountIds = Array.from({ length: accountCount }, () => randomUUID());
    const adapterIds = Array.from({ length: accountCount }, () => randomUUID());
    const runIds = Array.from({ length: runCount }, () => randomUUID());
    const taskIds = Array.from({ length: accountCount }, () => randomUUID());
    const startedAt = new Date("2299-11-11T12:00:00.000Z");
    const queries: Prisma.Sql[] = [];
    const capture =
      (target: Pick<Prisma.TransactionClient, "$queryRaw">) =>
      async <T>(query: Prisma.Sql): Promise<T> => {
        queries.push(query);
        return target.$queryRaw<T>(query);
      };
    // Observe both root and transaction delegates. Wrapping only the root would
    // miss task/current-state reads made inside repeatable-read transactions.
    const observed = {
      $queryRaw: capture(db),
      $transaction: <T>(
        action: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) =>
        db.$transaction(
          (tx) =>
            action({ $queryRaw: capture(tx) } as Prisma.TransactionClient),
          options,
        ),
    } as unknown as PrismaService;
    const registry = new ContentSourceRegistry().register({
      platform: "perf_fixture",
      adapterKey: "perf_current",
      available: true,
      priority: 1,
      metered: false,
      supportedFirstSyncModes: ["none"],
      allowedMediaHosts: [],
      initialCursor: () => ({}),
      checkAccount: async (account) => account,
      fetchPage: async () => {
        throw new Error("History reads must not call a source");
      },
    } as ContentSourceClient);
    const history = new SourceHistoryService(observed, registry);
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    async function measure<T>(action: () => Promise<T>) {
      const offset = queries.length;
      const result = await action();
      return {
        result,
        reads: queries.length - offset,
        queries: queries.slice(offset),
        bytes: bytes(result),
      };
    }
    async function explain(
      label: string,
      query: Prisma.Sql,
      responseBytes: number,
    ) {
      const rows = await db.$queryRaw<
        { "QUERY PLAN": { Plan: PlanNode }[] }[]
      >(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}
    `);
      const root = rows[0]?.["QUERY PLAN"][0]?.Plan;
      assert.ok(root, "PostgreSQL must return an actual JSON execution plan");
      const metrics = planMetrics(root);
      // Record observed work/size only; planner choices and elapsed time vary by host.
      console.info(
        JSON.stringify({
          scope: "source_history_performance",
          query: label,
          ...metrics,
          responseBytes,
        }),
      );
    }
    await db.onModuleInit();
    try {
      await db.author.createMany({
        data: authorIds.map((id, i) => ({
          id,
          displayName: `${prefix}_${i}_${"長".repeat(45)}`,
          authorizationStatus: "authorized" as const,
        })),
      });
      await db.authorExternalAccount.createMany({
        data: accountIds.map((id, i) => ({
          id,
          authorId: authorIds[i],
          platform: "perf_fixture",
          externalUserId: `${prefix}_${i}`,
          handle: `${prefix}_${i}_${"h".repeat(70)}`,
          fetchEnabled: true,
          notes: "synthetic-private-note",
          metadataJson: {
            privateFixture: "must-not-leak",
            padding: "p".repeat(4096),
          },
        })),
      });
      await db.sourceAdapterState.createMany({
        data: adapterIds.map((id, i) => ({
          id,
          externalAccountId: accountIds[i],
          adapterKey: "perf_current",
          health: "healthy" as const,
          cursorJson: {
            privateFixture: "must-not-leak",
            padding: "p".repeat(1024),
          },
        })),
      });
      await db.sourceFetchRun.createMany({
        data: runIds.map((id, i) => ({
          id,
          trigger: "scheduled" as const,
          status: i === 0 ? ("running" as const) : ("succeeded" as const),
          startedAt: new Date(startedAt.getTime() - i * 60_000),
          completedAt: i === 0 ? null : startedAt,
        })),
      });
      // Each batch stays well below PostgreSQL's bind-parameter limit. The 14 runs
      // exercise bounded selection before aggregation, rather than an empty tail.
      for (const [runNumber, runId] of runIds.entries()) {
        await db.sourceFetchAccountTask.createMany({
          data: accountIds.map((accountId, i) => ({
            ...(runNumber === 0 ? { id: taskIds[i] } : {}),
            runId,
            accountId,
            platform: "perf_fixture",
            status:
              runNumber === 0 && i === 0
                ? ("failed" as const)
                : runNumber === 0 && i === 1
                  ? ("waiting" as const)
                  : runNumber === 0 && i === 2
                    ? ("running" as const)
                    : ("succeeded" as const),
            startedAt,
            completedAt:
              runNumber === 0 && (i === 1 || i === 2) ? null : startedAt,
            failureCode: runNumber === 0 && i === 0 ? "network_error" : null,
          })),
        });
        await db.sourceFetchRunItem.createMany({
          data: accountIds.map((externalAccountId, i) => ({
            runId,
            externalAccountId,
            adapterStateId: adapterIds[i],
            adapterKey: "perf_current",
            status: "succeeded" as const,
            cursorBefore: { privateFixture: "must-not-leak" },
            pagesFetched: 1,
            candidatesCreated: 1,
            mediaStored: 2,
            startedAt,
            completedAt: startedAt,
          })),
        });
      }
      await db.sourceDiscoveryPost.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          accountId: accountIds[0],
          platform: "perf_fixture",
          externalPostId: `${prefix}_gap_${i}`,
          sourceUserId: `${prefix}_0`,
          adapterKey: "perf_current",
          discoveredRunId: runIds[13],
          windowJson: {},
          state: i < 100 ? "needs_attention" : "excluded",
        })),
      });

      const summary = await measure(() => history.list({}));
      assert.equal(summary.result.items.length, 10);
      assert.ok(summary.result.nextCursor);
      assert.ok(
        summary.result.items.every((row) => row.targetCount === accountCount),
      );
      assert.ok(
        summary.result.items.every(
          (row) => !("items" in row) && !("attempts" in row),
        ),
      );
      assert.equal(summary.result.items[0].id, runIds[0]);
      assert.equal(summary.result.items[0].waitingTargets, 1);
      assert.equal(summary.result.items[0].candidatesCreated, accountCount);
      assert.equal(summary.result.items[0].mediaStored, accountCount * 2);
      assert.ok(
        summary.bytes < 24 * 1024,
        `10 summaries returned ${summary.bytes} bytes`,
      );
      assert.ok(summary.reads <= 2, `Summary used ${summary.reads} SQL reads`);

      const page = await measure(() => history.tasks(runIds[0], {}));
      assert.equal(page.result.items.length, 20);
      assert.ok(page.result.nextCursor);
      assert.ok(
        page.result.items.every(
          (row) => !("current" in row) && !("cursorBefore" in row),
        ),
      );
      assert.ok(
        page.bytes < 48 * 1024,
        `20 task rows returned ${page.bytes} bytes`,
      );
      const largerPage = await measure(() =>
        history.tasks(runIds[0], { limit: 100 }),
      );
      assert.equal(largerPage.result.items.length, 100);
      assert.equal(
        largerPage.reads,
        page.reads,
        "Expanding a page must not add per-account queries",
      );
      assert.ok(page.reads <= 3, `Task page used ${page.reads} SQL reads`);
      assert.ok(largerPage.bytes < 240 * 1024);
      const next = await measure(() =>
        history.tasks(runIds[0], { cursor: page.result.nextCursor! }),
      );
      assert.equal(next.result.items.length, 20);
      assert.ok(
        next.result.items.every(
          (row) => !page.result.items.some((first) => first.id === row.id),
        ),
      );
      assert.equal(next.reads, page.reads);

      const current = await measure(() => history.task(runIds[0], taskIds[0]));
      assert.equal(current.result.original.status, "failed");
      assert.equal(current.result.current?.adapterHealth, "healthy");
      assert.equal(current.result.current?.unresolvedGapCount, 100);
      assert.equal(current.result.current?.excludedGapCount, 100);
      const emptyCurrent = await measure(() =>
        history.task(runIds[0], taskIds[3]),
      );
      assert.equal(emptyCurrent.result.current?.unresolvedGapCount, 0);
      assert.equal(
        emptyCurrent.reads,
        current.reads,
        "Current-state work must not issue one query per discovered post",
      );
      assert.ok(
        current.reads <= 7,
        `Single-account detail used ${current.reads} SQL reads`,
      );
      const safeJson = JSON.stringify([
        summary.result,
        page.result,
        current.result,
      ]);
      assert.equal(safeJson.includes("must-not-leak"), false);
      assert.equal(safeJson.includes("synthetic-private-note"), false);

      const summaryQuery = summary.queries.find((query) =>
        query.sql.includes("WITH selected AS MATERIALIZED"),
      );
      const pageQuery = page.queries.find((query) =>
        query.sql.includes("WITH members AS"),
      );
      const currentQuery = current.queries.find((query) =>
        query.sql.includes("WITH gaps AS"),
      );
      assert.ok(summaryQuery && pageQuery && currentQuery);
      await explain(
        "summary_10_of_14_runs_1000_accounts_each",
        summaryQuery,
        summary.bytes,
      );
      await explain("task_page_20_of_1000", pageQuery, page.bytes);
      await explain(
        "single_account_current_200_known_posts",
        currentQuery,
        current.bytes,
      );
    } finally {
      // Restrict every cleanup to the UUIDs created by this synthetic prefix.
      await db.sourceFetchRunItem.deleteMany({
        where: { runId: { in: runIds } },
      });
      await db.sourceFetchAccountTask.deleteMany({
        where: { runId: { in: runIds } },
      });
      await db.sourceFetchRun.deleteMany({ where: { id: { in: runIds } } });
      await db.sourceDiscoveryPost.deleteMany({
        where: { accountId: { in: accountIds } },
      });
      await db.sourceAdapterState.deleteMany({
        where: { id: { in: adapterIds } },
      });
      await db.authorExternalAccount.deleteMany({
        where: { id: { in: accountIds } },
      });
      await db.author.deleteMany({ where: { id: { in: authorIds } } });
      await db.onModuleDestroy();
    }
  },
);
