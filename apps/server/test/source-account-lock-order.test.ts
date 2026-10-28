import { rawQueryValues } from "./raw-query-values.js";
import { Prisma } from "../src/generated/prisma/client.js";
/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceFetchService } from "../src/source-ingestion/source-fetch.service.js";

test("manual reuse locks every sibling job before terminal settlement can lock a run", async () => {
  const tasks = [
    { id: "task-a", jobId: "job-a", runId: "run", accountId: "account-a" },
    { id: "task-b", jobId: "job-b", runId: "run", accountId: "account-b" },
  ];
  const locked = new Set<string>();
  const tx: any = {
    $queryRaw: async (query: any, ...args: any[]) => {
      const values = rawQueryValues(query, ...args);
      for (const value of values.flat(Infinity))
        if (typeof value === "string" && value.startsWith("job-"))
          locked.add(value);
      return [];
    },
    sourceFetchAccountTask: { findMany: async () => tasks },
    sourceFetchRun: {
      findMany: async () => [
        {
          id: "run",
          accountTasks: tasks.map((task) => ({
            accountId: task.accountId,
            completedAt: null,
          })),
        },
      ],
    },
  };
  const service: any = new SourceFetchService(
    null as any,
    tx,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
  service.settleTerminalLeases = async () => {};
  service.settleAccountTerminal = async () =>
    assert.deepEqual([...locked].sort(), ["job-a", "job-b"]);
  assert.deepEqual(await service.activeRun(tx, ["account-a", "account-b"]), {
    id: "run",
  });
});

test("raw-query lock instrumentation preserves tagged-template and Prisma.Sql job bindings", () => {
  const jobId = "job-b";
  const tagged = (query: TemplateStringsArray, ...values: unknown[]) =>
    rawQueryValues(query, ...values);
  assert.deepEqual(
    tagged`SELECT id FROM background_jobs WHERE id=${jobId} FOR UPDATE`,
    [jobId],
  );
  assert.deepEqual(
    rawQueryValues(
      Prisma.sql`SELECT id FROM background_jobs WHERE id=${jobId} FOR UPDATE`,
    ),
    [jobId],
  );
  assert.throws(
    () => rawQueryValues({ values: Array.prototype.values }),
    /Unsupported raw query/,
  );
});
