/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

async function fixture() {
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
    platform: prefix,
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
      await db.fileObject.delete({ where: { id } });
    },
  };
  const service = new SourceFetchService(
    jobs,
    db,
    registry,
    downloader,
    files as any,
    { available: false } as any,
    environment,
  );
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
      platform: prefix,
      externalUserId: "1",
      fetchEnabled: true,
      firstSyncMode: "none",
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
  async function execute(runId: string) {
    const job = await db.backgroundJob.update({
      where: { idempotencyKey: `source:${runId}` },
      data: {
        status: "running",
        attempts: { increment: 1 },
        leaseId: randomUUID(),
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
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
    const current = await snapshot();
    const save = (item = contents[0]) =>
      (service as any).saveCandidate(
        current,
        current.adapterStates[0],
        client,
        item,
        actor.id,
        run.id,
        new AbortController().signal,
      );
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
      where: { kind: "source_fetch", resourceId: { in: ids } },
    });
    await db.sourceFetchRunItem.deleteMany({ where: { runId: { in: ids } } });
    await db.sourceFetchRun.deleteMany({ where: { id: { in: ids } } });
    await db.candidateMedia.deleteMany({
      where: { candidatePost: { authorId: author.id } },
    });
    await db.candidatePost.deleteMany({ where: { authorId: author.id } });
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
    contents,
    runIds,
    fileIds,
    manual,
    execute,
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
        where: { resourceId: { in: [...f.runIds] } },
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
      where: { idempotencyKey: `source:${first.id}` },
      data: { attempts: 2, availableAt: new Date(Date.now() + 60_000) },
    });
    assert.equal((await f.manual([])).id, first.id);
    await f.db.backgroundJob.update({
      where: { idempotencyKey: `source:${first.id}` },
      data: {
        status: "running",
        leaseId: randomUUID(),
        leaseUntil: new Date(0),
      },
    });
    assert.equal((await f.manual([])).id, first.id);
    await f.db.backgroundJob.update({
      where: { idempotencyKey: `source:${first.id}` },
      data: { attempts: 3 },
    });
    const fresh = await f.manual([]);
    assert.notEqual(fresh.id, first.id);
    await f.db.backgroundJob.update({
      where: { idempotencyKey: `source:${fresh.id}` },
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
    const jobs = await f.db.backgroundJob.findMany({
      where: { kind: "source_fetch", status: { in: ["queued", "running"] } },
    });
    const relevant = jobs.filter((job) =>
      (job.payload as { accountIds?: string[] }).accountIds?.includes(
        f.account.id,
      ),
    );
    relevant.forEach((job) => f.runIds.add(job.resourceId));
    assert.equal(relevant.length, 1);
    assert.equal(relevant[0].resourceId, manual.id);
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
      const original = (f.service as any).tagDisposition.bind(f.service);
      (f.service as any).tagDisposition = async (tx: any, tags: any) => {
        [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        entered.resolve();
        await release.promise;
        return original(tx, tags);
      };
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
    const original = (f.service as any).tagDisposition.bind(f.service);
    (f.service as any).tagDisposition = async (tx: any, tags: any) => {
      [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      entered.resolve();
      await release.promise;
      return original(tx, tags);
    };
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
      await f.db.sourceAdapterState.update({
        where: { id: state.id },
        data: {
          cursorJson: { page: 7 },
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
        where: { idempotencyKey: `source:${prepared.run.id}` },
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
      assert.deepEqual(reclaimed.cursorJson, { page: 7 });
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
      assert.deepEqual(seenCursor, { page: 7 });
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
      where: { idempotencyKey: `source:${prepared.run.id}` },
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
          where: { idempotencyKey: `source:${prepared.run.id}` },
        })
      ).leaseId,
      workerLease,
    );
  } finally {
    await f.close();
  }
});
