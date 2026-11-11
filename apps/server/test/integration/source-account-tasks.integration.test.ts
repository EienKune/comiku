import { rawQueryValues } from "../raw-query-values.js";
/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { JobDeferred } from "../../src/jobs/jobs.service.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { SourceResponseError } from "../../src/source-ingestion/source-response.js";
import type { ContentSourceClient } from "../../src/source-ingestion/content-source.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL ending _test required");
const pause = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function fixture() {
  const prefix = `d6_${randomUUID()}`;
  const dir = await mkdtemp(join(tmpdir(), "comiku-d6-"));
  const xConfigPath = join(dir, "x.json"),
    pixivConfigPath = join(dir, "pixiv.json");
  await writeFile(
    xConfigPath,
    JSON.stringify({
      extractor: { twitter: { cookies: join(dir, "x.cookies") } },
    }),
  );
  await writeFile(join(dir, "x.cookies"), "synthetic-one");
  await writeFile(pixivConfigPath, "{}");
  const environment = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
  environment.galleryDl = {
    python: join(dir, "synthetic-python"),
    xConfigPath,
    pixivConfigPath,
  };
  const db = new PrismaService(environment);
  await db.onModuleInit();
  const jobs = new JobsService(db),
    peerJobs = new JobsService(db);
  const registry = new ContentSourceRegistry();
  const entered = { x: pause(), pixiv: pause() },
    release = { x: pause(), pixiv: pause() };
  const calls = { x: 0, pixiv: 0 };
  const fail: Partial<Record<"x" | "pixiv", unknown>> = {};
  let block = false;
  for (const platform of ["x", "pixiv"] as const) {
    const client: ContentSourceClient = {
      platform,
      adapterKey: `fixture_${platform}`,
      available: true,
      metered: false,
      priority: 1,
      supportedFirstSyncModes: ["none"],
      allowedMediaHosts: ["fixture.invalid"],
      initialCursor: () => ({}),
      checkAccount: async (account) => account,
      fetchPage: async () => {
        calls[platform]++;
        entered[platform].release();
        if (block) await release[platform].promise;
        if (fail[platform]) throw fail[platform];
        return { items: [], complete: true, nextCursor: {} };
      },
    };
    registry.register(client);
  }
  const make = (engine: JobsService) =>
    new SourceFetchService(
      engine,
      db,
      registry,
      {
        download: async () => {
          throw new Error("No media I/O allowed");
        },
      } as any,
      {
        store: async () => {
          throw new Error("No storage allowed");
        },
      } as any,
      environment,
    );
  const service = make(jobs),
    peer = make(peerJobs);
  service.onModuleInit();
  peer.onModuleInit();
  let prepared;
  try {
    prepared = await db.$transaction(async (tx) => {
      const actor = await tx.user.create({
        data: {
          username: prefix,
          displayName: "synthetic",
          passwordHash: "disabled",
          mustChangePassword: false,
          roles: { create: { role: "source" } },
        },
      });
      const author = await tx.author.create({
        data: { displayName: prefix, authorizationStatus: "authorized" },
      });
      const secondAuthor = await tx.author.create({
        data: {
          displayName: `${prefix}_second`,
          authorizationStatus: "authorized",
        },
      });
      const accounts = [];
      for (const [index, platform] of ["x", "pixiv", "x"].entries())
        accounts.push(
          await tx.authorExternalAccount.create({
            data: {
              authorId: index === 2 ? secondAuthor.id : author.id,
              platform,
              externalUserId: `${prefix}-${index}`,
              fetchEnabled: true,
              firstSyncMode: "none",
            },
          }),
        );
      return { actor, author, secondAuthor, accounts };
    });
  } catch (error) {
    await db.onModuleDestroy();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const { actor, author, secondAuthor, accounts } = prepared;
  const deleteOwnedSetup = async () => {
    await db.authorExternalAccount.deleteMany({
      where: { id: { in: accounts.map((account) => account.id) } },
    });
    await db.author.deleteMany({
      where: { id: { in: [author.id, secondAuthor.id] } },
    });
    await db.userRole.deleteMany({ where: { userId: actor.id } });
    await db.user.delete({ where: { id: actor.id } });
  };
  const runs: string[] = [];
  const manual = async (ids = accounts.slice(0, 2).map((a) => a.id)) => {
    const run = await service.runManual(actor.id, { accountIds: ids });
    runs.push(run.id);
    return run;
  };
  // Fixture owns only these two shared rows in the disposable serial suite.
  let previous: Awaited<ReturnType<typeof db.sourcePlatformState.findMany>>;
  try {
    previous = await db.sourcePlatformState.findMany({
      where: { platform: { in: ["x", "pixiv"] } },
    });
    await db.sourcePlatformState.deleteMany({
      where: { platform: { in: ["x", "pixiv"] } },
    });
  } catch (error) {
    try {
      await deleteOwnedSetup();
    } finally {
      await db.onModuleDestroy();
      await rm(dir, { recursive: true, force: true });
    }
    throw error;
  }
  const cleanup = async () => {
    release.x.release();
    release.pixiv.release();
    const tasks = await db.sourceFetchAccountTask.findMany({
      where: { accountId: { in: accounts.map((account) => account.id) } },
      select: { jobId: true, runId: true },
    });
    runs.push(...tasks.map((task) => task.runId));
    await db.sourceFetchRun.deleteMany({ where: { id: { in: runs } } });
    await db.backgroundJob.deleteMany({
      where: {
        OR: [
          { id: { in: tasks.flatMap((t) => (t.jobId ? [t.jobId] : [])) } },
          { actorId: actor.id },
        ],
      },
    });
    await db.sourcePlatformExecution.deleteMany({
      where: { ownerId: { in: [jobs.ownerId, peerJobs.ownerId] } },
    });
    await deleteOwnedSetup();
    await db.sourcePlatformState.deleteMany({
      where: { platform: { in: ["x", "pixiv"] } },
    });
    if (previous.length)
      await db.sourcePlatformState.createMany({ data: previous });
    await db.onModuleDestroy();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    db,
    jobs,
    peerJobs,
    service,
    peer,
    actor,
    author,
    accounts,
    manual,
    cleanup,
    calls,
    fail,
    entered,
    release,
    setBlock: () => {
      block = true;
    },
    dir,
    xConfigPath,
    environment,
  };
}

test("maintenance sees the claim-to-handler admission even after lease expiry and isolates the other platform", async () => {
  const f = await fixture();
  try {
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    await f.manual();
    const x = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(x);
    const execution = await f.db.sourcePlatformExecution.findUniqueOrThrow({
      where: { jobId_leaseId: { jobId: x.id, leaseId: x.leaseId! } },
    });
    assert.equal(execution.taskId, x.resourceId);
    assert.equal(execution.budgetAttempt, 1);
    assert.equal(execution.settledAt, null);
    const initial = await f.service.platforms.maintenanceStatus("x");
    const paused = await f.service.platforms.pauseMaintenance("x", f.actor.id, {
      expectedEpoch: initial.maintenanceEpoch,
      expectedGeneration: initial.credentialGeneration!,
    });
    assert.equal(paused.unsettledExecutions, 1);
    const expected = {
      expectedEpoch: paused.maintenanceEpoch,
      expectedGeneration: paused.credentialGeneration!,
    };
    await f.db.backgroundJob.update({
      where: { id: x.id },
      data: { leaseUntil: new Date(0) },
    });
    await assert.rejects(
      f.service.platforms.resumeMaintenance("x", f.actor.id, expected),
      /not confirmed/,
    );
    assert.equal(await f.jobs.claim("network", new Date(), "source:x"), null);
    assert.equal(
      await f.db.sourcePlatformExecution.count({ where: { jobId: x.id } }),
      1,
      "gate polling cannot manufacture executions",
    );
    const p = await f.peerJobs.claim("network", new Date(), "source:pixiv");
    assert.ok(p);
    await f.peerJobs.execute(p);
    assert.equal(f.calls.pixiv, 1);
    assert.equal(f.calls.x, 0);
    // This local owner has not contacted a source; returning it now confirms its
    // own resource boundary without reviving the replaced job lease.
    await f.jobs.execute(x);
    assert.equal(
      (await f.service.platforms.maintenanceStatus("x")).unsettledExecutions,
      0,
    );
    const after = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: x.id },
    });
    assert.equal(after.lastError, "platform_maintenance");
    await f.service.platforms.resumeMaintenance("x", f.actor.id, expected);
    const resumed = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: x.id },
    });
    assert.equal(resumed.attempts, 1);
    assert.ok(resumed.availableAt <= new Date());
  } finally {
    await f.cleanup();
  }
});

test("an in-flight profile avatar boundary blocks maintenance despite an expired interactive lease", async () => {
  const f = await fixture(),
    entered = pause(),
    release = pause();
  let running: Promise<string> | undefined;
  try {
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    running = f.service.platforms.profileNetwork(f.actor.id, async () => {
      entered.release();
      await release.promise;
      return "profile plus avatar";
    });
    await entered.promise;
    const initial = await f.service.platforms.maintenanceStatus("x");
    const paused = await f.service.platforms.pauseMaintenance("x", f.actor.id, {
      expectedEpoch: initial.maintenanceEpoch,
      expectedGeneration: initial.credentialGeneration!,
    });
    await f.db.backgroundJob.updateMany({
      where: { actorId: f.actor.id, kind: "source_profile_resolve" },
      data: { leaseUntil: new Date(0) },
    });
    const expected = {
      expectedEpoch: paused.maintenanceEpoch,
      expectedGeneration: paused.credentialGeneration!,
    };
    await assert.rejects(
      f.service.platforms.resumeMaintenance("x", f.actor.id, expected),
      /not confirmed/,
    );
    release.release();
    await assert.rejects(running, /过期/);
    await f.service.platforms.resumeMaintenance("x", f.actor.id, expected);
    assert.equal(
      (await f.service.platforms.maintenanceStatus("x")).maintenancePaused,
      false,
    );
  } finally {
    release.release();
    await Promise.allSettled([running]);
    await f.cleanup();
  }
});

test("a real profile job renews during a virtual 63-second profile and avatar without sleeping its lease duration", async (t) => {
  const f = await fixture(),
    start = new Date();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: start });
  try {
    const result = await f.service.platforms.profileNetwork(
      f.actor.id,
      async () => {
        for (let step = 0; step < 4; step++) {
          t.mock.timers.tick(15_000);
          const expected = Math.min(
            Date.now() + 60_000,
            start.getTime() + 120_000,
          );
          let renewed = false;
          for (let attempt = 0; attempt < 80; attempt++) {
            const job = await f.db.backgroundJob.findFirstOrThrow({
              where: {
                actorId: f.actor.id,
                kind: "source_profile_resolve",
                status: "running",
              },
            });
            if (job.leaseUntil?.getTime() === expected) {
              renewed = true;
              break;
            }
            await delay(2);
          }
          assert.ok(
            renewed,
            "the actual heartbeat transaction must extend the PostgreSQL lease",
          );
        }
        t.mock.timers.tick(3_000);
        assert.equal(
          await f.db.sourcePlatformExecution.count({
            where: { ownerId: f.jobs.ownerId, settledAt: null },
          }),
          1,
        );
        return "verified profile plus avatar";
      },
    );
    assert.equal(result, "verified profile plus avatar");
    const job = await f.db.backgroundJob.findFirstOrThrow({
      where: { actorId: f.actor.id, kind: "source_profile_resolve" },
    });
    assert.equal(job.status, "succeeded");
    assert.equal(
      await f.db.sourcePlatformExecution.count({
        where: { ownerId: f.jobs.ownerId, settledAt: null },
      }),
      0,
    );
  } finally {
    t.mock.timers.reset();
    await f.cleanup();
  }
});

test("a configured platform can enter maintenance before its first run without any GET or platform write", async () => {
  const f = await fixture();
  try {
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    const status = await f.service.platforms.maintenanceStatus("pixiv");
    assert.ok(
      status.credentialGeneration,
      "a readable empty config can be maintained before adding its token",
    );
    assert.equal(status.maintenanceEpoch, 0);
    assert.equal(
      await f.db.sourcePlatformState.count({ where: { platform: "pixiv" } }),
      0,
    );
    assert.equal(
      await f.db.sourcePlatformExecution.count({
        where: { ownerId: f.jobs.ownerId },
      }),
      0,
    );
    const paused = await f.service.platforms.pauseMaintenance(
      "pixiv",
      f.actor.id,
      { expectedEpoch: 0, expectedGeneration: status.credentialGeneration! },
    );
    assert.equal(paused.maintenancePaused, true);
    assert.equal(paused.maintenanceEpoch, 1);
    const state = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "pixiv" },
    });
    assert.equal(state.status, "unverified");
    assert.equal(state.credentialGeneration, status.credentialGeneration);
    assert.equal(f.calls.pixiv, 0);
    assert.equal(f.calls.x, 0);
  } finally {
    await f.cleanup();
  }
});

test("first-use maintenance refuses an unknown execution and a changed or unreadable config without initializing state", async () => {
  const f = await fixture();
  try {
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    const status = await f.service.platforms.maintenanceStatus("x"),
      expected = {
        expectedEpoch: 0,
        expectedGeneration: status.credentialGeneration!,
      };
    const unknown = await f.db.sourcePlatformExecution.create({
      data: {
        platform: "x",
        kind: "profile",
        ownerId: f.jobs.ownerId,
        jobId: randomUUID(),
        leaseId: randomUUID(),
        credentialGeneration: status.credentialGeneration!,
        budgetAttempt: 1,
      },
    });
    await assert.rejects(
      f.service.platforms.pauseMaintenance("x", f.actor.id, expected),
      /not confirmed/,
    );
    assert.equal(
      await f.db.sourcePlatformState.count({ where: { platform: "x" } }),
      0,
    );
    await f.db.sourcePlatformExecution.delete({ where: { id: unknown.id } });
    await writeFile(f.xConfigPath, '{"synthetic":"changed before pause"}');
    await assert.rejects(
      f.service.platforms.pauseMaintenance("x", f.actor.id, expected),
      /changed/,
    );
    assert.equal(
      await f.db.sourcePlatformState.count({ where: { platform: "x" } }),
      0,
    );
    await writeFile(f.xConfigPath, "{");
    assert.equal(
      (await f.service.platforms.maintenanceStatus("x")).credentialGeneration,
      null,
    );
    await assert.rejects(
      f.service.platforms.pauseMaintenance("x", f.actor.id, expected),
      /changed/,
    );
    assert.equal(
      await f.db.sourcePlatformState.count({ where: { platform: "x" } }),
      0,
    );
    assert.equal(f.calls.x, 0);
  } finally {
    await f.cleanup();
  }
});

test("maintenance and claim share the actual PostgreSQL scope barrier", async () => {
  const f = await fixture(),
    locked = pause(),
    release = pause(),
    attempted = pause();
  let claim: Promise<unknown> | undefined;
  try {
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    await f.manual([f.accounts[0].id]);
    const generation = await f.service.platforms.fingerprint("x");
    assert.ok(generation);
    await f.db.sourcePlatformState.create({
      data: { platform: "x", credentialGeneration: generation },
    });
    const maintenance = f.db.$transaction(async (tx) => {
      await f.service.platforms.lockMaintenance(tx, "x");
      locked.release();
      await release.promise;
      await tx.sourcePlatformState.update({
        where: { platform: "x" },
        data: { maintenancePaused: true, maintenanceEpoch: { increment: 1 } },
      });
    });
    await locked.promise;
    const original = f.peerJobs.lockScope.bind(f.peerJobs);
    let waitingPid = 0;
    f.peerJobs.lockScope = async (tx, lane, scope) => {
      if (scope === "source:x") {
        const [backend] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        waitingPid = backend.pid;
        attempted.release();
      }
      await original(tx, lane, scope);
    };
    claim = f.peerJobs.claim("network", new Date(), "source:x");
    await attempted.promise;
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const [row] = await f.db.$queryRaw<
        { blocked: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${waitingPid} AND locktype='advisory' AND NOT granted) AS blocked`;
      if (row.blocked) {
        blocked = true;
        break;
      }
      await delay(10);
    }
    assert.ok(
      blocked,
      "claim must actually wait for the maintenance advisory lock",
    );
    release.release();
    await maintenance;
    assert.equal(await claim, null);
    assert.equal(
      await f.db.sourcePlatformExecution.count({
        where: { ownerId: f.peerJobs.ownerId },
      }),
      0,
    );
  } finally {
    release.release();
    await Promise.allSettled([claim]);
    await f.cleanup();
  }
});

test("execution registration and the running job roll back together", async () => {
  const f = await fixture();
  const original = f.service.platforms.executions.admit.bind(
    f.service.platforms.executions,
  );
  try {
    await f.manual([f.accounts[0].id]);
    f.service.platforms.executions.admit = async (tx, input) => {
      await original(tx, input);
      throw new Error("synthetic transaction fault after execution insert");
    };
    await assert.rejects(
      f.jobs.claim("network", new Date(), "source:x"),
      /synthetic transaction fault/,
    );
    const task = await f.db.sourceFetchAccountTask.findFirstOrThrow({
      where: { accountId: f.accounts[0].id },
    });
    const job = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: task.jobId! },
    });
    assert.equal(job.status, "queued");
    assert.equal(job.attempts, 0);
    assert.equal(task.status, "queued");
    assert.equal(
      await f.db.sourcePlatformExecution.count({ where: { jobId: job.id } }),
      0,
    );
    assert.equal(
      await f.db.sourcePlatformState.count({ where: { platform: "x" } }),
      0,
    );
  } finally {
    f.service.platforms.executions.admit = original;
    await f.cleanup();
  }
});

test("a refunded third attempt has its own immutable lease execution before another third attempt", async () => {
  const f = await fixture();
  const original = f.service.platforms.beforeNetwork.bind(f.service.platforms);
  try {
    await f.manual([f.accounts[0].id]);
    const task = await f.db.sourceFetchAccountTask.findFirstOrThrow({
      where: { accountId: f.accounts[0].id },
    });
    await f.db.backgroundJob.update({
      where: { id: task.jobId! },
      data: { attempts: 2 },
    });
    const first = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(first);
    f.service.platforms.beforeNetwork = async () => {
      throw new JobDeferred(
        new Date(Date.now() + 60_000),
        "platform_maintenance",
      );
    };
    await f.jobs.execute(first);
    const refunded = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: first.id },
    });
    const fact = await f.db.sourcePlatformExecution.findUniqueOrThrow({
      where: { jobId_leaseId: { jobId: first.id, leaseId: first.leaseId! } },
    });
    assert.equal(refunded.attempts, 2);
    assert.equal(refunded.status, "queued");
    assert.equal(fact.budgetRefunded, true);
    assert.equal(fact.businessOutcome, "deferred");
    assert.ok(fact.settledAt);
    f.service.platforms.beforeNetwork = original;
    await f.db.backgroundJob.update({
      where: { id: first.id },
      data: { availableAt: new Date(0) },
    });
    const second = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(second);
    assert.equal(second.attempts, 3);
    assert.notEqual(second.leaseId, first.leaseId);
    await f.jobs.execute(second);
    await f.jobs.execute(first); // A stale local return may settle only its own immutable fact.
    const facts = await f.db.sourcePlatformExecution.findMany({
      where: { jobId: first.id },
      orderBy: { admittedAt: "asc" },
    });
    assert.equal(facts.length, 2);
    assert.deepEqual(
      facts.map((row) => row.budgetAttempt),
      [3, 3],
    );
    const newer = facts.find((row) => row.leaseId === second.leaseId)!;
    assert.equal(newer.businessOutcome, "succeeded");
    assert.ok(newer.settledAt);
  } finally {
    f.service.platforms.beforeNetwork = original;
    await f.cleanup();
  }
});

test("maintenance validation records its bounded execution and leaves the platform paused and unverified", async () => {
  const f = await fixture();
  try {
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    await f.service.platforms.profileNetwork(
      f.actor.id,
      async () => "bootstrap",
    );
    const initial = await f.service.platforms.maintenanceStatus("x");
    const paused = await f.service.platforms.pauseMaintenance("x", f.actor.id, {
      expectedEpoch: initial.maintenanceEpoch,
      expectedGeneration: initial.credentialGeneration!,
    });
    await f.db.sourcePlatformState.update({
      where: { platform: "x" },
      data: { status: "unverified" },
    });
    let calls = 0;
    assert.equal(
      await f.service.platforms.runMaintenanceValidation(
        "x",
        f.actor.id,
        {
          expectedEpoch: paused.maintenanceEpoch,
          expectedGeneration: paused.credentialGeneration!,
        },
        async () => {
          calls++;
          return "bounded auth";
        },
      ),
      "bounded auth",
    );
    assert.equal(calls, 1);
    assert.equal(f.calls.x, 0);
    const state = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    assert.equal(state.status, "unverified");
    assert.equal(state.maintenancePaused, true);
    const facts = await f.db.sourcePlatformExecution.findMany({
      where: { ownerId: f.jobs.ownerId, kind: "credential_validation" },
    });
    assert.equal(facts.length, 1);
    assert.ok(facts[0].settledAt);
  } finally {
    await f.cleanup();
  }
});

for (const change of ["drift", "invalid"] as const)
  test(`maintenance resume rejects ${change} in the real credential file without changing platform or queued work`, async () => {
    const f = await fixture();
    try {
      await f.db.userRole.create({
        data: { userId: f.actor.id, role: "admin" },
      });
      await f.manual([f.accounts[0].id]);
      await f.service.platforms.profileNetwork(
        f.actor.id,
        async () => "bounded bootstrap",
      );
      const initial = await f.service.platforms.maintenanceStatus("x");
      const paused = await f.service.platforms.pauseMaintenance(
        "x",
        f.actor.id,
        {
          expectedEpoch: initial.maintenanceEpoch,
          expectedGeneration: initial.credentialGeneration!,
        },
      );
      assert.equal(await f.jobs.claim("network", new Date(), "source:x"), null);
      const expected = {
        expectedEpoch: paused.maintenanceEpoch,
        expectedGeneration: paused.credentialGeneration!,
      };
      const task = await f.db.sourceFetchAccountTask.findFirstOrThrow({
        where: { accountId: f.accounts[0].id },
      });
      const job = await f.db.backgroundJob.findUniqueOrThrow({
        where: { id: task.jobId! },
      });
      const state = await f.db.sourcePlatformState.findUniqueOrThrow({
        where: { platform: "x" },
      });
      const original = await readFile(f.xConfigPath);
      await writeFile(
        f.xConfigPath,
        change === "drift" ? '{"synthetic":"externally changed"}' : "{",
      );
      const actual = await f.service.platforms.fingerprint("x");
      if (change === "invalid") assert.equal(actual, null);
      else assert.notEqual(actual, expected.expectedGeneration);
      await assert.rejects(
        f.service.platforms.resumeMaintenance("x", f.actor.id, expected),
        (error: any) =>
          error.getStatus?.() === 409 &&
          /configuration changed or unavailable/.test(error.message),
      );
      assert.deepEqual(
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        }),
        state,
      );
      assert.deepEqual(
        await f.db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }),
        job,
      );
      assert.deepEqual(
        await f.db.sourceFetchAccountTask.findUniqueOrThrow({
          where: { id: task.id },
        }),
        task,
      );
      // Restoring the exact material makes a subsequent explicit resume eligible;
      // a rejected resume itself never changes generation or repairs the file.
      await writeFile(f.xConfigPath, original);
      await f.service.platforms.resumeMaintenance("x", f.actor.id, expected);
      assert.equal(
        (await f.service.platforms.maintenanceStatus("x")).maintenancePaused,
        false,
      );
    } finally {
      await f.cleanup();
    }
  });

test("settled execution retention removes at most 100 old rows and never ages out an unconfirmed owner", async () => {
  const f = await fixture();
  try {
    const now = new Date(),
      cutoff = new Date(now.getTime() - 30 * 86400_000),
      old = new Date(now.getTime() - 31 * 86400_000);
    const rows = Array.from({ length: 104 }, (_, index) => ({
      id: randomUUID(),
      platform: "x",
      kind: "scan",
      ownerId: f.jobs.ownerId,
      jobId: randomUUID(),
      leaseId: randomUUID(),
      credentialGeneration: "a".repeat(64),
      budgetAttempt: 1,
      admittedAt: new Date(now.getTime() - 40 * 86400_000),
      settledAt:
        index < 101 ? old : index === 101 ? cutoff : index === 102 ? now : null,
    }));
    await f.db.sourcePlatformExecution.createMany({ data: rows });
    assert.equal(await f.service.platforms.executions.pruneSettled(now), 100);
    assert.equal(
      await f.db.sourcePlatformExecution.count({
        where: { ownerId: f.jobs.ownerId },
      }),
      4,
    );
    assert.equal(await f.service.platforms.executions.pruneSettled(now), 1);
    const remaining = await f.db.sourcePlatformExecution.findMany({
      where: { ownerId: f.jobs.ownerId },
    });
    assert.deepEqual(
      new Set(remaining.map((row) => row.id)),
      new Set(rows.slice(101).map((row) => row.id)),
    );
    assert.equal(
      remaining.find((row) => row.id === rows[103].id)?.settledAt,
      null,
    );
  } finally {
    await f.cleanup();
  }
});

test("operator-confirmed stopped owner is generation scoped, audited, bounded and never rewrites business or jobs", async () => {
  const f = await fixture();
  try {
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    await f.manual([f.accounts[0].id]);
    const job = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(job);
    const initial = await f.service.platforms.maintenanceStatus("x");
    await f.service.platforms.pauseMaintenance("x", f.actor.id, {
      expectedEpoch: initial.maintenanceEpoch,
      expectedGeneration: initial.credentialGeneration!,
    });
    const generation = initial.credentialGeneration!;
    await assert.rejects(
      f.service.platforms.confirmStoppedOwner(
        "x",
        f.jobs.ownerId,
        generation,
        false,
      ),
      /stopped/,
    );
    await assert.rejects(
      f.service.platforms.confirmStoppedOwner(
        "x",
        f.jobs.ownerId,
        generation,
        true,
      ),
      /lease/,
    );
    // The fixture never started a handler/child. Expiring its lease models the
    // database refusal boundary, not evidence that an actual process stopped.
    await f.db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseUntil: new Date(0) },
    });
    const unchanged = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    const extra = (ownerId: string, credentialGeneration: string) => ({
      platform: "x",
      kind: "scan",
      ownerId,
      credentialGeneration,
      jobId: randomUUID(),
      leaseId: randomUUID(),
      budgetAttempt: 1,
    });
    const otherOwner = await f.db.sourcePlatformExecution.create({
      data: extra(f.peerJobs.ownerId, generation),
    });
    const otherGeneration = await f.db.sourcePlatformExecution.create({
      data: extra(f.jobs.ownerId, "f".repeat(64)),
    });
    await assert.rejects(
      f.service.platforms.confirmStoppedOwner(
        "x",
        f.jobs.ownerId,
        "0".repeat(64),
        true,
      ),
      /changed/,
    );
    const confirmed = await f.service.platforms.confirmStoppedOwner(
      "x",
      f.jobs.ownerId,
      generation,
      true,
    );
    assert.equal(confirmed.settledCount, 1);
    assert.equal(confirmed.remainingUnsettled, 0);
    const fact = await f.db.sourcePlatformExecution.findUniqueOrThrow({
      where: { jobId_leaseId: { jobId: job.id, leaseId: job.leaseId! } },
    });
    assert.ok(fact.settledAt);
    assert.equal(fact.businessOutcome, null);
    assert.equal(fact.businessFinishedAt, null);
    assert.equal(
      (fact.diagnosticJson as Record<string, unknown>).settlementCode,
      "operator_confirmed_stopped",
    );
    for (const row of [otherOwner, otherGeneration])
      assert.equal(
        (
          await f.db.sourcePlatformExecution.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).settledAt,
        null,
      );
    assert.deepEqual(
      await f.db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }),
      unchanged,
    );
    assert.equal(
      (await f.service.platforms.maintenanceStatus("x")).maintenancePaused,
      true,
    );
    await f.db.sourcePlatformExecution.createMany({
      data: Array.from({ length: 101 }, () =>
        extra(f.jobs.ownerId, generation),
      ),
    });
    const batch = await f.service.platforms.confirmStoppedOwner(
      "x",
      f.jobs.ownerId,
      generation,
      true,
    );
    assert.equal(batch.settledCount, 100);
    assert.equal(batch.remainingUnsettled, 1);
  } finally {
    await f.cleanup();
  }
});

for (const platform of ["x", "pixiv"] as const)
  for (const profileFirst of [false, true])
    test(`${platform} profile and collection overlap in either start order (${profileFirst ? "profile first" : "collection first"})`, async () => {
      const f = await fixture();
      const entered = pause(),
        release = pause();
      let profile: Promise<string> | undefined;
      let collection: Promise<void> | undefined;
      const beginProfile = () => {
        profile = f.service.platforms.profileNetwork(
          f.actor.id,
          async () => {
            entered.release();
            await release.promise;
            return "resolved";
          },
          platform,
        );
        return Promise.race([entered.promise, profile]);
      };
      const beginCollection = async () => {
        const job = await f.jobs.claim(
          "network",
          new Date(),
          `source:${platform}`,
        );
        assert.ok(job, "live profile must not prevent a collection claim");
        collection = f.jobs.execute(job);
        await f.entered[platform].promise;
      };
      try {
        await f.manual(f.accounts.map((a) => a.id));
        f.setBlock();
        if (profileFirst) {
          await beginProfile();
          await beginCollection();
        } else {
          await beginCollection();
          await beginProfile();
        }
        assert.equal(
          await f.db.backgroundJob.count({
            where: {
              executionScope: `source:${platform}`,
              status: "running",
              leaseUntil: { gt: new Date() },
            },
          }),
          2,
        );
        await assert.rejects(
          f.peer.platforms.profileNetwork(
            f.actor.id,
            async () => {
              assert.fail("second profile must not contact the platform");
            },
            platform,
          ),
          /资料同步正在运行/,
        );
        assert.equal(
          await f.peerJobs.claim("network", new Date(), `source:${platform}`),
          null,
        );
        await assert.rejects(
          f.peer.platforms.recheck(platform, f.actor.id),
          /still running/,
        );
        await assert.rejects(
          f.peer.platforms.activate(platform, "old-generation"),
          /Drain/,
        );
        release.release();
        assert.equal(await profile, "resolved");
        f.release[platform].release();
        await collection;
      } finally {
        release.release();
        f.release[platform].release();
        await Promise.allSettled([profile, collection]);
        await f.cleanup();
      }
    });

test("concurrent platform outcomes preserve authentication pauses and longest rate deadlines", async () => {
  const f = await fixture();
  try {
    await f.service.platforms.profileNetwork(f.actor.id, async () => "ready");
    const state = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    const auth = new SourceResponseError("authentication", {
      scope: "credential",
      reason: "auth_failed",
    });
    const rate = (seconds: number) =>
      new SourceResponseError("rate_limited", {
        scope: "credential",
        reason: "rate_limited",
        diagnostic: {
          http_response_headers: { "retry-after": String(seconds) },
        },
      });
    for (const [first, second, status, minDelay] of [
      [auth, undefined, "auth_paused", 0],
      [undefined, auth, "auth_paused", 0],
      [rate(120), undefined, "cooling_down", 110_000],
      [undefined, rate(120), "cooling_down", 110_000],
      [rate(120), rate(5), "cooling_down", 110_000],
      [rate(5), rate(120), "cooling_down", 110_000],
      [auth, rate(120), "auth_paused", 110_000],
      [rate(120), auth, "auth_paused", 110_000],
    ] as const) {
      await f.db.sourcePlatformState.update({
        where: { platform: "x" },
        data: { status: "healthy", errorCode: null, cooldownUntil: null },
      });
      const locked = pause(),
        release = pause();
      const before = Date.now();
      const leading = f.db.$transaction(async (tx) => {
        await f.service.platforms.outcome(
          tx,
          "x",
          state.credentialGeneration,
          first,
        );
        locked.release();
        await release.promise;
      });
      await locked.promise;
      const trailingStarted = pause();
      let trailingPid = 0;
      const trailing = f.db.$transaction(async (tx) => {
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        trailingPid = backend.pid;
        trailingStarted.release();
        await f.peer.platforms.outcome(
          tx,
          "x",
          state.credentialGeneration,
          second,
        );
      });
      await trailingStarted.promise;
      let blockedBeforeRead = false;
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          const [activity] = await f.db.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE pid = ${trailingPid} AND wait_event_type = 'Lock'
              AND query LIKE 'SELECT platform FROM source_platform_states%FOR UPDATE%') AS blocked`;
          if (activity.blocked) {
            blockedBeforeRead = true;
            break;
          }
          await delay(10);
        }
      } finally {
        release.release();
      }
      await Promise.all([leading, trailing]);
      assert.ok(
        blockedBeforeRead,
        "the trailing outcome must wait on the platform row before reading state",
      );
      const result = await f.db.sourcePlatformState.findUniqueOrThrow({
        where: { platform: "x" },
      });
      assert.equal(result.status, status);
      if (minDelay)
        assert.ok(
          result.cooldownUntil &&
            result.cooldownUntil.getTime() >= before + minDelay,
        );
      if (status === "auth_paused")
        assert.equal(result.errorCode, "auth_failed");
    }
  } finally {
    await f.cleanup();
  }
});

test("D6 actual two workers: cross-platform parallel, same-platform exclusion, durable aggregate and waiting summary", async () => {
  const f = await fixture();
  try {
    const run = await f.manual();
    assert.equal((await f.manual()).id, run.id);
    await assert.rejects(f.manual([f.accounts[0].id]), /重叠/);
    f.setBlock();
    const cpuStart = process.cpuUsage();
    const before = process.memoryUsage().rss,
      start = performance.now();
    const x = await f.jobs.claim("network", new Date(), "source:x");
    const p = await f.peerJobs.claim("network", new Date(), "source:pixiv");
    assert.ok(x && p);
    assert.equal(x.resourceId !== p.resourceId, true);
    const executingX = f.jobs.execute(x),
      executingP = f.peerJobs.execute(p);
    await Promise.all([f.entered.x.promise, f.entered.pixiv.promise]);
    assert.equal(
      await f.peerJobs.claim("network", new Date(), "source:x"),
      null,
    );
    f.release.x.release();
    await executingX;
    assert.equal(
      (await f.db.sourceFetchRun.findUniqueOrThrow({ where: { id: run.id } }))
        .completedAt,
      null,
    );
    const progress = await f.service.progress();
    assert.equal(progress.active?.targetCount, 2);
    assert.equal(progress.active?.completedTargets, 1);
    f.release.pixiv.release();
    await executingP;
    assert.equal((await f.service.get(run.id)).status, "succeeded");
    console.info(
      JSON.stringify({
        scope: "d6_synthetic_measurement",
        elapsedMs: Math.round(performance.now() - start),
        rssDeltaBytes: process.memoryUsage().rss - before,
        cpuMicros: process.cpuUsage(cpuStart),
        maxNetworkConcurrency: 2,
        realNetworkRequests: 0,
        targets: 2,
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("D6 trusted 429 defers without spending attempt, isolates platform, never shortens cooldown; protected author does not pause", async () => {
  const f = await fixture();
  try {
    const run = await f.manual();
    f.fail.x = new SourceResponseError("rate_limited", {
      scope: "credential",
      reason: "rate_limited",
      diagnostic: { http_response_headers: { "retry-after": "120" } },
    });
    const x = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(x);
    await f.jobs.execute(x);
    const waiting = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: x.id },
    });
    assert.equal(waiting.status, "queued");
    assert.equal(waiting.attempts, 0);
    assert.ok(waiting.availableAt > new Date(Date.now() + 100000));
    assert.equal(
      (await f.service.progress()).active?.waitingReason,
      "platform_cooldown",
    );
    assert.equal(await f.jobs.claim("network", new Date(), "source:x"), null);
    const p = await f.peerJobs.claim("network", new Date(), "source:pixiv");
    assert.ok(p);
    await f.peerJobs.execute(p);
    const state = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    await f.db.$transaction(async (tx) => {
      await f.service.platforms.lock(tx, "x");
      await f.service.platforms.outcome(
        tx,
        "x",
        state.credentialGeneration,
        new SourceResponseError("rate_limited", {
          scope: "credential",
          reason: "rate_limited",
          diagnostic: { http_response_headers: { "retry-after": "5" } },
        }),
      );
    });
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).cooldownUntil?.getTime(),
      state.cooldownUntil?.getTime(),
    );
    assert.equal((await f.service.get(run.id)).completedAt, null);
    await writeFile(join(f.dir, "x.cookies"), "synthetic-replacement");
    await f.service.platforms.activate("x", state.credentialGeneration);
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).cooldownUntil?.getTime(),
      state.cooldownUntil?.getTime(),
    );
    assert.equal(
      await f.jobs.claim("network", new Date(), "source:x"),
      null,
      "credential activation cannot shorten trusted cooldown",
    );
    // Expire only this synthetic clock boundary before testing a source-scoped
    // failure. Production activation itself must preserve the trusted deadline.
    await f.db.sourcePlatformState.update({
      where: { platform: "x" },
      data: { cooldownUntil: new Date(0) },
    });
    await f.db.backgroundJob.update({
      where: { id: x.id },
      data: { availableAt: new Date(0) },
    });
    f.fail.x = new SourceResponseError("authentication", {
      scope: "source",
      reason: "source_forbidden",
    });
    const denied = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(denied);
    await f.jobs.execute(denied);
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).status,
      "unverified",
    );
  } finally {
    await f.cleanup();
  }
});

test("D6 fingerprint bootstrap competition, ordinary worker validation, live CAS refusal and stale generation immunity", async () => {
  const f = await fixture();
  try {
    await f.manual([f.accounts[0].id]);
    const first = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(first);
    const old = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    await writeFile(join(f.dir, "x.cookies"), "synthetic-two");
    await assert.rejects(
      f.service.platforms.beforeNetwork("x", old.credentialGeneration),
    );
    await assert.rejects(
      f.service.platforms.activate("x", old.credentialGeneration),
      /Drain/,
    );
    // A claimed handler noticing a changed file refunds and releases its slot.
    await f.jobs.execute(first);
    assert.equal(
      (await f.db.backgroundJob.findUniqueOrThrow({ where: { id: first.id } }))
        .attempts,
      0,
    );
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).credentialGeneration,
      old.credentialGeneration,
    );
    await assert.rejects(
      f.service.platforms.activate("x", "0".repeat(64)),
      /generation/,
    );
    await f.service.platforms.activate("x", old.credentialGeneration);
    const next = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    assert.notEqual(next.credentialGeneration, old.credentialGeneration);
    assert.equal(next.status, "unverified");
    await f.db.$transaction(async (tx) => {
      await f.service.platforms.lock(tx, "x");
      await f.service.platforms.outcome(
        tx,
        "x",
        old.credentialGeneration,
        new SourceResponseError("authentication", {
          scope: "credential",
          reason: "auth_failed",
        }),
      );
    });
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).status,
      "unverified",
    );
    const job = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(job);
    await f.jobs.execute(job);
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).status,
      "healthy",
    );
  } finally {
    await f.cleanup();
  }
});

test("D6 legacy global lease barrier, revoked actor and exhausted child settle only owned target", async () => {
  const f = await fixture();
  try {
    const run = await f.manual();
    const legacy = await f.jobs.enqueue({
      kind: "source_fetch",
      resourceId: randomUUID(),
      actorId: f.actor.id,
      idempotencyKey: `legacy:${randomUUID()}`,
      lane: "network",
    });
    await f.db.backgroundJob.update({
      where: { id: legacy.id },
      data: {
        status: "running",
        leaseId: randomUUID(),
        leaseUntil: new Date(Date.now() + 60000),
      },
    });
    assert.equal(await f.jobs.claim("network", new Date(), "source:x"), null);
    assert.equal(
      await f.db.sourcePlatformState.count({ where: { platform: "x" } }),
      0,
    );
    await f.db.backgroundJob.update({
      where: { id: legacy.id },
      data: { status: "failed", leaseId: null, leaseUntil: null },
    });
    await f.db.backgroundJob.updateMany({
      where: { kind: "source_account_fetch", actorId: f.actor.id },
      data: { availableAt: new Date() },
    });
    await f.db.user.update({
      where: { id: f.actor.id },
      data: { isActive: false },
    });
    const x = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(x);
    await f.jobs.execute(x);
    assert.equal(f.calls.x, 0);
    assert.equal((await f.service.get(run.id)).completedAt, null);
    const remaining = await f.db.sourceFetchAccountTask.findFirstOrThrow({
      where: { runId: run.id, platform: "pixiv" },
    });
    await f.db.backgroundJob.update({
      where: { id: remaining.jobId! },
      data: { status: "queued", attempts: 3 },
    });
    await f.service.reconcileExhausted();
    assert.equal((await f.service.get(run.id)).status, "failed");
  } finally {
    await f.cleanup();
  }
});

test("D6 competing bootstrap configurations never overwrite generation or delay a healthy peer", async () => {
  const f = await fixture();
  try {
    const alternative = join(f.dir, "alternative.json");
    await writeFile(alternative, '{"synthetic":"other-config"}');
    const { credentialFingerprint } =
      await import("../../src/source-ingestion/source-platform-state.js");
    f.peer.platforms.fingerprint = (platform) =>
      credentialFingerprint(platform, {
        ...f.environment.galleryDl!,
        xConfigPath: alternative,
      });
    await f.manual([f.accounts[0].id, f.accounts[2].id]);
    const [a, b] = await Promise.all([
      f.jobs.claim("network", new Date(), "source:x"),
      f.peerJobs.claim("network", new Date(), "source:x"),
    ]);
    assert.equal(Number(Boolean(a)) + Number(Boolean(b)), 1);
    const good = a ? f.jobs : f.peerJobs,
      bad = a ? f.peerJobs : f.jobs;
    await good.execute((a ?? b)!);
    const pending = await f.db.sourceFetchAccountTask.findFirstOrThrow({
      where: {
        accountId: { in: [f.accounts[0].id, f.accounts[2].id] },
        completedAt: null,
      },
    });
    const before = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: pending.jobId! },
    });
    const state = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    await assert.rejects(
      bad.claim("network", new Date(), "source:x"),
      /configuration/,
    );
    const after = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: pending.jobId! },
    });
    assert.equal(after.availableAt.getTime(), before.availableAt.getTime());
    assert.equal(after.attempts, 0);
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: "x" },
        })
      ).credentialGeneration,
      state.credentialGeneration,
    );
    const next = await good.claim("network", new Date(), "source:x");
    assert.ok(next);
    await good.execute(next);
  } finally {
    await f.cleanup();
  }
});

test("D6 next scheduled interval can rescan completed Pixiv while X remains auth-paused", async () => {
  const f = await fixture();
  const previous = await f.db.workerSchedule.findUnique({
    where: { name: "sources" },
  });
  try {
    const original = await f.manual();
    f.fail.x = new SourceResponseError("authentication", {
      scope: "credential",
      reason: "auth_failed",
    });
    const x = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(x);
    await f.jobs.execute(x);
    const p = await f.jobs.claim("network", new Date(), "source:pixiv");
    assert.ok(p);
    await f.jobs.execute(p);
    const xState = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    const xJob = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: x.id },
    });
    assert.equal((await f.manual()).id, original.id);
    f.environment.sourceScheduleEnabled = true;
    await f.db.workerSchedule.upsert({
      where: { name: "sources" },
      create: { name: "sources", dueAt: new Date(0) },
      update: { dueAt: new Date(0) },
    });
    assert.equal(
      await f.service.scheduleDue(new Date(Date.now() + 3600000)),
      true,
    );
    const next = await f.jobs.claim("network", new Date(), "source:pixiv");
    assert.ok(next);
    const nextTask = await f.db.sourceFetchAccountTask.findUniqueOrThrow({
      where: { id: next.resourceId },
    });
    assert.notEqual(nextTask.runId, original.id);
    // Ensure cleanup includes the scheduled batch.
    const scheduled = await f.db.sourceFetchRun.findUniqueOrThrow({
      where: { id: nextTask.runId },
    });
    await f.db.sourceFetchRun.update({
      where: { id: scheduled.id },
      data: { requestedById: f.actor.id },
    });
    await f.jobs.execute(next);
    assert.equal(f.calls.pixiv, 2);
    assert.deepEqual(
      await f.db.sourcePlatformState.findUniqueOrThrow({
        where: { platform: "x" },
      }),
      xState,
    );
    assert.deepEqual(
      await f.db.backgroundJob.findUniqueOrThrow({ where: { id: x.id } }),
      xJob,
    );
  } finally {
    if (previous)
      await f.db.workerSchedule.update({
        where: { name: "sources" },
        data: { dueAt: previous.dueAt },
      });
    else await f.db.workerSchedule.deleteMany({ where: { name: "sources" } });
    await f.cleanup();
  }
});

test("D6 technical recheck rereads current permission under user lock and rolls back wakeups", async () => {
  const f = await fixture();
  try {
    await f.manual([f.accounts[0].id]);
    f.fail.x = new SourceResponseError("authentication", {
      scope: "credential",
      reason: "auth_failed",
    });
    const job = await f.jobs.claim("network", new Date(), "source:x");
    assert.ok(job);
    await f.jobs.execute(job);
    const state = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    const waiting = await f.db.backgroundJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    await assert.rejects(
      f.service.platforms.recheck("x", f.actor.id),
      /actor unavailable/,
    );
    assert.deepEqual(
      await f.db.sourcePlatformState.findUniqueOrThrow({
        where: { platform: "x" },
      }),
      state,
    );
    assert.deepEqual(
      await f.db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }),
      waiting,
    );
    await f.db.userRole.create({ data: { userId: f.actor.id, role: "admin" } });
    assert.equal(
      (await f.service.platforms.recheck("x", f.actor.id)).status,
      "unverified",
    );
    await f.db.userRole.deleteMany({
      where: { userId: f.actor.id, role: "admin" },
    });
    const current = await f.db.sourcePlatformState.findUniqueOrThrow({
      where: { platform: "x" },
    });
    await assert.rejects(
      f.service.platforms.recheck("x", f.actor.id),
      /actor unavailable/,
    );
    assert.deepEqual(
      await f.db.sourcePlatformState.findUniqueOrThrow({
        where: { platform: "x" },
      }),
      current,
    );
  } finally {
    await f.cleanup();
  }
});

test(
  "D6 manual exhausted-sibling settlement cannot deadlock with live sibling completion",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    const heldB = pause(),
      manualRequestsB = pause();
    const originalDb = (f.service as any).db;
    try {
      const run = await f.manual();
      const taskA = await f.db.sourceFetchAccountTask.findUniqueOrThrow({
        where: {
          runId_accountId: { runId: run.id, accountId: f.accounts[0].id },
        },
      });
      await f.db.backgroundJob.update({
        where: { id: taskA.jobId! },
        data: { attempts: 3 },
      });
      const b = await f.jobs.claim("network", new Date(), "source:pixiv");
      assert.ok(b);
      const { SourceAccountTasks } =
        await import("../../src/source-ingestion/source-account-tasks.js");
      const accountTasks = new SourceAccountTasks(f.db, f.jobs);
      const completing = f.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM background_jobs WHERE id=${b.id}::uuid FOR UPDATE`;
          await f.service.platforms.actor(tx, f.actor.id);
          await tx.sourceFetchAccountTask.update({
            where: { id: b.resourceId },
            data: { status: "succeeded", completedAt: new Date() },
          });
          heldB.release();
          await manualRequestsB.promise;
          await accountTasks.aggregate(tx, run.id);
          await tx.backgroundJob.update({
            where: { id: b.id },
            data: {
              status: "succeeded",
              leaseId: null,
              leaseUntil: null,
              completedAt: new Date(),
            },
          });
        },
        { timeout: 10000 },
      );
      await heldB.promise;
      (f.service as any).db = new Proxy(f.db, {
        get(target, key) {
          if (key === "$transaction")
            return (callback: any) =>
              target.$transaction(
                (tx) =>
                  callback(
                    new Proxy(tx, {
                      get(client, method) {
                        if (method === "$queryRaw")
                          return (...args: any[]) => {
                            const query = args[0];
                            const sql = query.sql ?? Array.from(query).join("");
                            const values = rawQueryValues(
                              query,
                              ...args.slice(1),
                            );
                            if (
                              sql.includes("background_jobs") &&
                              sql.includes("FOR UPDATE") &&
                              values.flat(Infinity).includes(b.id)
                            )
                              manualRequestsB.release();
                            return (client.$queryRaw as any)(...args);
                          };
                        const value = (client as any)[method];
                        return typeof value === "function"
                          ? value.bind(client)
                          : value;
                      },
                    }),
                  ),
                { timeout: 10000 },
              );
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const [fresh] = await Promise.all([f.manual(), completing]);
      // B completed while the request waited for its row; after A settles the old
      // batch is terminal, so a new queued batch is the correct linearized result.
      assert.notEqual(fresh.id, run.id);
      assert.equal(
        (await f.db.sourceFetchRun.findUniqueOrThrow({ where: { id: run.id } }))
          .status,
        "partial_failed",
      );
      const completed = await f.db.backgroundJob.findUniqueOrThrow({
        where: { id: b.id },
      });
      assert.equal(completed.attempts, 1);
      assert.equal(completed.status, "succeeded");
      const freshB = await f.db.sourceFetchAccountTask.findUniqueOrThrow({
        where: {
          runId_accountId: { runId: fresh.id, accountId: f.accounts[1].id },
        },
      });
      assert.equal(
        (
          await f.db.backgroundJob.findUniqueOrThrow({
            where: { id: freshB.jobId! },
          })
        ).attempts,
        0,
      );
    } finally {
      manualRequestsB.release();
      heldB.release();
      (f.service as any).db = originalDb;
      await f.cleanup();
    }
  },
);
