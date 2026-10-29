import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceFetchService } from "../src/source-ingestion/source-fetch.service.js";
import { SourceFetchController } from "../src/source-ingestion/source-fetch.controller.js";
import { ACCESS, permissionsFor } from "../src/common/access.js";
import { Prisma } from "../src/generated/prisma/client.js";

const now = new Date("2026-10-27T10:00:00Z");
const startedAt = new Date("2026-10-27T09:00:00Z");
const retryAt = new Date("2026-10-27T10:00:05Z");
const row = {
  id: "shared-manual",
  trigger: "manual",
  status: "running",
  startedAt,
  completedAt: null,
  pagesFetched: 5n,
  candidatesCreated: 3n,
  mediaStored: 8n,
  jobStatus: "queued",
  attempts: 1,
  availableAt: retryAt,
  leaseUntil: null,
  isActive: true,
  isLastManual: true,
  // A boundary double deliberately includes private fields to catch broad spreads.
  payload: { accountIds: ["private-account"] },
  requestedById: "another-user",
  errorCode: "private-upstream-error",
  credentials: "private-credentials",
};

function fixture(rows: unknown[]) {
  const queries: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(Prisma.sql(query, ...values));
      return rows;
    },
  };
  const args = [
    null,
    db,
    null,
    null,
    null,
    null,
  ] as unknown as ConstructorParameters<typeof SourceFetchService>;
  const service = new SourceFetchService(...args);
  return { service, queries };
}

test("source progress is a shared source-business route, without broad history permission", () => {
  const progress = SourceFetchController.prototype.progress;
  assert.equal(typeof progress, "function");
  assert.equal(Reflect.getMetadata("path", progress), "progress");
  assert.equal(Reflect.getMetadata("method", progress), 0);
  assert.deepEqual(Reflect.getMetadata(ACCESS, progress), {
    permission: "candidates:manage",
  });
  for (const role of ["admin", "source"] as const)
    assert.ok(permissionsFor([role], false).includes("candidates:manage"));
  assert.ok(!permissionsFor(["reviewer"], false).includes("candidates:manage"));
});

test("progress reads an empty history without allocating or reconciling jobs", async () => {
  const { service, queries } = fixture([]);
  assert.equal(typeof service.progress, "function");
  assert.deepEqual(await service.progress(now), {
    active: null,
    lastManual: null,
  });
  assert.equal(queries.length, 1);
  const statement = queries[0].sql;
  assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|FOR\s+UPDATE)\b/i);
  assert.doesNotMatch(
    statement,
    /\b(?:payload|requested_by|cursor|error_code|error_message|credentials)\b/i,
  );
  assert.equal(statement.match(/\bLIMIT\s+1\b/gi)?.length, 2);
  assert.ok(queries[0].values.some((value) => value === now));
});

test("progress returns only counters, status and times, including a shared retry", async () => {
  const { service } = fixture([row]);
  assert.equal(typeof service.progress, "function");
  const result = await service.progress(now);
  const expected = {
    id: "shared-manual",
    trigger: "manual",
    status: "queued",
    startedAt: "2026-10-27T09:00:00.000Z",
    completedAt: null,
    pagesFetched: 5,
    candidatesCreated: 3,
    mediaStored: 8,
    nextRetryAt: "2026-10-27T10:00:05.000Z",
  };
  assert.deepEqual(result, { active: expected, lastManual: expected });
});

test("scheduled active progress and the last manual result stay distinct", async () => {
  const { service } = fixture([
    {
      ...row,
      id: "scheduled-active",
      trigger: "scheduled",
      jobStatus: "running",
      leaseUntil: new Date("2026-10-27T10:01:00Z"),
      attempts: 3,
      isLastManual: false,
    },
    {
      ...row,
      id: "manual-finished",
      status: "partial_failed",
      completedAt: new Date("2026-10-27T09:30:00Z"),
      isActive: false,
    },
  ]);
  assert.equal(typeof service.progress, "function");
  const result = await service.progress(now);
  assert.equal(result.active?.id, "scheduled-active");
  assert.equal(result.active?.status, "running");
  assert.equal(result.active?.nextRetryAt, null);
  assert.equal(result.lastManual?.id, "manual-finished");
  assert.equal(result.lastManual?.status, "partial_failed");
  assert.equal(result.lastManual?.nextRetryAt, null);
});

for (const input of [
  { jobStatus: null, attempts: null, leaseUntil: null, want: "failed" },
  { jobStatus: "failed", attempts: 1, leaseUntil: null, want: "failed" },
  { jobStatus: "succeeded", attempts: 1, leaseUntil: null, want: "failed" },
  { jobStatus: "queued", attempts: 3, leaseUntil: null, want: "failed" },
  { jobStatus: "running", attempts: 3, leaseUntil: now, want: "failed" },
  { jobStatus: "running", attempts: 3, leaseUntil: null, want: "failed" },
  { jobStatus: "running", attempts: 2, leaseUntil: now, want: "queued" },
  { jobStatus: "running", attempts: 2, leaseUntil: null, want: "failed" },
  {
    jobStatus: "running",
    attempts: 3,
    leaseUntil: new Date("2026-10-27T10:00:00.001Z"),
    want: "running",
  },
] as const) {
  test(`last manual projects ${input.jobStatus}/${input.attempts}/${input.leaseUntil?.toISOString()} as ${input.want}`, async () => {
    const { service } = fixture([{ ...row, ...input, isActive: false }]);
    assert.equal(typeof service.progress, "function");
    const result = await service.progress(now);
    assert.equal(result.active, null);
    assert.equal(result.lastManual?.status, input.want);
    assert.equal(result.lastManual?.nextRetryAt, null);
  });
}

for (const status of ["succeeded", "partial_failed", "failed"] as const) {
  test(`terminal ${status} run never revives from an old live job`, async () => {
    const { service } = fixture([
      {
        ...row,
        status,
        jobStatus: "running",
        leaseUntil: new Date("2026-10-27T10:01:00Z"),
        isActive: false,
      },
    ]);
    assert.equal(typeof service.progress, "function");
    const result = await service.progress(now);
    assert.equal(result.active, null);
    assert.equal(result.lastManual?.status, status);
    assert.equal(result.lastManual?.nextRetryAt, null);
  });
}

test("new queued runs have zero counters and no retry countdown", async () => {
  const { service } = fixture([
    {
      ...row,
      status: "queued",
      attempts: 0,
      pagesFetched: 0n,
      candidatesCreated: 0n,
      mediaStored: 0n,
    },
  ]);
  assert.equal(typeof service.progress, "function");
  const result = await service.progress(now);
  assert.equal(result.active?.status, "queued");
  assert.equal(result.active?.pagesFetched, 0);
  assert.equal(result.active?.candidatesCreated, 0);
  assert.equal(result.active?.mediaStored, 0);
  assert.equal(result.active?.nextRetryAt, null);
});

test("platform diagnostics and controlled recheck require technical administration", () => {
  for (const method of [
    SourceFetchController.prototype.platforms,
    SourceFetchController.prototype.recheck,
  ])
    assert.deepEqual(Reflect.getMetadata(ACCESS, method), {
      permission: "system:manage",
    });
});
