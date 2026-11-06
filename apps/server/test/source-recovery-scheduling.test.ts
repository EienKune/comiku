import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceRecoveryService } from "../src/source-ingestion/source-recovery.service.js";
import { ConflictException } from "@nestjs/common";

test("recovery scheduler exposes unexpected transaction failure with bounded safe context and continues", async () => {
  const attempted: string[] = [];
  const post = {
    id: "gap-a",
    actorId: null,
    nextRetryAt: new Date(0),
    state: "media_pending",
    attempts: 0,
  };
  const tx = {
    sourceDiscoveryPost: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        attempted.push(where.id);
        if (where.id === "gap-a")
          throw new Error(
            "Prisma private payload token=HIDDEN " + "secret".repeat(10000),
          );
        return { ...post, id: where.id };
      },
    },
    $queryRaw: async () => [],
    authorExternalAccount: { count: async () => 0 },
  };
  const db = {
    $queryRaw: async () => [{ id: "gap-a" }, { id: "gap-b" }],
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  };
  const service = new SourceRecoveryService(
    db as never,
    {} as never,
    { actor: async () => {} } as never,
  );
  service.lockAccount = async () => {};
  const logs: string[] = [];
  const log = console.info;
  console.info = (line: string) => {
    logs.push(line);
  };
  try {
    await service.schedule();
  } finally {
    console.info = log;
  }
  assert.deepEqual(attempted, ["gap-a", "gap-b", "gap-b"]);
  assert.deepEqual(
    logs.map((s) => JSON.parse(s)),
    [
      {
        scope: "source_recovery",
        event: "schedule_failed",
        discoveryId: "gap-a",
        code: "schedule_transaction_failed",
      },
    ],
  );
  assert.ok(logs[0].length < 256);
});

test("a revoked recovery actor is a quiet eligibility skip", async () => {
  const tx = {
    sourceDiscoveryPost: {
      findUniqueOrThrow: async () => ({ actorId: "actor" }),
    },
  };
  const db = {
    $queryRaw: async () => [{ id: "gap" }],
    $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx),
  };
  const service = new SourceRecoveryService(
    db as never,
    {} as never,
    {
      actor: async () => {
        throw new ConflictException("Source actor unavailable");
      },
    } as never,
  );
  const logs: string[] = [];
  const log = console.info;
  console.info = (line: string) => {
    logs.push(line);
  };
  try {
    await service.schedule();
  } finally {
    console.info = log;
  }
  assert.deepEqual(logs, []);
});
