/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuthorsService } from "../../src/authors/authors.service.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { UsersService } from "../../src/users/users.service.js";
import { hashPassword } from "../../src/users/password.js";
import type {
  ContentSourceClient,
  NormalizedSourceContent,
} from "../../src/source-ingestion/content-source.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL required");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(platform?: string) {
  const prefix = `safety_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const environment = parseEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: url,
    SOURCE_SCHEDULE_ENABLED: "true",
  });
  const db = new PrismaService(environment);
  await db.onModuleInit();
  const jobs = new JobsService(db);
  const contents = [1, 2].map((i): NormalizedSourceContent => ({
    externalContentId: `${prefix}_${i}`,
    type: "post",
    text: "synthetic #fixture",
    permalink: `https://fixture.invalid/${prefix}/${i}`,
    publishedAt: "2026-10-01T00:00:00Z",
    ownMedia: [0, 1].map((n) => ({
      externalMediaId: `${i}_${n}`,
      url: `https://fixture.invalid/${i}/${n}.png`,
      type: "photo",
    })),
    rawJson: { synthetic: true },
  }));
  const client: ContentSourceClient = {
    platform: platform ?? prefix,
    adapterKey: prefix,
    priority: 1,
    available: true,
    metered: false,
    supportedFirstSyncModes: ["none"],
    allowedMediaHosts: ["fixture.invalid"],
    initialCursor: () => ({}),
    checkAccount: async (account) => account,
    fetchPage: async () => ({
      items: contents,
      nextCursor: { done: true },
      complete: true,
    }),
  };
  const registry = new ContentSourceRegistry().register(client);
  const fileIds: string[] = [];
  const runIds = new Set<string>();
  let downloads = 0;
  let afterDownload = async () => {};
  let afterStore = async () => {};
  const body = Buffer.from("synthetic source safety fixture");
  const downloader = {
    download: async () => {
      downloads++;
      await afterDownload();
      return {
        body,
        contentType: "image/png",
        checksum: createHash("sha256").update(body).digest("hex"),
      };
    },
  };
  const files = {
    store: async () => {
      const file = await db.fileObject.create({
        data: {
          objectKey: `${prefix}/${randomUUID()}`,
          bucketScope: "source",
          kind: "candidate-media",
          contentType: "image/png",
          size: BigInt(body.length),
          checksum: createHash("sha256").update(body).digest("hex"),
        },
      });
      fileIds.push(file.id);
      await afterStore();
      return file;
    },
    purgeUnreferenced: async (id: string) => {
      assert.equal(
        await db.candidateMedia.count({ where: { fileObjectId: id } }),
        0,
      );
      if (
        !(await db.sourceDiscoveryMedia.count({ where: { fileObjectId: id } }))
      )
        await db.fileObject.delete({ where: { id } });
    },
  };
  const service = new SourceFetchService(
    jobs,
    db,
    registry,
    downloader,
    files as any,
    environment,
  );
  // Synthetic credential provider: actual platform materials are tested in D6's dedicated suite.
  const generation = createHash("sha256").update(prefix).digest("hex");
  service.platforms.fingerprint = async () => generation;
  await db.sourcePlatformState.upsert({
    where: { platform: client.platform },
    create: { platform: client.platform, credentialGeneration: generation },
    update: {
      credentialGeneration: generation,
      status: "unverified",
      cooldownUntil: null,
      errorCode: null,
    },
  });
  service.onModuleInit();
  const authors = new AuthorsService(
    db,
    registry,
    files as any,
    downloader,
    service,
  );
  const actor = await db.user.create({
    data: {
      username: `${prefix}_actor`,
      displayName: prefix,
      passwordHash: "synthetic-disabled-password",
      mustChangePassword: false,
      roles: { create: { role: "source" } },
    },
  });
  const peer = await db.user.create({
    data: {
      username: `${prefix}_peer`,
      displayName: prefix,
      passwordHash: "synthetic-disabled-password",
      mustChangePassword: false,
      roles: { create: { role: "source" } },
    },
  });
  const author = await db.author.create({
    data: { displayName: prefix, authorizationStatus: "authorized" },
  });
  const account = await db.authorExternalAccount.create({
    data: {
      authorId: author.id,
      platform: platform ?? prefix,
      externalUserId: "1",
      fetchEnabled: true,
      firstSyncMode: "none",
      scanState: { create: {} },
      adapterStates: { create: { adapterKey: prefix } },
    },
  });
  async function snapshot() {
    return db.authorExternalAccount.findUniqueOrThrow({
      where: { id: account.id },
      include: { author: true, adapterStates: true },
    });
  }
  async function manual(ids = [account.id], actorId = actor.id) {
    const run = await service.runManual(actorId, { accountIds: ids });
    runIds.add(run.id);
    return run;
  }
  async function jobId(runId: string) {
    return (
      await db.sourceFetchAccountTask.findUniqueOrThrow({
        where: { runId_accountId: { runId, accountId: account.id } },
      })
    ).jobId!;
  }
  async function execute(runId: string) {
    await db.backgroundJob.update({
      where: { id: await jobId(runId) },
      data: { availableAt: new Date() },
    });
    const job = await jobs.claim(
      "network",
      new Date(),
      `source:${client.platform}`,
    );
    assert.ok(job, "Expected account task claim");
    await jobs.execute(job);
  }
  async function prepareSave() {
    const run = await manual();
    await db.sourceAdapterState.update({
      where: {
        externalAccountId_adapterKey: {
          externalAccountId: account.id,
          adapterKey: client.adapterKey,
        },
      },
      data: {
        fetchLeaseId: run.id,
        fetchLeaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const job = await db.backgroundJob.findUniqueOrThrow({
      where: { id: await jobId(run.id) },
    });
    const scan = await db.sourceAccountScanState.update({
      where: { accountId: account.id },
      data: {
        leaseOwnerJobId: job.id,
        leaseUntil: new Date(Date.now() + 60_000),
        epoch: { increment: 1 },
      },
    });
    const current = await snapshot();
    Object.assign(current.adapterStates[0], {
      scanEpoch: scan.epoch,
      scanOwnerJobId: job.id,
    });
    const save = async (item = contents[0]) => {
      await db.$transaction((tx) =>
        service.discovery.record(
          tx,
          {
            accountId: account.id,
            platform: client.platform,
            sourceUserId: account.externalUserId,
            adapterKey: client.adapterKey,
            actorId: actor.id,
            discoveredRunId: run.id,
            windowJson: {},
          },
          item,
        ),
      );
      return (service as any).saveCandidate(
        current,
        current.adapterStates[0],
        client,
        item,
        actor.id,
        run.id,
        new AbortController().signal,
      );
    };
    return { run, current, save };
  }
  async function close() {
    const ownedRuns = await db.sourceFetchRun.findMany({
      where: { requestedById: { in: [actor.id, peer.id] } },
      select: { id: true },
    });
    for (const run of ownedRuns) runIds.add(run.id);
    const ids = [...runIds];
    await db.backgroundJob.deleteMany({
      where: {
        kind: { in: ["source_fetch", "source_account_fetch"] },
        actorId: { in: [actor.id, peer.id] },
      },
    });
    await db.sourceFetchRunItem.deleteMany({ where: { runId: { in: ids } } });
    await db.sourceFetchRun.deleteMany({ where: { id: { in: ids } } });
    await db.candidateMedia.deleteMany({
      where: { candidatePost: { authorId: author.id } },
    });
    await db.candidatePost.deleteMany({ where: { authorId: author.id } });
    await db.sourceRecoveryCampaign.deleteMany({
      where: { discoveryPost: { account: { authorId: author.id } } },
    });
    await db.sourceDiscoveryMedia.deleteMany({
      where: { discoveryPost: { account: { authorId: author.id } } },
    });
    await db.sourceDiscoveryPost.deleteMany({
      where: { account: { authorId: author.id } },
    });
    await db.authorExternalAccount.deleteMany({
      where: { authorId: author.id },
    });
    await db.authorTag.deleteMany({ where: { authorId: author.id } });
    await db.author.delete({ where: { id: author.id } });
    await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
    await db.accountAudit.deleteMany({
      where: {
        OR: [
          { actorId: { in: [actor.id, peer.id] } },
          { targetId: { in: [actor.id, peer.id] } },
        ],
      },
    });
    await db.authSession.deleteMany({
      where: { userId: { in: [actor.id, peer.id] } },
    });
    await db.userRole.deleteMany({
      where: { userId: { in: [actor.id, peer.id] } },
    });
    await db.user.deleteMany({ where: { id: { in: [actor.id, peer.id] } } });
    await db.sourcePlatformState.deleteMany({
      where: { platform: client.platform, credentialGeneration: generation },
    });
    await db.onModuleDestroy();
  }
  return {
    db,
    jobs,
    service,
    authors,
    actor,
    peer,
    author,
    account,
    client,
    registry,
    contents,
    runIds,
    fileIds,
    manual,
    execute,
    jobId,
    snapshot,
    prepareSave,
    close,
    set afterDownload(fn: () => Promise<void>) {
      afterDownload = fn;
    },
    set afterStore(fn: () => Promise<void>) {
      afterStore = fn;
    },
    get downloads() {
      return downloads;
    },
  };
}

test("PostgreSQL successful empty scans persist coverage and keep discovery cache out of account and history projections", async () => {
  const f = await fixture();
  try {
    const state = (await f.snapshot()).adapterStates[0];
    const previousCoverage = new Date(Date.now() - 3_600_000);
    await f.db.sourceAccountScanState.update({
      where: { accountId: f.account.id },
      data: { discoveredThroughAt: previousCoverage },
    });
    const oldPublication = new Date("2020-01-01T00:00:00.000Z");
    const cache = {
      ids: Array.from({ length: 100_000 }, (_, i) => String(i + 1)),
    };
    await f.db.sourceAdapterState.update({
      where: { id: state.id },
      data: {
        completedThroughAt: previousCoverage,
        highWaterPublishedAt: oldPublication,
        discoveryCheckpointJson: cache,
      },
    });
    let fixedUpper = "";
    f.client.fetchPage = async (_account, cursor, context) => {
      assert.deepEqual(context?.checkpoint, cache);
      assert.equal(
        cursor.startTime,
        new Date(previousCoverage.getTime() - 10 * 60_000).toISOString(),
      );
      fixedUpper = cursor.endTime as string;
      return {
        items: [],
        complete: true,
        nextCursor: {},
        checkpoint: { ids: ["new"] },
      };
    };
    const run = await f.manual();
    await f.execute(run.id);
    const stored = await f.db.sourceAdapterState.findUniqueOrThrow({
      where: { id: state.id },
    });
    assert.equal(stored.completedThroughAt?.toISOString(), fixedUpper);
    assert.equal(
      stored.highWaterPublishedAt?.toISOString(),
      oldPublication.toISOString(),
    );
    assert.deepEqual(stored.discoveryCheckpointJson, { ids: ["new"] });
    assert.deepEqual(stored.cursorJson, {});
    const accounts = await (f.service as any).accounts([f.account.id]);
    assert.equal(
      Object.hasOwn(accounts[0].adapterStates[0], "discoveryCheckpointJson"),
      false,
    );
    assert.equal((await f.service.get(run.id)).status, "succeeded");
    assert.equal(
      JSON.stringify(await f.authors.listAccounts(f.author.id)).includes(
        "discoveryCheckpointJson",
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("PostgreSQL failed scans preserve coverage and discovery cache while retaining fixed resume bounds", async () => {
  const f = await fixture();
  try {
    const state = (await f.snapshot()).adapterStates[0];
    const previousCoverage = new Date(Date.now() - 3_600_000);
    await f.db.sourceAccountScanState.update({
      where: { accountId: f.account.id },
      data: { discoveredThroughAt: previousCoverage },
    });
    await f.db.sourceAdapterState.update({
      where: { id: state.id },
      data: {
        completedThroughAt: previousCoverage,
        discoveryCheckpointJson: { ids: ["old"] },
      },
    });
    let page = 0;
    let fixedUpper = "";
    f.client.fetchPage = async (_account, cursor) => {
      fixedUpper ||= cursor.endTime as string;
      assert.equal(cursor.endTime, fixedUpper);
      if (++page === 2) throw new Error("synthetic checkpoint interruption");
      return {
        items: [],
        complete: false,
        boundaryReached: false,
        nextCursor: { page },
        checkpoint: { ids: ["partial"] },
      };
    };
    const failed = await f.manual();
    await f.execute(failed.id);
    const interrupted = await f.db.sourceAdapterState.findUniqueOrThrow({
      where: { id: state.id },
    });
    assert.equal(
      interrupted.completedThroughAt?.toISOString(),
      previousCoverage.toISOString(),
    );
    assert.deepEqual(interrupted.discoveryCheckpointJson, { ids: ["old"] });
    assert.equal((interrupted.cursorJson as any).endTime, fixedUpper);
    f.client.fetchPage = async (_account, cursor, context) => {
      assert.equal(cursor.endTime, fixedUpper);
      assert.deepEqual(context?.checkpoint, { ids: ["old"] });
      return {
        items: [],
        complete: true,
        nextCursor: {},
        checkpoint: { ids: ["complete"] },
      };
    };
    const resumed = await f.manual();
    await f.execute(resumed.id);
    const completed = await f.db.sourceAdapterState.findUniqueOrThrow({
      where: { id: state.id },
    });
    assert.equal(completed.completedThroughAt?.toISOString(), fixedUpper);
    assert.deepEqual(completed.discoveryCheckpointJson, { ids: ["complete"] });
  } finally {
    await f.close();
  }
});

test("PostgreSQL coverage migration backfills only a matching successful scan start", async () => {
  const f = await fixture();
  try {
    const migration = await readFile(
      new URL(
        "../../prisma/migrations/20261027000400_source_scan_windows/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await f.db.$transaction(async (tx) => {
      // Temporary relations shadow only this transaction's names; real fixture
      // tables and the migration history remain untouched.
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE source_adapter_states (
        id text PRIMARY KEY, external_account_id text, adapter_key text,
        last_success_at timestamptz(3), high_water_published_at timestamptz(3)
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE source_fetch_run_items (
        adapter_state_id text, external_account_id text, adapter_key text,
        status text, started_at timestamptz(3)
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO source_adapter_states VALUES
        ('a', 'account-a', 'adapter', '2026-10-26T08:00:00Z', '2099-01-01T00:00:00Z'),
        ('b', 'account-b', 'adapter', NULL, '2099-01-01T00:00:00Z'),
        ('c', 'account-c', 'adapter', '2026-10-26T08:00:00Z', '2099-01-01T00:00:00Z')`);
      await tx.$executeRawUnsafe(`INSERT INTO source_fetch_run_items VALUES
        ('a', 'account-a', 'adapter', 'succeeded', '2026-10-26T06:00:00Z'),
        ('a', 'account-a', 'adapter', 'succeeded', '2026-10-26T07:00:00Z'),
        ('a', 'account-a', 'adapter', 'failed', '2026-10-26T07:30:00Z'),
        ('a', 'account-a', 'adapter', 'succeeded', '2026-10-26T09:00:00Z'),
        ('a', 'account-other', 'adapter', 'succeeded', '2026-10-26T07:45:00Z'),
        ('a', 'account-a', 'adapter-other', 'succeeded', '2026-10-26T07:45:00Z'),
        ('b', 'account-b', 'adapter', 'succeeded', '2026-10-26T07:00:00Z'),
        ('c', 'account-c', 'adapter', 'failed', '2026-10-26T07:00:00Z')`);
      for (const statement of migration.split(";").filter((sql) => sql.trim()))
        await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          completed_through_at: Date | null;
          discovery_checkpoint_json: unknown;
        }>
      >`SELECT id, completed_through_at, discovery_checkpoint_json FROM source_adapter_states ORDER BY id`;
      assert.deepEqual(
        rows.map((row) => [
          row.id,
          row.completed_through_at?.toISOString() ?? null,
          row.discovery_checkpoint_json,
        ]),
        [
          ["a", "2026-10-26T07:00:00.000Z", {}],
          ["b", null, {}],
          ["c", null, {}],
        ],
      );
    });
  } finally {
    await f.close();
  }
});

test("PostgreSQL concurrent manual requests reuse one batch across actors and reject overlapping subsets", async () => {
  const f = await fixture();
  try {
    const second = await f.db.authorExternalAccount.create({
      data: {
        authorId: f.author.id,
        platform: `${f.client.platform}_b`,
        externalUserId: "2",
        fetchEnabled: true,
      },
    });
    const [one, two] = await Promise.all([
      f.manual([f.account.id], f.actor.id),
      f.manual([f.account.id, f.account.id], f.peer.id),
    ]);
    assert.equal(one.id, two.id);
    await assert.rejects(
      f.manual([f.account.id, second.id]),
      (error: any) => error.getStatus?.() === 409,
    );
    const disjoint = await f.manual([second.id], f.peer.id);
    assert.notEqual(disjoint.id, one.id);
    assert.equal(
      await f.db.backgroundJob.count({
        where: {
          kind: "source_account_fetch",
          resourceId: {
            in: (
              await f.db.sourceFetchAccountTask.findMany({
                where: { runId: { in: [...f.runIds] } },
                select: { id: true },
              })
            ).map((task) => task.id),
          },
        },
      }),
      2,
    );
    await f.db.userRole.deleteMany({ where: { userId: f.peer.id } });
    await assert.rejects(
      f.manual([f.account.id], f.peer.id),
      (error: any) => error.getStatus?.() === 400,
    );
  } finally {
    await f.close();
  }
});

test("PostgreSQL empty selections reuse retry/expired recoverable batches; failed and exhausted jobs permit a fresh batch", async () => {
  const f = await fixture();
  try {
    const first = await f.manual([]);
    const duplicate = await f.service.runManual(f.peer.id, {});
    assert.equal(first.id, duplicate.id);
    await f.db.backgroundJob.update({
      where: { id: await f.jobId(first.id) },
      data: { attempts: 2, availableAt: new Date(Date.now() + 60_000) },
    });
    assert.equal((await f.manual([])).id, first.id);
    await f.db.backgroundJob.update({
      where: { id: await f.jobId(first.id) },
      data: {
        status: "running",
        leaseId: randomUUID(),
        leaseUntil: new Date(0),
      },
    });
    assert.equal((await f.manual([])).id, first.id);
    await f.db.backgroundJob.update({
      where: { id: await f.jobId(first.id) },
      data: { attempts: 3 },
    });
    const fresh = await f.manual([]);
    assert.notEqual(fresh.id, first.id);
    await f.db.backgroundJob.update({
      where: { id: await f.jobId(fresh.id) },
      data: { status: "failed" },
    });
    const afterFailure = await f.manual([]);
    assert.notEqual(afterFailure.id, fresh.id);
    assert.equal(
      await f.db.sourceFetchRunItem.count({
        where: { runId: { in: [...f.runIds] } },
      }),
      0,
    );
  } finally {
    await f.close();
  }
});

test("PostgreSQL manual and scheduled enqueue share one advisory transaction lock", async () => {
  const f = await fixture();
  const old = await f.db.workerSchedule.findUnique({
    where: { name: "sources" },
  });
  try {
    await f.db.workerSchedule.upsert({
      where: { name: "sources" },
      create: { name: "sources", dueAt: new Date(0) },
      update: { dueAt: new Date(0) },
    });
    const [manual] = await Promise.all([f.manual([]), f.service.scheduleDue()]);
    const tasks = await f.db.sourceFetchAccountTask.findMany({
      where: { accountId: f.account.id, completedAt: null },
    });
    tasks.forEach((task) => f.runIds.add(task.runId));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].runId, manual.id);
  } finally {
    if (old)
      await f.db.workerSchedule.update({
        where: { name: "sources" },
        data: { dueAt: old.dueAt },
      });
    else await f.db.workerSchedule.deleteMany({ where: { name: "sources" } });
    await f.close();
  }
});

for (const mutation of [
  "revoke_author",
  "archive_author",
  "disable_account",
  "reset_adapter",
  "replace_lease",
] as const)
  test(`PostgreSQL ${mutation} during original storage stops page writes and preserves new management state`, async () => {
    const f = await fixture();
    try {
      const run = await f.manual();
      f.afterStore = async () => {
        if (mutation === "revoke_author")
          await f.authors.update(f.author.id, {
            displayName: f.author.displayName,
            sourceLanguage: "ja",
            authorizationStatus: "revoked",
            tagNames: [],
            expectedRevision: 0,
          });
        if (mutation === "archive_author")
          await f.authors.archive(f.author.id, 0);
        if (mutation === "disable_account")
          await f.authors.updateAccount(f.author.id, f.account.id, {
            fetchEnabled: false,
            firstSyncMode: "none",
            expectedRevision: 0,
          });
        if (mutation === "reset_adapter") {
          await f.authors.updateAdapterState(
            f.author.id,
            f.account.id,
            f.client.adapterKey,
            { expectedRevision: 0, enabled: false },
          );
          await f.authors.updateAdapterState(
            f.author.id,
            f.account.id,
            f.client.adapterKey,
            { expectedRevision: 1, enabled: true },
          );
        }
        if (mutation === "replace_lease")
          await f.db.sourceAdapterState.update({
            where: {
              externalAccountId_adapterKey: {
                externalAccountId: f.account.id,
                adapterKey: f.client.adapterKey,
              },
            },
            data: {
              fetchLeaseId: randomUUID(),
              fetchLeaseUntil: new Date(Date.now() + 60_000),
            },
          });
      };
      await f.execute(run.id);
      assert.equal(f.downloads, 1);
      assert.equal(
        await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
        0,
      );
      assert.equal(
        await f.db.fileObject.count({ where: { id: { in: f.fileIds } } }),
        0,
      );
      const state = (await f.snapshot()).adapterStates[0];
      assert.equal(state.highWaterPublishedAt, null);
      assert.equal(state.consecutiveFailures, 0);
      assert.equal(state.health, "idle");
      if (mutation === "replace_lease")
        assert.notEqual(state.fetchLeaseId, run.id);
      else assert.equal(state.fetchLeaseId, null);
    } finally {
      await f.close();
    }
  });

test("PostgreSQL download-time revocation avoids object storage and existing-candidate observations remain protected", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepareSave();
    f.afterDownload = async () => {
      await f.authors.update(f.author.id, {
        displayName: f.author.displayName,
        sourceLanguage: "ja",
        authorizationStatus: "revoked",
        tagNames: [],
        expectedRevision: 0,
      });
    };
    await assert.rejects(prepared.save(), /Source account changed/);
    assert.equal(f.fileIds.length, 0);
    const candidate = await f.db.candidatePost.create({
      data: {
        authorId: f.author.id,
        authorExternalAccountId: f.account.id,
        platform: f.client.platform,
        externalPostId: f.contents[0].externalContentId,
        externalPostUrl: f.contents[0].permalink,
        postedAt: new Date(f.contents[0].publishedAt),
        rawJson: {},
      },
    });
    await assert.rejects(prepared.save(), /Source account changed/);
    assert.equal(
      await f.db.candidateSourceObservation.count({
        where: { candidatePostId: candidate.id },
      }),
      0,
    );
    assert.equal(
      await f.db.candidateHashtag.count({
        where: { candidatePostId: candidate.id },
      }),
      0,
    );
  } finally {
    await f.close();
  }
});

async function blockedBy(db: PrismaService, pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<
      { blocked: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
    if (row.blocked) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(
    "management update did not wait for the source transaction row lock",
  );
}

function beforeCandidateCreate(
  db: PrismaService,
  beforeCreate: (tx: any) => Promise<void>,
) {
  const original = db.$transaction.bind(db);
  (db as any).$transaction = (action: any, options: any) =>
    original(
      (tx: any) =>
        action(
          new Proxy(tx, {
            get(target, key) {
              if (key !== "candidatePost") return Reflect.get(target, key);
              return new Proxy(target.candidatePost, {
                get(delegate, method) {
                  if (method !== "create") return Reflect.get(delegate, method);
                  return async (data: any) => {
                    // Pause at the actual candidate write, after its authorization fences.
                    await beforeCreate(tx);
                    return delegate.create(data);
                  };
                },
              });
            },
          }),
        ),
      options,
    );
}

for (const mutation of ["author", "account", "adapter"] as const)
  test(`PostgreSQL candidate commit holds the ${mutation} row against a concurrent real management write`, async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    let saving: Promise<unknown> | undefined;
    let management: Promise<unknown> | undefined;
    try {
      const prepared = await f.prepareSave();
      let pid = 0;
      beforeCandidateCreate(f.db, async (tx) => {
        [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        entered.resolve();
        await release.promise;
      });
      const pendingSave: Promise<unknown> = prepared.save();
      saving = pendingSave;
      await Promise.race([
        entered.promise,
        pendingSave.then(() => {
          throw new Error(
            "Candidate persistence finished before the lock-test gate",
          );
        }),
      ]);
      if (mutation === "author")
        management = f.authors.update(f.author.id, {
          displayName: f.author.displayName,
          sourceLanguage: "ja",
          authorizationStatus: "revoked",
          tagNames: [],
          expectedRevision: 0,
        });
      if (mutation === "account")
        management = f.authors.updateAccount(f.author.id, f.account.id, {
          fetchEnabled: false,
          firstSyncMode: "none",
          expectedRevision: 0,
        });
      if (mutation === "adapter")
        management = f.authors.updateAdapterState(
          f.author.id,
          f.account.id,
          f.client.adapterKey,
          { enabled: false, expectedRevision: 0 },
        );
      await blockedBy(f.db, pid);
      release.resolve();
      await saving;
      await management;
      assert.equal(
        await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
        1,
      );
      await assert.rejects(
        prepared.save(f.contents[1]),
        /Source account changed/,
      );
      assert.equal(
        await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
        1,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([saving, management]);
      await f.close();
    }
  });

test("PostgreSQL interrupted recovery retains counters and clears current error fields", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepareSave();
    f.client.fetchPage = async () => ({
      items: [],
      complete: true,
      nextCursor: {},
    });
    const item = await f.db.sourceFetchRunItem.create({
      data: {
        runId: prepared.run.id,
        externalAccountId: f.account.id,
        adapterStateId: prepared.current.adapterStates[0].id,
        adapterKey: f.client.adapterKey,
        status: "running",
        cursorBefore: {},
        pagesFetched: 2,
      },
    });
    await f.execute(prepared.run.id);
    const recovered = await f.db.sourceFetchRunItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(recovered.status, "succeeded");
    assert.equal(recovered.pagesFetched, 3);
    assert.equal(recovered.errorCode, null);
    assert.equal(recovered.errorMessage, null);
    assert.equal(
      await f.db.sourceFetchRunItem.count({
        where: { runId: prepared.run.id },
      }),
      1,
    );
  } finally {
    await f.close();
  }
});

test("PostgreSQL long image transfers renew only the still-current source and job leases", async () => {
  const f = await fixture();
  const clock = test.mock.timers;
  const now = new Date();
  clock.enable({ apis: ["Date"], now });
  try {
    f.contents.splice(1);
    f.contents[0].ownMedia = Array.from({ length: 6 }, (_, n) => ({
      externalMediaId: `long_${n}`,
      url: `https://fixture.invalid/long/${n}.png`,
      type: "photo" as const,
    }));
    const run = await f.manual();
    f.afterStore = async () => {
      clock.tick(6 * 60_000);
      // Keep the outer execution current as its real heartbeat would. Source
      // lease renewal itself must retain all of its normal transaction fences.
      await f.db.backgroundJob.update({
        where: { id: await f.jobId(run.id) },
        data: { leaseUntil: new Date(Date.now() + 60_000) },
      });
    };
    await f.execute(run.id);
    const completed = await f.service.get(run.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.items[0].mediaStored, 6);
    const state = (await f.snapshot()).adapterStates[0];
    assert.equal(state.completedThroughAt?.toISOString(), now.toISOString());
    assert.equal(state.fetchLeaseId, null);
    assert.equal(state.fetchLeaseUntil, null);
  } finally {
    clock.reset();
    await f.close();
  }
});

async function actorAdministration(f: Awaited<ReturnType<typeof fixture>>) {
  const password = "synthetic-admin-password";
  await f.db.user.update({
    where: { id: f.peer.id },
    data: { passwordHash: await hashPassword(password) },
  });
  await f.db.userRole.create({ data: { userId: f.peer.id, role: "admin" } });
  const session = await f.db.authSession.create({
    data: {
      userId: f.peer.id,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const users = new UsersService(f.db, null as any);
  return () =>
    users.manage({ userId: f.peer.id, sessionId: session.id }, f.actor.id, {
      expectedRevision: 0,
      displayName: f.actor.displayName,
      isActive: true,
      roles: ["reviewer"],
      currentPassword: password,
    });
}

test("PostgreSQL normal role administration fences existing observations and successful source completion", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepareSave();
    const candidate = await f.db.candidatePost.create({
      data: {
        authorId: f.author.id,
        authorExternalAccountId: f.account.id,
        platform: f.client.platform,
        externalPostId: f.contents[0].externalContentId,
        externalPostUrl: f.contents[0].permalink,
        postedAt: new Date(f.contents[0].publishedAt),
        rawJson: {},
      },
    });
    const revoke = await actorAdministration(f);
    await revoke();
    await assert.rejects(prepared.save(), /权限已失效/);
    assert.equal(
      await f.db.candidateSourceObservation.count({
        where: { candidatePostId: candidate.id },
      }),
      0,
    );
    assert.equal(
      await f.db.candidateHashtag.count({
        where: { candidatePostId: candidate.id },
      }),
      0,
    );
    const state = (await f.snapshot()).adapterStates[0];
    assert.equal(state.highWaterPublishedAt, null);
    assert.deepEqual(state.cursorJson, {});
  } finally {
    await f.close();
  }
});

test("PostgreSQL source persistence blocks normal role replacement until its protected commit", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  let saving: Promise<unknown> | undefined;
  let management: Promise<unknown> | undefined;
  try {
    const prepared = await f.prepareSave();
    const revoke = await actorAdministration(f);
    let pid = 0;
    beforeCandidateCreate(f.db, async (tx) => {
      [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      entered.resolve();
      await release.promise;
    });
    saving = Promise.resolve(prepared.save());
    await Promise.race([
      entered.promise,
      saving.then(() => {
        throw new Error("save completed before protected transaction hook");
      }),
    ]);
    management = revoke();
    await blockedBy(f.db, pid);
    release.resolve();
    await saving;
    await management;
    assert.equal(
      await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
      1,
    );
    await assert.rejects(prepared.save(f.contents[1]), /权限已失效/);
    assert.equal(
      await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
      1,
    );
  } finally {
    release.resolve();
    await Promise.allSettled([saving, management]);
    await f.close();
  }
});

for (const terminal of ["failed", "queued", "running"] as const)
  test(`PostgreSQL manual retry releases an unexpired ${terminal} exhausted source lease and executes successfully`, async () => {
    const f = await fixture();
    try {
      const prepared = await f.prepareSave();
      const state = prepared.current.adapterStates[0];
      const endTime = new Date().toISOString();
      const recoveryCursor = {
        page: 7,
        endTime,
        _sourceScanWindow: {
          sourceId: f.account.externalUserId,
          adapterKey: f.client.adapterKey,
          firstSyncMode: f.account.firstSyncMode,
          startTime: null,
          endTime,
        },
      };
      await f.db.sourceAdapterState.update({
        where: { id: state.id },
        data: {
          cursorJson: recoveryCursor,
          fetchLeaseUntil: new Date(Date.now() + 30 * 60_000),
        },
      });
      const oldItem = await f.db.sourceFetchRunItem.create({
        data: {
          runId: prepared.run.id,
          externalAccountId: f.account.id,
          adapterStateId: state.id,
          adapterKey: f.client.adapterKey,
          status: "running",
          cursorBefore: {},
          pagesFetched: 2,
        },
      });
      await f.db.backgroundJob.update({
        where: { id: await f.jobId(prepared.run.id) },
        data: {
          status: terminal,
          attempts: 3,
          leaseId: randomUUID(),
          leaseUntil: new Date(0),
        },
      });
      const retry = await f.manual();
      assert.notEqual(retry.id, prepared.run.id);
      const reclaimed = (await f.snapshot()).adapterStates[0];
      assert.equal(reclaimed.fetchLeaseId, null);
      assert.equal(reclaimed.fetchLeaseUntil, null);
      assert.deepEqual(reclaimed.cursorJson, recoveryCursor);
      assert.equal(
        (
          await f.db.sourceFetchRun.findUniqueOrThrow({
            where: { id: prepared.run.id },
          })
        ).status,
        "failed",
      );
      assert.equal(
        (
          await f.db.sourceFetchRunItem.findUniqueOrThrow({
            where: { id: oldItem.id },
          })
        ).errorCode,
        "worker_attempts_exhausted",
      );
      let seenCursor: unknown;
      const fetchPage = f.client.fetchPage;
      f.client.fetchPage = async (account, cursor) => {
        seenCursor = cursor;
        return fetchPage(account, cursor);
      };
      await f.execute(retry.id);
      assert.deepEqual(seenCursor, recoveryCursor);
      assert.equal((await f.service.get(retry.id)).status, "succeeded");
      assert.equal(
        await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
        2,
      );
      assert.equal(
        await f.db.candidateMedia.count({
          where: { candidatePost: { authorId: f.author.id } },
        }),
        4,
      );
    } finally {
      await f.close();
    }
  });

test("PostgreSQL manual retry never releases a live final-attempt source lease", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepareSave();
    const workerLease = randomUUID();
    await f.db.backgroundJob.update({
      where: { id: await f.jobId(prepared.run.id) },
      data: {
        status: "running",
        attempts: 3,
        leaseId: workerLease,
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const repeated = await f.manual();
    assert.equal(repeated.id, prepared.run.id);
    assert.equal(
      (await f.snapshot()).adapterStates[0].fetchLeaseId,
      prepared.run.id,
    );
    assert.equal(
      (
        await f.db.backgroundJob.findUniqueOrThrow({
          where: { id: await f.jobId(prepared.run.id) },
        })
      ).leaseId,
      workerLease,
    );
  } finally {
    await f.close();
  }
});

test("PostgreSQL changing adapters keeps unfinished account bounds and rejects a late old epoch", async () => {
  const f = await fixture();
  try {
    const lower = new Date(Date.now() - 86_400_000).toISOString();
    const upper = new Date(Date.now() - 3_600_000).toISOString();
    const state = (await f.snapshot()).adapterStates[0];
    const replacementKey = `${f.client.adapterKey}_b`;
    const replacement: ContentSourceClient = {
      ...f.client,
      adapterKey: replacementKey,
      priority: 2,
      fetchPage: async (_identity, cursor, context) => {
        assert.equal(cursor.startTime, lower);
        assert.equal(cursor.endTime, upper);
        assert.equal(cursor.providerToken, undefined);
        assert.deepEqual(context?.checkpoint, {});
        return { items: [], complete: true, nextCursor: {} };
      },
    };
    f.registry.register(replacement);
    await f.db.sourceAdapterState.update({
      where: { id: state.id },
      data: { enabled: false },
    });
    await f.db.sourceAdapterState.create({
      data: {
        externalAccountId: f.account.id,
        adapterKey: replacementKey,
        completedThroughAt: new Date("2020-01-01T00:00:00.000Z"),
        cursorJson: { providerToken: "foreign" },
      },
    });
    await f.db.sourceAccountScanState.update({
      where: { accountId: f.account.id },
      data: {
        windowJson: {
          version: 1,
          sourceId: "1",
          firstSyncMode: "none",
          startTime: lower,
          endTime: upper,
        },
        epoch: 7,
      },
    });
    const run = await f.manual();
    await f.execute(run.id);
    const scan = await f.db.sourceAccountScanState.findUniqueOrThrow({
      where: { accountId: f.account.id },
    });
    assert.equal(scan.discoveredThroughAt?.toISOString(), upper);
    assert.deepEqual(scan.windowJson, {});
    assert.equal(scan.epoch, 8);
    assert.equal(scan.leaseOwnerJobId, null);
    assert.equal(
      (await f.service.get(run.id)).items.find(
        (item) => item.adapterKey === replacementKey,
      )?.status,
      "succeeded",
    );
    const late = await f.db.sourceAccountScanState.updateMany({
      where: { accountId: f.account.id, epoch: 7 },
      data: { discoveredThroughAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    assert.equal(late.count, 0);
  } finally {
    await f.close();
  }
});

test("PostgreSQL a late old-epoch failure cannot overwrite or release replacement account ownership", async () => {
  const f = await fixture();
  const replacementOwner = randomUUID();
  let retainedWindow: unknown;
  let replacementEpoch = 0;
  try {
    f.client.fetchPage = async () => {
      const scan = await f.db.sourceAccountScanState.update({
        where: { accountId: f.account.id },
        data: {
          epoch: { increment: 1 },
          leaseOwnerJobId: replacementOwner,
          leaseUntil: new Date(Date.now() + 1_800_000),
        },
      });
      replacementEpoch = scan.epoch;
      retainedWindow = scan.windowJson;
      throw new Error("synthetic late failure");
    };
    const run = await f.manual();
    await f.execute(run.id);
    const scan = await f.db.sourceAccountScanState.findUniqueOrThrow({
      where: { accountId: f.account.id },
    });
    assert.equal(scan.epoch, replacementEpoch);
    assert.equal(scan.leaseOwnerJobId, replacementOwner);
    assert.deepEqual(scan.windowJson, retainedWindow);
    assert.equal(scan.discoveredThroughAt, null);
    const state = (await f.snapshot()).adapterStates[0];
    assert.equal(state.health, "idle");
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.fetchLeaseId, run.id);
    assert.equal(
      (await f.service.get(run.id)).items[0].errorCode,
      "source_changed",
    );
  } finally {
    await f.close();
  }
});

test("PostgreSQL account scan migration executes against synthetic history and preserves only trusted gallery state", async () => {
  const f = await fixture();
  try {
    const migration = await readFile(
      new URL(
        "../../prisma/migrations/20261028000200_account_scan_state/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(migration, /^BEGIN;/);
    assert.match(migration.trimEnd(), /COMMIT;$/);
    await f.db.$transaction(async (tx) => {
      // Shadow only this connection's relations. Execute the actual forward SQL;
      // TEMP/ON COMMIT DROP and the surrounding Prisma transaction isolate DDL.
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE author_external_accounts (
        id uuid PRIMARY KEY, platform text, external_user_id text, first_sync_mode text
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE source_adapter_states (
        id text PRIMARY KEY, external_account_id uuid, adapter_key text,
        completed_through_at timestamptz(3), last_success_at timestamptz(3), cursor_json jsonb
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE source_fetch_run_items (
        adapter_state_id text, external_account_id uuid, adapter_key text,
        status text, started_at timestamptz(3)
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO author_external_accounts VALUES
        ('00000000-0000-0000-0000-000000000001', 'x', '1', 'none'),
        ('00000000-0000-0000-0000-000000000002', 'x', '2', 'none'),
        ('00000000-0000-0000-0000-000000000003', 'pixiv', '3', 'none'),
        ('00000000-0000-0000-0000-000000000004', 'pixiv', '4', 'last_24_hours'),
        ('00000000-0000-0000-0000-000000000005', 'pixiv', '5', 'none')`);
      await tx.$executeRawUnsafe(`INSERT INTO source_adapter_states VALUES
        ('trusted', '00000000-0000-0000-0000-000000000001', 'x_gallery_dl', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', '{}'),
        ('retired', '00000000-0000-0000-0000-000000000002', 'x_web_session', '2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z', '{}'),
        ('unproven', '00000000-0000-0000-0000-000000000003', 'pixiv_gallery_dl', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', '{}')`);
      const unfinished = {
        sourceId: "4",
        adapterKey: "pixiv_gallery_dl",
        firstSyncMode: "last_24_hours",
        startTime: "2026-10-20T00:00:00.000Z",
        endTime: "2026-10-21T00:00:00.000Z",
      };
      await tx.$executeRaw`INSERT INTO source_adapter_states VALUES
        ('unfinished', '00000000-0000-0000-0000-000000000004'::uuid, 'pixiv_gallery_dl', NULL, NULL, ${JSON.stringify({ ...unfinished, _sourceScanWindow: unfinished })}::jsonb),
        ('wrong-source', '00000000-0000-0000-0000-000000000005'::uuid, 'pixiv_gallery_dl', NULL, NULL, ${JSON.stringify({ ...unfinished, _sourceScanWindow: unfinished })}::jsonb)`;
      await tx.$executeRawUnsafe(`INSERT INTO source_fetch_run_items VALUES
        ('trusted', '00000000-0000-0000-0000-000000000001', 'x_gallery_dl', 'succeeded', '2026-10-19T00:00:00Z'),
        ('retired', '00000000-0000-0000-0000-000000000002', 'x_web_session', 'succeeded', '2026-10-26T00:00:00Z'),
        ('unproven', '00000000-0000-0000-0000-000000000003', 'pixiv_gallery_dl', 'failed', '2026-10-19T00:00:00Z')`);
      const temporary = migration
        .replace(
          'CREATE TABLE "source_account_scan_states"',
          'CREATE TEMP TABLE "source_account_scan_states"',
        )
        .replace(/\n\);/, "\n) ON COMMIT DROP;");
      for (const statement of temporary
        .split(";")
        .filter((sql) => sql.trim() && !/^(BEGIN|COMMIT)$/i.test(sql.trim())))
        await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRaw<
        Array<{
          account_id: string;
          discovered_through_at: Date | null;
          window_json: unknown;
          epoch: number;
          revision: number;
          lease_owner_job_id: string | null;
        }>
      >`SELECT account_id, discovered_through_at, window_json, epoch, revision, lease_owner_job_id FROM source_account_scan_states ORDER BY account_id`;
      assert.equal(rows.length, 5);
      assert.deepEqual(
        rows.map((row) => row.discovered_through_at?.toISOString() ?? null),
        ["2026-10-20T00:00:00.000Z", null, null, null, null],
      );
      const shared = {
        sourceId: unfinished.sourceId,
        firstSyncMode: unfinished.firstSyncMode,
        startTime: unfinished.startTime,
        endTime: unfinished.endTime,
      };
      assert.deepEqual(
        rows.map((row) => row.window_json),
        [{}, {}, {}, { ...shared, version: 1 }, {}],
      );
      assert.equal(
        rows.every(
          (row) =>
            row.epoch === 0 &&
            row.revision === 0 &&
            row.lease_owner_job_id === null,
        ),
        true,
      );
    });
  } finally {
    await f.close();
  }
});

test("PostgreSQL Pixiv natural encounter preserves human work and seven-day mode coverage", async () => {
  const f = await fixture("pixiv");
  let workId: string | undefined;
  try {
    const prepared = await f.prepareSave();
    const coverage = new Date("2026-10-20T00:00:00Z");
    await f.db.authorExternalAccount.update({
      where: { id: f.account.id },
      data: { firstSyncMode: "last_7_days" },
    });
    await f.db.sourceAccountScanState.update({
      where: { accountId: f.account.id },
      data: { discoveredThroughAt: coverage },
    });
    await prepared.save();
    const candidate = await f.db.candidatePost.findUniqueOrThrow({
      where: {
        platform_externalPostId: {
          platform: "pixiv",
          externalPostId: f.contents[0].externalContentId,
        },
      },
    });
    await f.db.candidatePost.update({
      where: { id: candidate.id },
      data: { revision: 7, status: "imported" },
    });
    const work = await f.db.work.create({
      data: {
        authorId: f.author.id,
        sourceCandidatePostId: candidate.id,
        importedById: f.actor.id,
        sourceText: "Human edited source",
        title: "Human title",
        revision: 4,
      },
    });
    workId = work.id;
    const beforeDownloads = f.downloads;
    const mediaCount = await f.db.candidateMedia.count({
      where: { candidatePostId: candidate.id },
    });
    const description = "Source & entity\nLink label <student>";
    await prepared.save({
      ...f.contents[0],
      text: description,
      title: "Source title",
      description,
      rawJson: { synthetic: true, title: "Source title", description },
    });
    await prepared.save({
      ...f.contents[0],
      text: "Source title",
      title: "Source title",
      description: "",
      rawJson: { synthetic: true },
    });
    const after = await f.db.candidatePost.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    assert.equal(after.text, description);
    assert.equal(
      (after.rawJson as { description: string }).description,
      description,
    );
    assert.equal(after.revision, 7);
    assert.equal(after.status, "imported");
    assert.equal(f.downloads, beforeDownloads);
    assert.equal(
      await f.db.candidateMedia.count({
        where: { candidatePostId: candidate.id },
      }),
      mediaCount,
    );
    assert.deepEqual(
      await f.db.work.findUniqueOrThrow({ where: { id: work.id } }),
      work,
    );
    assert.equal((await f.snapshot()).firstSyncMode, "last_7_days");
    assert.deepEqual(
      (
        await f.db.sourceAccountScanState.findUniqueOrThrow({
          where: { accountId: f.account.id },
        })
      ).discoveredThroughAt,
      coverage,
    );
  } finally {
    if (workId) await f.db.work.delete({ where: { id: workId } });
    await f.close();
  }
});
