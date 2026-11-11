/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  SourceExecutions,
  executionDiagnosticSample,
  waitForSourceChildClose,
  sourceResourceUnconfirmed,
} from "../src/source-ingestion/source-executions.js";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";
import { JobDeferred } from "../src/jobs/jobs.service.js";

test("execution diagnostics admit only controlled stages and numeric evidence", () => {
  const sample = executionDiagnosticSample(
    new SourceResponseError("temporary_failure", {
      reason: "media_size_limit",
      scope: "media",
      diagnostic: {
        stage: "SECRET_PATH",
        http_status: "403",
        limit_bytes: 100,
        observed_bytes: "101",
        timeout: true,
        traceback: "SECRET",
        http_endpoint: "https://secret.invalid",
        http_response_excerpt: "COOKIE",
        duration: "SECRET",
      },
    }),
    "download",
  );
  assert.equal(sample.stage, "download");
  assert.equal(sample.reason, "media_size_limit");
  assert.equal(sample.httpStatus, 403);
  assert.equal(sample.observedBytes, 101);
  assert.doesNotMatch(JSON.stringify(sample), /SECRET|COOKIE|https/);
});

test("refunded attempts retain unique lease identity and settlement cannot change business facts", async () => {
  const rows: Record<string, any>[] = [];
  const tx = {
    sourcePlatformExecution: {
      create: async ({ data }: any) => {
        rows.push({ ...data, businessOutcome: null, settledAt: null });
        return rows.at(-1);
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows)
          if (Object.entries(where).every(([k, v]) => row[k] === v)) {
            Object.assign(row, data);
            count++;
          }
        return { count };
      },
    },
  };
  const ex = new SourceExecutions(tx as never, "owner");
  const admit = (leaseId: string) =>
    ex.admit(tx as never, {
      platform: "x",
      kind: "scan",
      credentialGeneration: "g",
      jobId: "job",
      leaseId,
      budgetAttempt: 3,
    });
  await admit("old");
  await ex.run({ id: "job", leaseId: "old" } as never, async () =>
    ex.business(
      tx as never,
      { id: "job", leaseId: "old" } as never,
      "deferred",
      new JobDeferred(new Date(), "platform_maintenance"),
      true,
    ),
  );
  await admit("new");
  await ex.run({ id: "job", leaseId: "new" } as never, async () =>
    ex.business(
      tx as never,
      { id: "job", leaseId: "new" } as never,
      "succeeded",
    ),
  );
  await ex.settle({ id: "job", leaseId: "old" } as never);
  assert.equal(rows[0].budgetRefunded, true);
  assert.equal(rows[0].businessOutcome, "deferred");
  assert.ok(rows[0].settledAt instanceof Date);
  assert.equal(rows[1].businessOutcome, "succeeded");
  assert.equal(rows[1].settledAt, null);
});

test("bounded media failures survive a successful business finish without per-item writes", async () => {
  let writes = 0,
    saved: any;
  const tx = {
    sourcePlatformExecution: {
      updateMany: async ({ data }: any) => {
        writes++;
        saved = data;
        return { count: 1 };
      },
    },
  };
  const ex = new SourceExecutions(tx as never, "owner");
  await ex.run({ id: "job", leaseId: "lease" } as never, async () => {
    for (let n = 0; n < 50; n++)
      ex.record(
        new SourceResponseError("temporary_failure", {
          reason: "media_network_error",
          scope: "media",
        }),
        "download",
      );
    assert.equal(writes, 0);
    await ex.business(
      tx as never,
      { id: "job", leaseId: "lease" } as never,
      "succeeded",
    );
  });
  assert.equal(saved.businessOutcome, "partial_failed");
  assert.equal(saved.diagnosticJson.samples.length, 8);
  assert.equal(saved.diagnosticJson.omitted, 42);
  assert.ok(Buffer.byteLength(JSON.stringify(saved.diagnosticJson)) < 16384);
});

test("a rejected subprocess callback remains unsettled until actual child close", async () => {
  const child = new EventEmitter();
  let finished = false;
  const failure = new Error("synthetic abort");
  const running = waitForSourceChildClose(
    child as ChildProcess,
    Promise.reject(failure),
  ).catch((error) => {
    assert.equal(error, failure);
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  child.emit("close", 1, null);
  await running;
  assert.equal(finished, true);
});
test("unconfirmed resource cleanup cannot certify a settled execution", async () => {
  let writes = 0;
  const ex = new SourceExecutions(
    {
      sourcePlatformExecution: {
        updateMany: async () => {
          writes++;
        },
      },
    } as never,
    "owner",
  );
  await ex.run({ id: "job", leaseId: "lease" } as never, async () => {
    sourceResourceUnconfirmed();
    await ex.settle({ id: "job", leaseId: "lease" } as never);
  });
  assert.equal(writes, 0);
});

test("settled retention is a 30-day bounded SQL batch and excludes unconfirmed owners", async () => {
  const calls: { query: TemplateStringsArray; values: unknown[] }[] = [];
  const ex = new SourceExecutions(
    {
      sourcePlatformExecution: {},
      $executeRaw: async (
        query: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        calls.push({ query, values });
        return 100;
      },
    } as never,
    "owner",
  );
  const now = new Date("2026-11-10T00:00:00Z");
  assert.equal(await ex.pruneSettled(now), 100);
  const sql = calls[0].query.join("?");
  assert.match(sql, /settled_at\s*</);
  assert.match(sql, /LIMIT/);
  assert.match(sql, /SKIP LOCKED/);
  assert.ok(
    calls[0].values.some(
      (value) =>
        value instanceof Date &&
        value.toISOString() === "2026-10-11T00:00:00.000Z",
    ),
  );
  assert.ok(calls[0].values.includes(100));
  await assert.rejects(ex.pruneSettled(now, 101), /batch/);
});
