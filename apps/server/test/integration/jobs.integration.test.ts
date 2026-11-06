import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import {
  JobsService,
  JOB_LEASE_MS,
  retryDelay,
  JobDeferred,
} from "../../src/jobs/jobs.service.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL required");

test("execution deferral restores only its live lease-owned durable queue receipt", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  await db.$connect();
  const kind = `refund_${randomUUID()}`;
  const scopes: string[] = [];
  try {
    for (const scenario of [
      "absent",
      "zero",
      "primary",
      "secondary",
      "expired",
      "replacement",
    ] as const) {
      const scope = `${kind}:${scenario}`;
      scopes.push(scope);
      const prior =
        scenario === "absent"
          ? null
          : {
              lastQueue: "scan",
              consecutive:
                scenario === "zero" ? 0 : scenario === "secondary" ? 3 : 1,
            };
      if (prior)
        await db.jobQueueState.create({
          data: { lane: "network", scope, ...prior },
        });
      const worker = () => {
        const jobs = new JobsService(db);
        jobs.registerQueuePolicy("network", scope, {
          primary: "scan",
          secondary: "recovery",
          primaryWeight: 3,
        });
        jobs.register(kind, async () => {
          throw new JobDeferred(new Date(Date.now() + 60_000), "capacity");
        });
        return jobs;
      };
      const jobs = worker();
      for (const queueName of ["scan", "recovery"])
        await jobs.enqueue({
          kind,
          resourceId: randomUUID(),
          idempotencyKey: `${scope}:${queueName}`,
          lane: "network",
          executionScope: scope,
          queueName,
          priority: 100,
        });
      const claimed = await jobs.claim("network", new Date(), scope);
      assert.ok(claimed);
      assert.equal(
        claimed.queueName,
        scenario === "secondary" ? "recovery" : "scan",
      );
      const where = { lane_scope: { lane: "network" as const, scope } };
      const receipt = await db.jobQueueState.findUniqueOrThrow({ where });
      assert.equal(receipt.advanceLeaseId, claimed.leaseId);
      assert.equal(receipt.priorLastQueue, prior?.lastQueue ?? null);
      assert.equal(receipt.priorConsecutive, prior?.consecutive ?? null);
      if (scenario === "expired" || scenario === "replacement")
        await db.backgroundJob.update({
          where: { id: claimed.id },
          data: { leaseUntil: new Date(0) },
        });
      let replacement = null;
      if (scenario === "replacement") {
        replacement = await worker().claim("network", new Date(), scope);
        assert.ok(replacement);
        assert.equal(replacement.id, claimed.id);
        assert.notEqual(replacement.leaseId, claimed.leaseId);
      }
      const before = await db.jobQueueState.findUniqueOrThrow({ where });
      await jobs.execute(claimed);
      const row = await db.backgroundJob.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      const state = await db.jobQueueState.findUnique({ where });
      if (scenario === "expired" || scenario === "replacement") {
        assert.deepEqual(state, before, scenario);
        assert.equal(row.status, "running");
        assert.equal(row.attempts, replacement ? 2 : 1);
        assert.equal(row.leaseId, replacement?.leaseId ?? claimed.leaseId);
      } else {
        assert.equal(row.status, "queued");
        assert.equal(row.attempts, 0);
        assert.equal(row.leaseId, null);
        assert.equal(row.lastError, "capacity");
        if (!prior) assert.equal(state, null);
        else {
          assert.ok(state);
          assert.equal(state.lastQueue, prior.lastQueue);
          assert.equal(state.consecutive, prior.consecutive);
          assert.equal(state.advanceLeaseId, null);
          assert.equal(state.priorLastQueue, null);
          assert.equal(state.priorConsecutive, null);
        }
      }
    }
  } finally {
    await db.backgroundJob.deleteMany({ where: { kind } });
    await db.jobQueueState.deleteMany({
      where: { lane: "network", scope: { in: scopes } },
    });
    await db.$disconnect();
  }
});

test("claim rejects concurrent retirement and scope moves, and gates read post-selection payload updates", async () => {
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  await module.init();
  const db = module.get(PrismaService);
  const kind = `race_${randomUUID()}`;
  const scopes: string[] = [];
  try {
    for (const scenario of ["retire", "move", "payload"] as const) {
      const scope = `${kind}:${scenario}`;
      scopes.push(scope, `${scope}:moved`);
      const queued = await new JobsService(db).enqueue({
        kind,
        resourceId: randomUUID(),
        idempotencyKey: scope,
        lane: "network",
        executionScope: scope,
        queueName: "scan",
        payload: { generation: 1 },
      });
      let interleaved = false,
        gateCalls = 0;
      // A second real connection commits a management update exactly after the
      // candidate reads and before the claimant's FOR UPDATE. No timing sleeps.
      const intercepted = {
        $transaction: (
          body: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) =>
          db.$transaction((tx) =>
            body(
              new Proxy(tx, {
                get(target, property) {
                  if (property === "$queryRaw")
                    return async (...args: unknown[]) => {
                      assert.equal(interleaved, false);
                      interleaved = true;
                      await db.backgroundJob.update({
                        where: { id: queued.id },
                        data:
                          scenario === "retire"
                            ? { status: "failed", completedAt: new Date() }
                            : scenario === "move"
                              ? { executionScope: `${scope}:moved` }
                              : { payload: { generation: 2 } },
                      });
                      return Reflect.apply(target.$queryRaw, target, args);
                    };
                  return Reflect.get(target, property);
                },
              }),
            ),
          ),
      };
      const jobs = new JobsService(intercepted as unknown as PrismaService);
      jobs.register(kind, async () => {});
      jobs.registerQueuePolicy("network", scope, {
        primary: "scan",
        secondary: "recovery",
        primaryWeight: 3,
      });
      jobs.registerClaimGate(kind, async (job) => {
        gateCalls++;
        assert.deepEqual(job.payload, { generation: 2 });
      });
      const claimed = await jobs.claim("network", new Date(), scope);
      assert.equal(interleaved, true);
      const valid = scenario === "payload";
      assert.equal(Boolean(claimed), valid);
      assert.equal(gateCalls, valid ? 1 : 0);
      const state = await db.jobQueueState.findUnique({
        where: { lane_scope: { lane: "network", scope } },
      });
      assert.equal(state?.consecutive ?? 0, valid ? 1 : 0);
      const current = await db.backgroundJob.findUniqueOrThrow({
        where: { id: queued.id },
      });
      assert.equal(current.attempts, valid ? 1 : 0);
      if (valid) assert.deepEqual(claimed?.payload, { generation: 2 });
      else
        assert.equal(
          current.status,
          scenario === "retire" ? "failed" : "queued",
        );
    }
  } finally {
    await db.backgroundJob.deleteMany({ where: { kind } });
    await db.jobQueueState.deleteMany({ where: { scope: { in: scopes } } });
    await module.close();
  }
});

test("scope locks, durable queue budgets, within-queue aging and gates survive worker replacement", async () => {
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  await module.init();
  const db = module.get(PrismaService);
  const prefix = randomUUID();
  const kind = `scope_${prefix}`;
  const scopes = [
    `${prefix}:X`,
    `${prefix}:P`,
    `${prefix}:fair`,
    `${prefix}:gate`,
  ];
  const policy = { primary: "scan", secondary: "recovery", primaryWeight: 3 };
  const worker = () => {
    const jobs = new JobsService(db);
    jobs.register(kind, async () => {});
    jobs.registerQueuePolicy("network", scopes[2], policy);
    return jobs;
  };
  const jobs = worker();
  const peer = worker();
  let n = 0;
  const enqueue = (scope: string, queueName = "default", priority = 10) =>
    jobs.enqueue({
      kind,
      resourceId: randomUUID(),
      idempotencyKey: `${prefix}:${n++}`,
      lane: "network",
      executionScope: scope,
      queueName,
      priority,
    });
  try {
    await enqueue(scopes[0]);
    await enqueue(scopes[0]);
    await enqueue(scopes[1]);
    const concurrent = await Promise.all([
      jobs.claim("network", new Date(), scopes[0]),
      peer.claim("network", new Date(), scopes[0]),
    ]);
    assert.equal(concurrent.filter(Boolean).length, 1);
    const independent = await peer.claim("network", new Date(), scopes[1]);
    assert.ok(independent, "another scope progresses while X is live");
    await jobs.execute(concurrent.find(Boolean)!);
    await peer.execute(independent);

    for (let i = 0; i < 7; i++) await enqueue(scopes[2], "scan", 1);
    const agedRecovery = await enqueue(scopes[2], "recovery", 100);
    await enqueue(scopes[2], "recovery", 100);
    await db.backgroundJob.update({
      where: { id: agedRecovery.id },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      // New service instance each claim proves counters belong to the database.
      const restarted = worker();
      const job = await restarted.claim("network", new Date(), scopes[2]);
      assert.ok(job);
      order.push(job.queueName);
      await restarted.execute(job);
      if (i === 3) assert.equal(job.id, agedRecovery.id);
    }
    assert.deepEqual(order, [
      "scan",
      "scan",
      "scan",
      "recovery",
      "scan",
      "scan",
      "scan",
      "recovery",
    ]);
    const onlyPrimary = await jobs.claim("network", new Date(), scopes[2]);
    assert.equal(onlyPrimary?.queueName, "scan");
    await jobs.execute(onlyPrimary!);

    const low = await enqueue(scopes[3], "default", 1);
    const high = await enqueue(scopes[3], "default", 100);
    await db.backgroundJob.update({
      where: { id: low.id },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });
    assert.equal(
      (await jobs.claim("network", new Date(), scopes[3]))?.id,
      low.id,
    );
    await db.backgroundJob.update({
      where: { id: low.id },
      data: { status: "succeeded", leaseId: null, leaseUntil: null },
    });
    const gated = worker();
    const retryAt = new Date(Date.now() + 60_000);
    gated.registerClaimGate(
      kind,
      async () => new JobDeferred(retryAt, "platform_cooldown"),
    );
    assert.equal(await gated.claim("network", new Date(), scopes[3]), null);
    const denied = await db.backgroundJob.findUniqueOrThrow({
      where: { id: high.id },
    });
    assert.equal(denied.attempts, 0);
    assert.equal(denied.status, "queued");
    assert.equal(denied.availableAt.getTime(), retryAt.getTime());
    await db.backgroundJob.update({
      where: { id: high.id },
      data: { availableAt: new Date(0), attempts: 2 },
    });
    const deferring = new JobsService(db);
    deferring.register(kind, async () => {
      throw new JobDeferred(retryAt, "credential_unavailable");
    });
    const third = await deferring.claim("network", new Date(), scopes[3]);
    assert.equal(third?.attempts, 3);
    await deferring.execute(third!);
    const deferred = await db.backgroundJob.findUniqueOrThrow({
      where: { id: high.id },
    });
    assert.equal(deferred.status, "queued");
    assert.equal(deferred.attempts, 2);
    assert.equal(await worker().claim("network", new Date(), scopes[3]), null);
  } finally {
    await db.backgroundJob.deleteMany({ where: { kind } });
    await db.jobQueueState.deleteMany({ where: { scope: { in: scopes } } });
    await module.close();
  }
});

test("durable jobs serialize global lanes, recover leases and preserve retries", async () => {
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  await module.init();
  const db = module.get(PrismaService);
  const jobs = new JobsService(db);
  const peer = new JobsService(db);
  const kind = `fixture_${randomUUID()}`;
  const ids: string[] = [];
  let count = 0;
  jobs.register(kind, async () => {
    count++;
  });
  peer.register(kind, async () => {
    count++;
  });
  try {
    const input = {
      kind,
      resourceId: randomUUID(),
      idempotencyKey: kind,
      lane: "heavy" as const,
    };
    const duplicates = await Promise.all([
      jobs.enqueue(input),
      peer.enqueue(input),
    ]);
    assert.equal(duplicates[0].id, duplicates[1].id);
    ids.push(duplicates[0].id);
    const second = await jobs.enqueue({
      ...input,
      idempotencyKey: `${kind}:2`,
    });
    ids.push(second.id);
    const claimed = await Promise.all([
      jobs.claim("heavy"),
      peer.claim("heavy"),
    ]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const original = claimed.find(Boolean)!;
    assert.equal(await peer.claim("heavy"), null);
    await db.backgroundJob.update({
      where: { id: original.id },
      data: { leaseUntil: new Date(Date.now() - JOB_LEASE_MS) },
    });
    const recovered = await peer.claim("heavy");
    assert.equal(recovered?.id, original.id);
    assert.equal(recovered?.attempts, 2);
    assert.notEqual(recovered?.leaseId, original.leaseId);
    await peer.execute(recovered!);
    await jobs.runNext("heavy");
    assert.equal(count, 2);
    const failingKind = `${kind}:fail`;
    jobs.register(failingKind, async () => {
      throw new Error("secret payload must not be logged");
    });
    const failed = await jobs.enqueue({
      ...input,
      kind: failingKind,
      idempotencyKey: failingKind,
    });
    ids.push(failed.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await db.backgroundJob.update({
        where: { id: failed.id },
        data: { availableAt: new Date(0) },
      });
      await jobs.runNext("heavy");
      const current = await db.backgroundJob.findUniqueOrThrow({
        where: { id: failed.id },
      });
      assert.equal(current.attempts, attempt);
      assert.equal(current.status, attempt === 3 ? "failed" : "queued");
      assert.ok(!current.lastError?.includes("secret"));
    }
    assert.equal(retryDelay(2), 10_000);
  } finally {
    await db.backgroundJob.deleteMany({ where: { id: { in: ids } } });
    await module.close();
  }
});

test("scheduler is disabled by default and advances one durable tick without catchup", async () => {
  const disabled = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  await disabled.init();
  assert.equal(await disabled.get(SourceFetchService).scheduleDue(), false);
  await disabled.close();
  const enabled = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({
          NODE_ENV: "test",
          DATABASE_URL: url,
          SOURCE_SCHEDULE_ENABLED: "true",
          SOURCE_SCHEDULE_MINUTES: "60",
        }),
      ),
    ],
  }).compile();
  await enabled.init();
  const db = enabled.get(PrismaService);
  try {
    await db.workerSchedule.deleteMany({ where: { name: "sources" } });
    const now = new Date("2026-10-04T12:00:00Z");
    await Promise.all([
      enabled.get(SourceFetchService).scheduleDue(now),
      enabled.get(SourceFetchService).scheduleDue(now),
    ]);
    const tick = await db.workerSchedule.findUniqueOrThrow({
      where: { name: "sources" },
    });
    assert.equal(tick.dueAt.toISOString(), "2026-10-04T13:00:00.000Z");
    assert.equal(await enabled.get(SourceFetchService).scheduleDue(now), false);
  } finally {
    await db.workerSchedule.deleteMany({ where: { name: "sources" } });
    await enabled.close();
  }
});
