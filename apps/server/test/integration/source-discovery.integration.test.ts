/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import type {
  ContentSourceClient,
  NormalizedSourceContent,
} from "../../src/source-ingestion/content-source.js";
loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL ending _test required");
async function fixture() {
  const key = `d7_${randomUUID().slice(0, 16)}`;
  const environment = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
  const db = new PrismaService(environment);
  await db.onModuleInit();
  const jobs = new JobsService(db);
  const requests: string[] = [];
  const fileIds: string[] = [];
  const deleted: string[] = [];
  let failing = true,
    metadataMissing = false,
    refreshes = 0;
  const contents: NormalizedSourceContent[] = [1, 2].map((id) => ({
    externalContentId: String(id),
    type: "post",
    permalink: `https://fixture.invalid/${id}`,
    publishedAt: "2026-10-01T00:00:00Z",
    ownMedia: Array.from({ length: id === 1 ? 2 : 1 }, (_, i) => ({
      externalMediaId: `${id}:${i}`,
      type: "photo",
      url: `https://fixture.invalid/${id}/${i}.png`,
    })),
    rawJson: { synthetic: true },
  }));
  const client: ContentSourceClient = {
    platform: key,
    adapterKey: key,
    priority: 1,
    available: true,
    metered: false,
    supportedFirstSyncModes: ["none"],
    allowedMediaHosts: ["fixture.invalid"],
    initialCursor: () => ({}),
    checkAccount: async (a) => a,
    fetchPage: async () => ({
      items: metadataMissing ? [contents[1]] : contents,
      discoveryFailures: metadataMissing
        ? [
            {
              externalPostId: "1",
              failureCode: "metadata_unavailable",
              evidence: { kind: "author_catalog", sourceId: "42" },
            },
          ]
        : [],
      nextCursor: {},
      complete: true,
    }),
    fetchPost: async (_a, id) => {
      refreshes++;
      return {
        kind: "ready",
        item: {
          ...contents.find((c) => c.externalContentId === id)!,
          ownMedia: contents
            .find((c) => c.externalContentId === id)!
            .ownMedia.map((m) => ({ ...m, url: m.url + "?fresh=1" })),
        },
      };
    },
  };
  const files = new FileObjectsService(
    db,
    {
      delete: async (k: string) => {
        deleted.push(k);
      },
    } as any,
    jobs,
  );
  const store = async () => {
    const row = await db.fileObject.create({
      data: {
        objectKey: key + "/" + randomUUID(),
        kind: "candidate-media",
        bucketScope: "source",
        contentType: "image/png",
        size: 1n,
        checksum: createHash("sha256").update("synthetic").digest("hex"),
      },
    });
    fileIds.push(row.id);
    return row;
  };
  const service = new SourceFetchService(
    jobs,
    db,
    new ContentSourceRegistry().register(client),
    {
      download: async (u: string) => {
        requests.push(u);
        if (failing && u.includes("/1/1.png"))
          throw new Error("synthetic CDN unavailable");
        return { body: Buffer.from("x"), contentType: "image/png" };
      },
    } as any,
    {
      store,
      purgeUnreferenced: (id: string) => files.purgeUnreferenced(id),
    } as any,
    { available: false } as any,
    environment,
  );
  const generation = createHash("sha256").update(key).digest("hex");
  service.platforms.fingerprint = async () => generation;
  service.onModuleInit();
  jobs.registerQueuePolicy("network", `source:${key}`, {
    primary: "scan",
    secondary: "recovery",
    primaryWeight: 3,
  });
  const setup = await db.$transaction(async (tx) => {
    const actor = await tx.user.create({
      data: {
        username: key,
        displayName: key,
        passwordHash: "disabled",
        mustChangePassword: false,
        roles: { create: { role: "source" } },
      },
    });
    const author = await tx.author.create({
      data: { displayName: key, authorizationStatus: "authorized" },
    });
    const account = await tx.authorExternalAccount.create({
      data: {
        authorId: author.id,
        platform: key,
        externalUserId: "42",
        fetchEnabled: true,
        firstSyncMode: "none",
      },
    });
    return { actor, author, account };
  });
  const execute = async () => {
    const job = await jobs.claim("network", new Date(), `source:${key}`);
    assert.ok(job);
    await jobs.execute(job);
    return job;
  };
  const scan = async () => {
    const run = await service.runManual(setup.actor.id, {
      accountIds: [setup.account.id],
    });
    await execute();
    return db.sourceFetchRun.findUniqueOrThrow({ where: { id: run.id } });
  };
  const due = async () => {
    await db.sourceDiscoveryPost.updateMany({
      where: {
        accountId: setup.account.id,
        state: { in: ["metadata_pending", "media_pending"] },
      },
      data: { nextRetryAt: new Date(0) },
    });
    await service.recovery.schedule();
  };
  const cleanup = async () => {
    const runs = await db.sourceFetchRun.findMany({
      where: { requestedById: setup.actor.id },
      select: { id: true },
    });
    await db.sourceRecoveryCampaign.deleteMany({
      where: { discoveryPost: { accountId: setup.account.id } },
    });
    await db.sourceDiscoveryMedia.deleteMany({
      where: { discoveryPost: { accountId: setup.account.id } },
    });
    await db.sourceDiscoveryPost.deleteMany({
      where: { accountId: setup.account.id },
    });
    await db.candidateMedia.deleteMany({
      where: { candidatePost: { authorId: setup.author.id } },
    });
    await db.candidatePost.deleteMany({ where: { authorId: setup.author.id } });
    await db.sourceFetchRun.deleteMany({
      where: { id: { in: runs.map((r) => r.id) } },
    });
    await db.backgroundJob.deleteMany({ where: { actorId: setup.actor.id } });
    await db.authorExternalAccount.delete({ where: { id: setup.account.id } });
    await db.author.delete({ where: { id: setup.author.id } });
    await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
    await db.userRole.deleteMany({ where: { userId: setup.actor.id } });
    await db.user.delete({ where: { id: setup.actor.id } });
    await db.sourcePlatformState.deleteMany({ where: { platform: key } });
    await db.$disconnect();
  };
  return {
    db,
    jobs,
    service,
    files,
    store,
    contents,
    requests,
    fileIds,
    deleted,
    client,
    generation,
    ...setup,
    execute,
    scan,
    due,
    cleanup,
    setFail: (v: boolean) => {
      failing = v;
    },
    setMetadataMissing: () => {
      metadataMissing = true;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

test("ledger registers media before cursor, preserves successes through GC and independently repairs only missing URLs", async () => {
  const f = await fixture();
  try {
    const run = await f.scan();
    assert.equal(run.status, "partial_failed");
    assert.ok(run.completedAt);
    const posts = await f.db.sourceDiscoveryPost.findMany({
      where: { accountId: f.account.id },
      include: { media: true },
      orderBy: { externalPostId: "asc" },
    });
    assert.equal(posts[0].state, "media_pending");
    assert.equal(posts[1].state, "complete");
    assert.equal(posts[0].media.filter((m) => m.fileObjectId).length, 1);
    const retained = posts[0].media.find((m) => m.fileObjectId)!.fileObjectId!;
    await f.files.purgeUnreferenced(retained);
    assert.equal(f.deleted.length, 0);
    assert.ok(await f.db.fileObject.findUnique({ where: { id: retained } }));
    assert.ok(
      (
        await f.db.sourceAccountScanState.findUniqueOrThrow({
          where: { accountId: f.account.id },
        })
      ).discoveredThroughAt,
    );
    f.setFail(false);
    f.requests.length = 0;
    await f.due();
    await f.execute();
    assert.deepEqual(f.requests, ["https://fixture.invalid/1/1.png?fresh=1"]);
    assert.equal(f.refreshes, 1);
    assert.equal(
      await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
      2,
    );
    assert.equal(
      (
        await f.db.sourceDiscoveryPost.findUniqueOrThrow({
          where: { id: posts[0].id },
        })
      ).state,
      "complete",
    );
    assert.equal(
      (await f.db.sourceFetchRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
      "partial_failed",
    );
    assert.equal(
      (
        await f.db.sourceRecoveryCampaign.findFirstOrThrow({
          where: { discoveryPostId: posts[0].id },
        })
      ).state,
      "succeeded",
    );
  } finally {
    await f.cleanup();
  }
});

test("metadata pending is a null-count stub; campaign survives gate/crash and third exhaustion settles once through eight campaigns", async () => {
  const f = await fixture();
  try {
    f.setMetadataMissing();
    const run = await f.scan();
    assert.equal(run.status, "partial_failed");
    const post = await f.db.sourceDiscoveryPost.findFirstOrThrow({
      where: { accountId: f.account.id, externalPostId: "1" },
    });
    assert.equal(post.metadataJson, null);
    assert.equal(post.expectedMediaCount, null);
    await f.due();
    await f.service.recovery.schedule();
    assert.equal(
      await f.db.sourceRecoveryCampaign.count({
        where: { discoveryPostId: post.id },
      }),
      1,
    );
    await f.db.sourcePlatformState.update({
      where: { platform: f.client.platform },
      data: { status: "auth_paused" },
    });
    assert.equal(
      await f.jobs.claim("network", new Date(), `source:${f.client.platform}`),
      null,
    );
    const first = await f.db.sourceRecoveryCampaign.findFirstOrThrow({
      where: { discoveryPostId: post.id },
    });
    assert.equal(
      (
        await f.db.backgroundJob.findUniqueOrThrow({
          where: { id: first.jobId! },
        })
      ).attempts,
      0,
    );
    await f.db.sourcePlatformState.update({
      where: { platform: f.client.platform },
      data: { status: "unverified" },
    });
    for (let number = 1; number <= 8; number++) {
      await f.due();
      const campaign = await f.db.sourceRecoveryCampaign.findUniqueOrThrow({
        where: { discoveryPostId_number: { discoveryPostId: post.id, number } },
      });
      await f.db.backgroundJob.update({
        where: { id: campaign.jobId! },
        data: {
          status: "running",
          attempts: 3,
          leaseUntil: new Date(0),
          leaseId: randomUUID(),
        },
      });
      await f.service.recovery.reconcile();
      await f.service.recovery.reconcile();
      assert.equal(
        (
          await f.db.sourceDiscoveryPost.findUniqueOrThrow({
            where: { id: post.id },
          })
        ).attempts,
        number,
      );
    }
    const exhausted = await f.db.sourceDiscoveryPost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(exhausted.state, "needs_attention");
    assert.equal(exhausted.nextRetryAt, null);
    const safe = await f.service.discovery.attention();
    assert.ok(safe.some((p) => p.id === post.id));
    assert.equal(JSON.stringify(safe).includes("fixture.invalid"), false);
  } finally {
    await f.cleanup();
  }
});

test("crash after final media attach can finalize offline without certifying credentials; GC pending file cannot attach", async () => {
  const f = await fixture();
  try {
    const run = await f.scan();
    const post = await f.db.sourceDiscoveryPost.findFirstOrThrow({
      where: { accountId: f.account.id, externalPostId: "1" },
    });
    const missing = await f.db.sourceDiscoveryMedia.findFirstOrThrow({
      where: { discoveryPostId: post.id, fileObjectId: null },
    });
    const file = await f.store();
    await f.db.$transaction((tx) =>
      f.service.discovery.attach(tx, post.id, missing.externalMediaId, file.id),
    );
    await f.db.sourcePlatformState.update({
      where: { platform: f.client.platform },
      data: { status: "unverified" },
    });
    await f.due();
    await f.execute();
    assert.equal(f.refreshes, 0);
    assert.equal(
      (
        await f.db.sourcePlatformState.findUniqueOrThrow({
          where: { platform: f.client.platform },
        })
      ).status,
      "unverified",
    );
    assert.equal(
      (
        await f.db.sourceDiscoveryPost.findUniqueOrThrow({
          where: { id: post.id },
        })
      ).state,
      "complete",
    );
    const dead = await f.store();
    await f.db.fileObject.update({
      where: { id: dead.id },
      data: { lifecycleStatus: "pending_deletion" },
    });
    await assert.rejects(
      f.db.$transaction((tx) =>
        f.service.discovery.attach(
          tx,
          post.id,
          missing.externalMediaId,
          dead.id,
        ),
      ),
      /no longer active/,
    );
    assert.equal(
      (await f.db.sourceFetchRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
      "partial_failed",
    );
  } finally {
    await f.cleanup();
  }
});

test("one campaign consumes three job attempts, then advances once; paused/rebound account never invokes refresh", async () => {
  const f = await fixture();
  try {
    await f.scan();
    await f.due();
    const post = await f.db.sourceDiscoveryPost.findFirstOrThrow({
      where: { accountId: f.account.id, externalPostId: "1" },
    });
    const campaign = await f.db.sourceRecoveryCampaign.findFirstOrThrow({
      where: { discoveryPostId: post.id },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.db.backgroundJob.update({
        where: { id: campaign.jobId! },
        data: { availableAt: new Date(0) },
      });
      await f.execute();
      assert.equal(
        (
          await f.db.sourceDiscoveryPost.findUniqueOrThrow({
            where: { id: post.id },
          })
        ).attempts,
        0,
      );
      assert.equal(
        (
          await f.db.backgroundJob.findUniqueOrThrow({
            where: { id: campaign.jobId! },
          })
        ).attempts,
        attempt,
      );
    }
    await f.service.recovery.reconcile();
    assert.equal(
      (
        await f.db.sourceDiscoveryPost.findUniqueOrThrow({
          where: { id: post.id },
        })
      ).attempts,
      1,
    );
    await f.due();
    const second = await f.db.sourceRecoveryCampaign.findUniqueOrThrow({
      where: {
        discoveryPostId_number: { discoveryPostId: post.id, number: 2 },
      },
    });
    const before = f.refreshes;
    await f.db.authorExternalAccount.update({
      where: { id: f.account.id },
      data: { fetchEnabled: false, revision: { increment: 1 } },
    });
    await f.execute();
    assert.equal(f.refreshes, before);
    await f.db.authorExternalAccount.update({
      where: { id: f.account.id },
      data: {
        fetchEnabled: true,
        externalUserId: "99",
        revision: { increment: 1 },
      },
    });
    await f.db.backgroundJob.update({
      where: { id: second.jobId! },
      data: { availableAt: new Date(0) },
    });
    await f.execute();
    assert.equal(f.refreshes, before);
    assert.equal(
      await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("a crash in page registration rolls back all discoveries and keeps coverage; replay remains idempotent", async () => {
  const f = await fixture();
  try {
    const record = f.service.discovery.record.bind(f.service.discovery);
    let once = true;
    f.service.discovery.record = async (...args: Parameters<typeof record>) => {
      const result = await record(...args);
      if (once) {
        once = false;
        throw new Error("synthetic registration crash");
      }
      return result;
    };
    await f.scan();
    assert.equal(
      await f.db.sourceDiscoveryPost.count({
        where: { accountId: f.account.id },
      }),
      0,
    );
    assert.equal(
      (
        await f.db.sourceAccountScanState.findUniqueOrThrow({
          where: { accountId: f.account.id },
        })
      ).discoveredThroughAt,
      null,
    );
    assert.equal(f.requests.length, 0);
    f.service.discovery.record = record;
    f.setFail(false);
    const job = await f.db.backgroundJob.findFirstOrThrow({
      where: { actorId: f.actor.id, kind: "source_account_fetch" },
    });
    await f.db.backgroundJob.update({
      where: { id: job.id },
      data: { availableAt: new Date(0) },
    });
    await f.execute();
    assert.equal(
      await f.db.sourceDiscoveryPost.count({
        where: { accountId: f.account.id },
      }),
      2,
    );
    assert.equal(
      await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
      2,
    );
    assert.ok(
      (
        await f.db.sourceAccountScanState.findUniqueOrThrow({
          where: { accountId: f.account.id },
        })
      ).discoveredThroughAt,
    );
  } finally {
    await f.cleanup();
  }
});

test("recovery refuses a changed original asset path at stable ordinals and retains an explicit unresolved ledger", async () => {
  const f = await fixture();
  try {
    await f.scan();
    const post = await f.db.sourceDiscoveryPost.findFirstOrThrow({
      where: { accountId: f.account.id, externalPostId: "1" },
      include: { media: true },
    });
    const retained = post.media.find((m) => m.fileObjectId)!.fileObjectId;
    f.contents[0].ownMedia = f.contents[0].ownMedia.map((m) => ({
      ...m,
      url: m.url.replace("/1/", "/revision2/1/"),
    }));
    f.setFail(false);
    f.requests.length = 0;
    await f.due();
    const campaign = await f.db.sourceRecoveryCampaign.findFirstOrThrow({
      where: { discoveryPostId: post.id },
    });
    for (let i = 0; i < 3; i++) {
      await f.db.backgroundJob.update({
        where: { id: campaign.jobId! },
        data: { availableAt: new Date(0) },
      });
      await f.execute();
    }
    await f.service.recovery.reconcile();
    const unresolved = await f.db.sourceDiscoveryPost.findUniqueOrThrow({
      where: { id: post.id },
      include: { media: true },
    });
    assert.equal(unresolved.state, "needs_attention");
    assert.equal(unresolved.failureCode, "asset_identity_changed");
    assert.equal(unresolved.nextRetryAt, null);
    assert.equal(
      unresolved.media.find((m) => m.fileObjectId)!.fileObjectId,
      retained,
    );
    assert.deepEqual(f.requests, []);
    assert.equal(
      await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("pre-ledger candidate adoption proves historical assets and preserves terminal and human Work state", async () => {
  const f = await fixture();
  const workIds: string[] = [];
  const variants = [
    "changed",
    "unknown",
    "query",
    "needs_attention",
    "excluded",
  ] as const;
  const histories: {
    candidateId: string;
    fileId: string;
    work: Awaited<ReturnType<typeof f.db.work.create>>;
    reviewedAt: Date;
  }[] = [];
  try {
    f.contents.splice(
      0,
      f.contents.length,
      ...variants.map((_variant, index) => ({
        ...f.contents[0],
        externalContentId: String(100 + index),
        ownMedia: [
          {
            externalMediaId: `${100 + index}:0`,
            type: "photo" as const,
            url: `https://fixture.invalid/original/${100 + index}.png?fresh=1`,
          },
        ],
      })),
    );
    for (const [index, variant] of variants.entries()) {
      const content = f.contents[index];
      const file = await f.store();
      const reviewedAt = new Date("2026-10-01T00:00:00Z");
      const candidate = await f.db.candidatePost.create({
        data: {
          authorId: f.author.id,
          authorExternalAccountId: f.account.id,
          platform: f.account.platform,
          externalPostId: content.externalContentId,
          postedAt: new Date(content.publishedAt),
          rawJson: {},
          status: "imported",
          revision: 7,
          reviewedAt,
          reviewedById: f.actor.id,
          media: {
            create: {
              externalMediaId: content.ownMedia[0].externalMediaId,
              fileObjectId: file.id,
              orderIndex: 0,
              mediaType: "photo",
              sourceUrl:
                variant === "unknown"
                  ? null
                  : variant === "changed"
                    ? `https://fixture.invalid/old/${100 + index}.png`
                    : content.ownMedia[0].url.replace("fresh=1", "old=1"),
            },
          },
        },
      });
      const work = await f.db.work.create({
        data: {
          authorId: f.author.id,
          sourceCandidatePostId: candidate.id,
          importedById: f.actor.id,
          title: "Human title",
          sourceText: "Human text",
          workflowStatus: "translating",
          revision: 3,
        },
      });
      workIds.push(work.id);
      histories.push({
        candidateId: candidate.id,
        fileId: file.id,
        work,
        reviewedAt,
      });
      if (variant === "needs_attention" || variant === "excluded") {
        const post = await f.db.$transaction((tx) =>
          f.service.discovery.record(
            tx,
            {
              accountId: f.account.id,
              platform: f.account.platform,
              sourceUserId: "42",
              adapterKey: f.client.adapterKey,
              actorId: f.actor.id,
              discoveredRunId: randomUUID(),
              windowJson: {},
            },
            content,
          ),
        );
        await f.db.sourceDiscoveryPost.update({
          where: { id: post.id },
          data: {
            state: variant,
            failureCode: "preserve_reason",
            nextRetryAt: null,
          },
        });
      }
    }
    await f.scan();
    assert.deepEqual(
      f.requests,
      [],
      "known historical candidates must not redownload media",
    );
    for (const [index, variant] of variants.entries()) {
      const history = histories[index];
      const post = await f.db.sourceDiscoveryPost.findUniqueOrThrow({
        where: {
          accountId_platform_externalPostId: {
            accountId: f.account.id,
            platform: f.account.platform,
            externalPostId: String(100 + index),
          },
        },
        include: { media: true },
      });
      assert.equal(
        post.state,
        variant === "query"
          ? "complete"
          : variant === "excluded"
            ? "excluded"
            : "needs_attention",
        variant,
      );
      assert.equal(
        post.media[0].fileObjectId,
        variant === "query" ? history.fileId : null,
        variant,
      );
      if (variant === "needs_attention" || variant === "excluded")
        assert.equal(post.failureCode, "preserve_reason");
      const candidate = await f.db.candidatePost.findUniqueOrThrow({
        where: { id: history.candidateId },
        include: { media: true },
      });
      assert.equal(candidate.status, "imported");
      assert.equal(candidate.revision, 7);
      assert.deepEqual(candidate.reviewedAt, history.reviewedAt);
      assert.equal(candidate.reviewedById, f.actor.id);
      assert.equal(candidate.media[0].fileObjectId, history.fileId);
      assert.deepEqual(
        await f.db.work.findUniqueOrThrow({ where: { id: history.work.id } }),
        history.work,
      );
    }
  } finally {
    await f.db.work.deleteMany({ where: { id: { in: workIds } } });
    await f.cleanup();
  }
});
