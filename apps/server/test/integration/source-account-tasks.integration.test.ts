import { rawQueryValues } from "../raw-query-values.js";
/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
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
