import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectQueue } from "../src/jobs/queue-policy.js";
import { JobDeferred, JobsService } from "../src/jobs/jobs.service.js";
import type { BackgroundJob } from "../src/generated/prisma/client.js";
import type { PrismaService } from "../src/database/prisma.service.js";

function executionDb<T>(boundary: T) {
  const tx = {
    ...boundary,
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    jobQueueState: { findUnique: async () => null },
  };
  return {
    ...tx,
    $transaction: async (body: (value: typeof tx) => unknown) => body(tx),
  } as unknown as PrismaService;
}

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
  const jobs = new JobsService(executionDb(db));
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
  const jobs = new JobsService(executionDb(db));
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
  const events: string[] = [];
  const log = console.info;
  console.info = (line: string) => {
    events.push(line);
  };
  try {
    assert.equal(await jobs.claim("network", new Date(), "X"), null);
  } finally {
    console.info = log;
  }
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0]).reason, "platform_cooldown");
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

test("paused history cannot block new work after the three-primary fairness budget is spent", async () => {
  const { ImageAnalysisService } =
    await import("../src/image-analysis/image-analysis.service.js");
  const { activateImageAnalysisAdapter } =
    await import("../src/image-analysis/image-analysis-adapter.js");
  const { createExampleImageAnalysisAdapter } =
    await import("../src/image-analysis/example-adapter.js");
  const model = activateImageAnalysisAdapter(
    createExampleImageAnalysisAdapter(),
  );
  const rows = Array.from({ length: 101 }, (_, i) => ({
    id: `job-${i}`,
    resourceId: `media-${i}`,
    kind: "image_analysis",
    lane: "analysis",
    executionScope: "global",
    queueName: i === 100 ? "incremental" : "historical",
    status: "queued",
    availableAt: new Date(0),
    attempts: 0,
    payload: { modelKey: model.modelKey },
  }));
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    imageAnalysisActivation: {
      findUnique: async () => ({
        activeModelKey: model.modelKey,
        historicalPaused: true,
      }),
    },
    backgroundJob: {
      updateMany: async () => ({ count: 0 }),
      count: async () => 0,
      groupBy: async ({ where }: { where: { queueName?: { in: string[] } } }) =>
        [
          ...new Set(
            rows
              .filter(
                (r) =>
                  !where.queueName || where.queueName.in.includes(r.queueName),
              )
              .map((r) => r.queueName),
          ),
        ].map((queueName) => ({ queueName })),
      findFirst: async ({
        where,
      }: {
        where: { queueName?: string; createdAt?: unknown };
      }) =>
        where.createdAt
          ? null
          : rows.find((r) => r.queueName === where.queueName),
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) =>
        Object.assign(
          rows.find((r) => r.id === where.id)!,
          data,
        ),
    },
    jobQueueState: {
      findUnique: async () => ({ lastQueue: "incremental", consecutive: 3 }),
      upsert: async () => {},
    },
  };
  const db = {
    $transaction: async (body: (value: typeof tx) => unknown) => body(tx),
  } as unknown as PrismaService;
  const jobs = new JobsService(db);
  new ImageAnalysisService(
    db,
    jobs,
    {} as ConstructorParameters<typeof ImageAnalysisService>[2],
    model,
  ).onModuleInit();
  const claimed = await jobs.claim("analysis");
  assert.equal(claimed?.queueName, "incremental");
  assert.ok(
    rows
      .slice(0, 100)
      .every((r) => r.attempts === 0 && r.availableAt.getTime() === 0),
  );
});

test("execution deferral refunds only its durable primary or secondary fairness advance", async () => {
  type Budget = {
    lastQueue: string;
    consecutive: number;
    advanceLeaseId?: string | null;
    priorLastQueue?: string | null;
    priorConsecutive?: number | null;
  };
  type Job = Pick<
    BackgroundJob,
    | "id"
    | "kind"
    | "lane"
    | "executionScope"
    | "queueName"
    | "status"
    | "attempts"
    | "availableAt"
    | "leaseId"
    | "leaseUntil"
  >;
  for (const queue of ["scan", "recovery"])
    for (const stale of [false, true]) {
      const prior = {
        lastQueue: "scan",
        consecutive: queue === "scan" ? 1 : 3,
      };
      let state: Budget | null = { ...prior };
      let job: Job = {
        id: "job",
        kind: "fixture",
        lane: "network",
        executionScope: "X",
        queueName: queue,
        status: "queued",
        attempts: 0,
        availableAt: new Date(0),
        leaseId: null,
        leaseUntil: null,
      };
      const locks: string[] = [];
      const tx = {
        $executeRaw: async () => {
          locks.push("scope");
        },
        $queryRaw: async () => {
          locks.push("job");
          return [];
        },
        backgroundJob: {
          updateMany: async ({
            where,
            data,
          }: {
            where: { id?: string; leaseId?: string };
            data: Partial<Omit<Job, "attempts">>;
          }) => {
            if (
              where.id !== job.id ||
              where.leaseId !== job.leaseId ||
              job.status !== "running"
            )
              return { count: 0 };
            job = { ...job, ...data, attempts: job.attempts - 1 };
            return { count: 1 };
          },
          count: async () => 0,
          groupBy: async () => [{ queueName: queue }],
          findFirst: async () => job,
          findUnique: async () => job,
          update: async ({ data }: { data: Partial<Omit<Job, "attempts">> }) =>
            (job = { ...job, ...data, attempts: job.attempts + 1 }),
        },
        jobQueueState: {
          findUnique: async () => state,
          upsert: async ({ update }: { update: Budget }) =>
            (state = { ...state, ...update }),
          update: async ({ data }: { data: Partial<Budget> }) =>
            (state = { ...prior, ...state, ...data }),
          delete: async () => {
            state = null;
          },
        },
      };
      const db = {
        ...tx,
        $transaction: async (fn: (value: typeof tx) => Promise<unknown>) =>
          fn(tx),
      };
      const jobs = new JobsService(db as unknown as PrismaService);
      jobs.registerQueuePolicy("network", "X", {
        primary: "scan",
        secondary: "recovery",
        primaryWeight: 3,
      });
      jobs.register("fixture", async () => {
        throw new JobDeferred(new Date(Date.now() + 60000), "capacity");
      });
      const claimed = await jobs.claim("network", new Date(), "X");
      if (stale) {
        job = { ...job, leaseId: "replacement" };
        state = {
          ...state,
          lastQueue: "replacement",
          advanceLeaseId: "replacement",
        };
      }
      locks.length = 0;
      await jobs.execute(claimed!);
      assert.ok(state);
      assert.equal(state.lastQueue, stale ? "replacement" : prior.lastQueue);
      assert.equal(
        state.consecutive,
        stale ? (queue === "scan" ? 2 : 1) : prior.consecutive,
      );
      assert.deepEqual(locks.slice(0, 2), ["scope", "job"]);
      assert.equal(job.status, stale ? "running" : "queued");
    }
});
