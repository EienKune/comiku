import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceHistoryService } from "../src/source-ingestion/source-history.service.js";
import { SourceFetchController } from "../src/source-ingestion/source-fetch.controller.js";
import { ACCESS } from "../src/common/access.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
import type { ContentSourceClient } from "../src/source-ingestion/content-source.js";

const runId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const now = new Date("2026-11-10T10:00:00Z");
const summary = {
  id: runId,
  trigger: "manual",
  status: "running",
  startedAt: now,
  completedAt: null,
  legacy: false,
  targetCount: 400,
  completedTargets: 399,
  succeededTargets: 398,
  failedTargets: 1,
  runningTargets: 0,
  queuedTargets: 0,
  waitingTargets: 1,
  anomalyTargets: 1,
  pagesFetched: 400n,
  candidatesCreated: 2n,
  mediaStored: 3n,
  credentials: "must-not-leak",
  attempts: 400,
};
function fixture(results: unknown[][]) {
  const registry = new ContentSourceRegistry()
    .register({
      platform: "x",
      adapterKey: "synthetic_current",
      available: true,
      priority: 1,
    } as ContentSourceClient)
    .register({
      platform: "x",
      adapterKey: "synthetic_retired",
      available: false,
      priority: 2,
    } as ContentSourceClient);
  const queries: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query);
      return results.shift() ?? [];
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
  };
  return {
    history: new SourceHistoryService(db as unknown as PrismaService, registry),
    queries,
  };
}

test("history defaults to ten bounded run summaries and drops technical/private fields", async () => {
  const { history, queries } = fixture([[summary]]);
  const result = await history.list({});
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].targetCount, 400);
  assert.equal(result.items[0].waitingTargets, 1);
  assert.equal(result.items[0].pagesFetched, 400);
  assert.equal("items" in result.items[0], false);
  assert.equal("attempts" in result.items[0], false);
  assert.equal("credentials" in result.items[0], false);
  assert.equal(result.nextCursor, null);
  assert.ok(queries[0].values.includes(11));
  assert.match(queries[0].sql, /LIMIT/);
  assert.match(queries[0].sql, /GROUP BY/);
});

test("run cursors bind immutable time/id and are not expanded in JavaScript", async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({
    ...summary,
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  }));
  const { history, queries } = fixture([rows, []]);
  const first = await history.list({});
  assert.equal(first.items.length, 10);
  assert.ok(first.nextCursor);
  await history.list({ cursor: first.nextCursor! });
  assert.ok(queries[1].values.includes(rows[9].id));
  await assert.rejects(
    () => history.list({ cursor: "not-a-cursor" }),
    /cursor/i,
  );
});

test("durable waiting targets remain visible, search/status are SQL filters, unsafe failure text is not returned", async () => {
  const { history, queries } = fixture([
    [summary],
    [
      {
        id: taskId,
        accountId,
        authorName: "Synthetic",
        platform: "x",
        handle: "synthetic",
        externalUserId: "123",
        status: "waiting",
        failureCode: "Cookie: private-secret",
        startedAt: null,
        completedAt: null,
        deferredUntil: now,
        legacy: false,
        pagesFetched: 0n,
        candidatesCreated: 0n,
        mediaStored: 0n,
        errorMessage: "private stderr",
        credentialGeneration: "private-fingerprint",
      },
    ],
  ]);
  const result = await history.tasks(runId, {
    status: "active",
    search: "syn%_",
  });
  assert.equal(result.items[0].status, "waiting");
  assert.equal(result.items[0].failureCode, "unknown_failure");
  assert.equal("errorMessage" in result.items[0], false);
  assert.equal("credentialGeneration" in result.items[0], false);
  assert.ok(queries[1].values.includes(21));
  assert.ok(queries[1].values.includes("%syn\\%\\_%"));
  assert.match(queries[1].sql, /waiting/);
  assert.match(queries[1].sql, /\?::boolean AS legacy/);
});

test("every technical history route is admin-only, including cross-run task reads", () => {
  for (const method of [
    "list",
    "get",
    "tasks",
    "task",
    "executions",
    "gaps",
  ] as const)
    assert.deepEqual(
      Reflect.getMetadata(ACCESS, SourceFetchController.prototype[method]),
      { permission: "system:manage" },
    );
});

test("task detail never reads an account when membership does not match its run", async () => {
  const { history, queries } = fixture([[summary], []]);
  await assert.rejects(() => history.task(runId, taskId), /not found/i);
  assert.equal(queries.length, 2);
  assert.ok(queries[1].values.includes(runId));
  assert.ok(queries[1].values.includes(taskId));
});

test("single-account budget evidence never calls a first queued execution a retry", async () => {
  for (const attempts of [0, 1, 3]) {
    const original = {
      id: taskId,
      accountId,
      authorName: "Synthetic",
      platform: "x",
      handle: null,
      externalUserId: "123",
      status: "queued",
      failureCode: null,
      startedAt: null,
      completedAt: null,
      deferredUntil: null,
      legacy: false,
      pagesFetched: 0n,
      candidatesCreated: 0n,
      mediaStored: 0n,
    };
    const { history } = fixture([
      [summary],
      [original],
      [],
      [],
      [
        {
          status: "queued",
          attempts,
          availableAt: now,
          payload: { secret: "private" },
          lastError: "private",
        },
      ],
    ]);
    const detail = await history.task(runId, taskId);
    assert.equal(detail.job?.attempts, attempts);
    assert.equal(
      detail.job?.nextRetryAt,
      attempts === 1 ? now.toISOString() : null,
    );
    assert.equal("payload" in detail.job!, false);
    assert.equal("lastError" in detail.job!, false);
  }
});

test("current adapter health ignores retired and disabled states while preserving original failure", async () => {
  const { history, queries } = fixture([
    [summary],
    [
      {
        id: taskId,
        accountId,
        authorName: "Synthetic",
        platform: "x",
        handle: null,
        externalUserId: "123",
        status: "failed",
        failureCode: "network_error",
        startedAt: now,
        completedAt: now,
        deferredUntil: null,
        legacy: false,
        pagesFetched: 0n,
        candidatesCreated: 0n,
        mediaStored: 0n,
      },
    ],
    [
      {
        fetchEnabled: true,
        deletedAt: null,
        adapterHealth: "healthy",
        unresolvedGapCount: 0n,
        excludedGapCount: 0n,
      },
    ],
    [],
    [],
  ]);
  const detail = await history.task(runId, taskId);
  assert.equal(detail.original.failureCode, "network_error");
  assert.match(queries[2].sql, /s\.enabled/);
  assert.match(queries[2].sql, /s\.adapter_key IN/);
  assert.ok(queries[2].values.includes("synthetic_current"));
  assert.equal(queries[2].values.includes("synthetic_retired"), false);
  assert.equal(detail.current?.adapterHealth, "healthy");
});

test("history query parameters are explicit in generated OpenAPI metadata", () => {
  for (const [method, names] of [
    ["list", ["limit", "cursor", "trigger", "status"]],
    ["tasks", ["limit", "cursor", "platform", "status", "search"]],
    ["executions", ["limit", "cursor"]],
    ["gaps", ["limit", "cursor"]],
  ] as const) {
    const parameters = Reflect.getMetadata(
      "swagger/apiParameters",
      SourceFetchController.prototype[method],
    ) as { name: string; in: string }[] | undefined;
    for (const name of names)
      assert.ok(
        parameters?.some(
          (value) => value.name === name && value.in === "query",
        ),
        `${method}.${name}`,
      );
  }
});

test("execution pages validate membership and expose only bounded safe diagnostic samples", async () => {
  const original = {
    id: taskId,
    accountId,
    authorName: "Synthetic",
    platform: "x",
    handle: null,
    externalUserId: "123",
    status: "failed",
    failureCode: "network_error",
    startedAt: now,
    completedAt: now,
    deferredUntil: null,
    legacy: false,
    pagesFetched: 0n,
    candidatesCreated: 0n,
    mediaStored: 0n,
  };
  const execution = {
    id: taskId,
    kind: "scan",
    budgetAttempt: 1,
    budgetRefunded: false,
    admittedAt: now,
    businessOutcome: "failed",
    businessFinishedAt: now,
    settledAt: null,
    ownerId: "private",
    leaseId: "private",
    credentialGeneration: "private",
    diagnosticJson: {
      samples: [
        {
          stage: "download",
          reason: "network_error",
          scope: "transport",
          occurredAt: now.toISOString(),
          httpStatus: 503,
          durationMs: 20000,
          timeout: true,
          traceback: "Cookie: must-not-leak",
          response_excerpt: "private",
        },
        {
          stage: "private-url",
          reason: "Cookie: must-not-leak",
          scope: "private",
          occurredAt: "private",
          limitBytes: -1,
        },
      ],
      omitted: 7,
      token: "private",
    },
  };
  const { history, queries } = fixture([[summary], [original], [execution]]);
  const page = await history.executions(runId, taskId, {});
  assert.equal(page.scope, "scan");
  assert.equal(page.legacy, false);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0].diagnostics.samples[0], {
    stage: "download",
    reason: "network_error",
    scope: "transport",
    occurredAt: now.toISOString(),
    httpStatus: 503,
    durationMs: 20000,
    timeout: true,
  });
  assert.equal(page.items[0].diagnostics.samples[1].reason, "unknown_failure");
  assert.equal(page.items[0].diagnostics.samples[1].occurredAt, null);
  assert.equal(JSON.stringify(page).includes("private"), false);
  assert.equal(JSON.stringify(page).includes("must-not-leak"), false);
  assert.ok(queries[2].values.includes(21));
  assert.match(queries[2].sql, /kind='scan'/);
});

test("execution and gap pages reject cross-run membership before reading evidence", async () => {
  for (const method of ["executions", "gaps"] as const) {
    const { history, queries } = fixture([[summary], []]);
    await assert.rejects(
      () => history[method](runId, taskId, {}),
      /not found/i,
    );
    assert.equal(queries.length, 2);
  }
});

test("current gaps page distinguishes account scope from frozen original history and batches campaign reads", async () => {
  const original = {
    id: taskId,
    accountId,
    authorName: "Synthetic",
    platform: "x",
    handle: null,
    externalUserId: "123",
    status: "failed",
    failureCode: "network_error",
    startedAt: now,
    completedAt: now,
    deferredUntil: null,
    legacy: false,
    pagesFetched: 0n,
    candidatesCreated: 0n,
    mediaStored: 0n,
  };
  const { history, queries } = fixture([
    [summary],
    [original],
    [
      {
        id: taskId,
        postId: "public-post",
        platform: "x",
        state: "media_pending",
        failureCode: "network_error",
        attempts: 2,
        nextRetryAt: now,
        createdAt: now,
        updatedAt: now,
        evidenceJson: { token: "private" },
      },
    ],
    [
      {
        discoveryPostId: taskId,
        number: 2,
        state: "failed",
        failureCode: "network_error",
        startedAt: now,
        completedAt: now,
        jobId: "private",
      },
    ],
  ]);
  const page = await history.gaps(runId, taskId, {});
  assert.equal(page.scope, "current_account");
  assert.equal(page.items[0].postId, "public-post");
  assert.equal(page.items[0].campaign?.number, 2);
  assert.equal(JSON.stringify(page).includes("private"), false);
  assert.ok(queries[2].values.includes(accountId));
  assert.ok(queries[2].values.includes(21));
  assert.match(queries[2].sql, /NOT IN \('complete','excluded'\)/);
  assert.equal(queries.length, 4);
});

test("task execution availability comes from actual persisted scan records", async () => {
  const original = {
    id: taskId,
    accountId,
    authorName: "Synthetic",
    platform: "x",
    handle: null,
    externalUserId: "123",
    status: "failed",
    failureCode: "network_error",
    startedAt: now,
    completedAt: now,
    deferredUntil: null,
    legacy: false,
    pagesFetched: 0n,
    candidatesCreated: 0n,
    mediaStored: 0n,
  };
  const { history } = fixture([
    [summary],
    [original],
    [],
    [],
    [],
    [{ available: true }],
  ]);
  const detail = await history.task(runId, taskId);
  assert.equal(detail.executionHistoryAvailable, true);
});

test("platform status uses an explicit allowlist including maintenance state", async () => {
  const controller = new SourceFetchController(
    {
      platforms: {
        list: async () => [
          {
            platform: "x",
            status: "healthy",
            credentialGeneration: "generation",
            errorCode: null,
            cooldownUntil: null,
            revision: 1,
            maintenancePaused: true,
            maintenanceEpoch: 3,
            privateFutureField: "must-not-leak",
          },
        ],
      },
    } as unknown as import("../src/source-ingestion/source-fetch.service.js").SourceFetchService,
    {} as SourceHistoryService,
  );
  const [state] = await controller.platforms();
  assert.equal(state.maintenancePaused, true);
  assert.equal(state.maintenanceEpoch, 3);
  assert.equal("privateFutureField" in state, false);
});

test("execution cursor handles tied admission times and diagnostics are capped at eight samples", async () => {
  const original = {
    id: taskId,
    accountId,
    authorName: "Synthetic",
    platform: "x",
    handle: null,
    externalUserId: "123",
    status: "failed",
    failureCode: "network_error",
    startedAt: now,
    completedAt: now,
    deferredUntil: null,
    legacy: false,
    pagesFetched: 0n,
    candidatesCreated: 0n,
    mediaStored: 0n,
  };
  const rows = Array.from({ length: 21 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
    budgetAttempt: 1,
    budgetRefunded: false,
    admittedAt: now,
    businessOutcome: "failed",
    businessFinishedAt: now,
    settledAt: now,
    diagnosticJson: {
      samples: Array.from({ length: 12 }, () => ({
        stage: "download",
        reason: "network_error",
        scope: "transport",
        occurredAt: now.toISOString(),
      })),
      omitted: 3,
    },
  }));
  const { history, queries } = fixture([
    [summary],
    [original],
    rows,
    [summary],
    [original],
    [],
  ]);
  const page = await history.executions(runId, taskId, {});
  assert.equal(page.items.length, 20);
  assert.equal(page.items[0].diagnostics.samples.length, 8);
  assert.equal(page.items[0].diagnostics.omitted, 7);
  assert.ok(page.nextCursor);
  await history.executions(runId, taskId, { cursor: page.nextCursor! });
  assert.ok(queries[5].values.includes(rows[19].id));
  assert.match(queries[5].sql, /\(admitted_at,id\)</);
});

test("summary-only legacy executions stay empty without querying an inferred attempt table", async () => {
  const { history, queries } = fixture([
    [{ ...summary, legacy: true }],
    [{ id: taskId, accountId }],
  ]);
  const page = await history.executions(runId, taskId, {});
  assert.equal(page.legacy, true);
  assert.equal(page.scope, "scan");
  assert.deepEqual(page.items, []);
  assert.equal(queries.length, 2);
});
