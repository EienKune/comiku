import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectQueue } from "../src/jobs/queue-policy.js";
import { JobDeferred, JobsService } from "../src/jobs/jobs.service.js";
import type { BackgroundJob } from "../src/generated/prisma/client.js";
import type { PrismaService } from "../src/database/prisma.service.js";

test("deferral rejects arbitrary runtime reason strings", () => {
  assert.throws(
    () => new JobDeferred(new Date(), "upstream-secret" as "capacity"),
  );
});

test("expired retry time cannot turn refunded attempts into a hot loop", async () => {
  let availableAt: Date | undefined;
  const db = {
    backgroundJob: {
      updateMany: async (input: { data: { availableAt: Date } }) => {
        availableAt = input.data.availableAt;
        return { count: 1 };
      },
    },
  };
  const jobs = new JobsService(db as unknown as PrismaService);
  jobs.register("fixture", async () => {
    throw new JobDeferred(new Date(0), "capacity");
  });
  const before = Date.now();
  await jobs.execute({
    id: "job",
    kind: "fixture",
    resourceId: "resource",
    lane: "heavy",
    leaseId: "lease",
    attempts: 3,
  } as BackgroundJob);
  assert.ok(availableAt && availableAt.getTime() >= before + 5000);
});

test("persistent queue budget yields 3:1 and empty queues surrender their turn", () => {
  const policy = { primary: "scan", secondary: "recovery", primaryWeight: 3 };
  let state = { lastQueue: "", consecutive: 0 };
  const choices = Array.from({ length: 8 }, () => {
    const queue = selectQueue(["scan", "recovery"], state, policy)!;
    state = {
      lastQueue: queue,
      consecutive: state.lastQueue === queue ? state.consecutive + 1 : 1,
    };
    return queue;
  });
  assert.deepEqual(choices, [
    "scan",
    "scan",
    "scan",
    "recovery",
    "scan",
    "scan",
    "scan",
    "recovery",
  ]);
  assert.equal(selectQueue(["scan"], state, policy), "scan");
  assert.equal(selectQueue(["recovery"], state, policy), "recovery");
  assert.equal(selectQueue([], state, policy), null);
});

test("typed deferral on third claim preserves a nonterminal job and restores attempt budget under lease", async () => {
  const updates: unknown[] = [];
  const db = {
    backgroundJob: {
      updateMany: async (input: unknown) => {
        updates.push(input);
        return { count: 1 };
      },
    },
  };
  const jobs = new JobsService(db as unknown as PrismaService);
  const retryAt = new Date("2030-01-01T00:00:00Z");
  jobs.register("fixture", async () => {
    throw new JobDeferred(retryAt, "capacity");
  });
  await jobs.execute({
    id: "job",
    kind: "fixture",
    resourceId: "resource",
    lane: "heavy",
    leaseId: "lease",
    attempts: 3,
  } as BackgroundJob);
  assert.equal(updates.length, 1);
  const update = updates[0] as {
    where: { leaseUntil: { gt: Date } };
    data: unknown;
  };
  assert.ok(update.where.leaseUntil.gt instanceof Date);
  assert.deepEqual(updates, [
    {
      where: {
        id: "job",
        leaseId: "lease",
        status: "running",
        leaseUntil: update.where.leaseUntil,
      },
      data: {
        status: "queued",
        availableAt: retryAt,
        leaseId: null,
        leaseUntil: null,
        attempts: { decrement: 1 },
        completedAt: null,
        lastError: "capacity",
      },
    },
  ]);
});

test("claim gate denial persists a delay without a claim or fair budget write", async () => {
  const writes: unknown[] = [];
  const job = {
    id: "job",
    kind: "fixture",
    queueName: "scan",
    attempts: 2,
    lane: "network",
    executionScope: "X",
    status: "queued",
    availableAt: new Date(0),
  };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ id: job.id }],
    backgroundJob: {
      updateMany: async () => ({ count: 0 }),
      count: async () => 0,
      groupBy: async () => [{ queueName: "scan" }],
      findFirst: async () => job,
      findUnique: async () => job,
      update: async (input: unknown) => {
        writes.push(input);
        return job;
      },
    },
    jobQueueState: {
      findUnique: async () => null,
      upsert: async () => {
        assert.fail("denied gate must not consume fairness");
      },
    },
  };
  const jobs = new JobsService({
    $transaction: async (body: (tx: unknown) => unknown) => body(tx),
  } as unknown as PrismaService);
  jobs.register("fixture", async () => {});
  jobs.registerQueuePolicy("network", "X", {
    primary: "scan",
    secondary: "recovery",
    primaryWeight: 3,
  });
  const retryAt = new Date("2030-01-01T00:00:00Z");
  jobs.registerClaimGate("fixture", async (candidate, transaction) => {
    assert.equal(candidate.attempts, 2);
    assert.equal(transaction, tx);
    return new JobDeferred(retryAt, "platform_cooldown");
  });
  assert.equal(await jobs.claim("network", new Date(), "X"), null);
  assert.deepEqual(writes, [
    {
      where: { id: "job" },
      data: { availableAt: retryAt, lastError: "platform_cooldown" },
    },
  ]);
});

test("claim revalidates locked row and feeds the gate fresh payload after selection interleaving", async () => {
  const now = new Date();
  const selected = {
    id: "job",
    kind: "fixture",
    lane: "network",
    executionScope: "X",
    queueName: "scan",
    status: "queued",
    availableAt: new Date(0),
    attempts: 0,
    payload: { generation: 1 },
  };
  const changes = [
    { status: "failed" },
    { executionScope: "P" },
    { lane: "heavy" },
    { queueName: "recovery" },
    { availableAt: new Date(now.getTime() + 60_000) },
    { attempts: 3 },
    { kind: "unregistered" },
    null,
    { payload: { generation: 2 } },
  ];
  for (const change of changes) {
    let locked: typeof selected | null = selected;
    let gates = 0,
      fairness = 0,
      writes = 0;
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => {
        locked = change === null ? null : { ...selected, ...change };
        return [{ id: selected.id }];
      },
      backgroundJob: {
        updateMany: async () => ({ count: 0 }),
        count: async () => 0,
        groupBy: async () => [{ queueName: "scan" }],
        findFirst: async () => selected,
        findUnique: async () => locked,
        update: async () => {
          writes++;
          return locked;
        },
      },
      jobQueueState: {
        findUnique: async () => null,
        upsert: async () => {
          fairness++;
        },
      },
    };
    const jobs = new JobsService({
      $transaction: async (body: (tx: unknown) => unknown) => body(tx),
    } as unknown as PrismaService);
    jobs.register("fixture", async () => {});
    jobs.registerQueuePolicy("network", "X", {
      primary: "scan",
      secondary: "recovery",
      primaryWeight: 3,
    });
    jobs.registerClaimGate("fixture", async (job) => {
      gates++;
      assert.deepEqual(job.payload, { generation: 2 });
    });
    const claimed = await jobs.claim("network", now, "X");
    const valid = change !== null && "payload" in change;
    assert.equal(Boolean(claimed), valid, JSON.stringify(change));
    assert.equal(gates, valid ? 1 : 0);
    assert.equal(fairness, valid ? 1 : 0);
    assert.equal(writes, valid ? 1 : 0);
  }
});
