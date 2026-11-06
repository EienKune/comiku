import { SourceFetchService } from "../../src/source-ingestion/source-fetch.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { SourceResponseError } from "../../src/source-ingestion/source-response.js";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { zipSync } from "fflate";
import { AppModule } from "../../src/app.module.js";
import { configureApplication } from "../../src/application.js";
import { AuthorsService } from "../../src/authors/authors.service.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import type {
  ContentSourceClient,
  SourceAccountIdentity,
  SourceAccountProfile,
  SourceCursor,
  SourcePage,
} from "../../src/source-ingestion/content-source.js";
import {
  MEDIA_DOWNLOADER,
  type MediaDownloader,
} from "../../src/source-ingestion/media-downloader.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { hashPassword } from "../../src/users/password.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable _test database.",
  );
}

class FixtureSource implements ContentSourceClient {
  readonly platform = "fixture";
  readonly adapterKey = "fixture_default";
  readonly priority = 10;
  readonly metered = true;
  readonly available = true;
  readonly supportedFirstSyncModes = ["none", "last_24_hours"] as const;
  readonly allowedMediaHosts = ["media.fixture.invalid"] as const;
  private failedOnce = false;

  constructor(private readonly prefix: string) {}

  initialCursor() {
    return { page: 0 };
  }

  async checkAccount(
    account: SourceAccountIdentity,
  ): Promise<SourceAccountProfile> {
    return { externalUserId: account.externalUserId };
  }

  async fetchPage(
    _account: SourceAccountIdentity,
    cursor: SourceCursor,
  ): Promise<SourcePage> {
    if (cursor.sinceId === "complete") {
      return { items: [], complete: true, nextCursor: { sinceId: "complete" } };
    }
    const photo = (id: string, suffix: string) => ({
      externalMediaId: `${this.prefix}-media-${id}`,
      type: "photo" as const,
      url: `https://media.fixture.invalid/${suffix}.jpg`,
      width: 1200,
      height: 800,
    });
    const first = {
      externalContentId: `${this.prefix}-post-1`,
      type: "post" as const,
      text: "第一条候选",
      hashtags: ["BlueArchive"],
      permalink: `https://fixture.invalid/${this.prefix}/1`,
      publishedAt: "2026-09-07T00:00:00.000Z",
      ownMedia: [photo("1", "one"), photo("2", "two")],
      rawJson: { fixture: 1 },
    };
    if (cursor.page === 0) {
      return {
        items: [
          first,
          {
            externalContentId: `${this.prefix}-repost`,
            type: "repost",
            text: "excluded repost",
            permalink: `https://fixture.invalid/${this.prefix}/repost`,
            publishedAt: "2026-09-07T00:01:00.000Z",
            ownMedia: [photo("repost", "repost")],
            rawJson: { fixture: "repost" },
          },
        ],
        complete: false,
        nextCursor: { page: 1 },
      };
    }
    if (!this.failedOnce) {
      this.failedOnce = true;
      throw new SourceResponseError("invalid_response");
    }
    return {
      items: [
        first,
        {
          externalContentId: `${this.prefix}-post-2`,
          type: "reply",
          text: "回复自己的新图片",
          permalink: `https://fixture.invalid/${this.prefix}/2`,
          publishedAt: "2026-09-07T00:02:00.000Z",
          ownMedia: [photo("3", "three")],
          referencedContentId: `${this.prefix}-parent`,
          rawJson: { fixture: 2 },
        },
        {
          externalContentId: `${this.prefix}-quote-empty`,
          type: "quote",
          text: "quoted media is not own media",
          permalink: `https://fixture.invalid/${this.prefix}/quote`,
          publishedAt: "2026-09-07T00:03:00.000Z",
          ownMedia: [],
          referencedContentId: `${this.prefix}-quoted`,
          rawJson: { fixture: "quote" },
        },
      ],
      complete: true,
      nextCursor: { sinceId: "complete" },
    };
  }
}

class FailingFixtureSource implements ContentSourceClient {
  readonly platform = "fixture";
  readonly adapterKey = "fixture_unstable";
  readonly priority = 5;
  readonly metered = false;
  readonly available = true;
  readonly supportedFirstSyncModes = ["none", "last_24_hours"] as const;
  readonly allowedMediaHosts = ["media.fixture.invalid"] as const;

  initialCursor() {
    return {};
  }

  async checkAccount(account: SourceAccountIdentity) {
    return { externalUserId: account.externalUserId };
  }

  async fetchPage(): Promise<SourcePage> {
    throw new Error("Fixture primary adapter is unavailable");
  }
}

class FixtureDownloader implements MediaDownloader {
  async download(url: string, allowedHosts: readonly string[]) {
    assert.equal(allowedHosts.includes(new URL(url).hostname), true);
    return {
      body: new TextEncoder().encode(url),
      contentType: "image/jpeg",
      checksum: "fixture",
    };
  }
}

type Browser = { cookie?: string };

test("source fetch, media transfer and candidate batch lifecycle", async () => {
  const prefix = randomUUID().slice(0, 8);
  const registry = new ContentSourceRegistry()
    .register(new FailingFixtureSource())
    .register(new FixtureSource(prefix));
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({
          NODE_ENV: "test",
          DATABASE_URL: testUrl,
          X_OFFICIAL_DAILY_BUDGET: "4",
          X_OFFICIAL_MONTHLY_BUDGET: "4",
          SOURCE_FAILURE_THRESHOLD: "2",
        }),
      ),
    ],
  })
    .overrideProvider(ContentSourceRegistry)
    .useValue(registry)
    .overrideProvider(MEDIA_DOWNLOADER)
    .useValue(new FixtureDownloader())
    .compile();
  const app = moduleRef.createNestApplication();
  configureApplication(app);
  const db = app.get(PrismaService);
  const authors = app.get(AuthorsService);
  const generation = createHash("sha256").update(prefix).digest("hex");
  app.get(SourceFetchService).platforms.fingerprint = async () => generation;
  const password = "fixture-password-12345";
  const userIds: string[] = [];
  let authorId = "";
  let accountId = "";
  let tagGroupId = "";
  let base = "";

  async function request<T>(
    browser: Browser,
    method: string,
    path: string,
    body?: object,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) browser.cookie = cookie.split(";")[0];
    return {
      status: response.status,
      data: (response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.text()) as T,
    };
  }

  async function createBrowser(
    role: "admin" | "source" | "reviewer" | "translator",
  ) {
    const user = await db.user.create({
      data: {
        username: `fetch_${prefix}_${role}`,
        displayName: role,
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    userIds.push(user.id);
    const browser: Browser = {};
    assert.equal(
      (
        await request(browser, "POST", "/api/auth/login", {
          username: user.username,
          password,
        })
      ).status,
      200,
    );
    return browser;
  }

  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const source = await createBrowser("source");
    const reviewer = await createBrowser("reviewer");
    const member = await createBrowser("translator");
    const admin = await createBrowser("admin");
    const author = await authors.create({
      displayName: `抓取作者 ${prefix}`,
      sourceLanguage: "ja",
      authorizationStatus: "authorized",
      tagNames: ["抓取测试"],
    });
    authorId = author.id;
    const account = await authors.createAccount(author.id, {
      platform: "fixture",
      externalUserId: `account-${prefix}`,
      handle: "fixture",
      profileUrl: "https://fixture.invalid/author",
      displayNameSnapshot: "Fixture",
      fetchEnabled: true,
      firstSyncMode: "none",
    });
    accountId = account.id;
    await db.sourceAdapterState.update({
      where: {
        externalAccountId_adapterKey: {
          externalAccountId: accountId,
          adapterKey: "fixture_unstable",
        },
      },
      data: { consecutiveFailures: 1 },
    });
    assert.equal(
      (
        await request(source, "POST", "/api/candidates/tag-groups", {
          name: `作品标签 ${prefix}`,
          kind: "valid",
          enabled: true,
          aliases: ["BlueArchive"],
        })
      ).status,
      403,
    );
    const tagGroup = await request<{ id: string }>(
      admin,
      "POST",
      "/api/candidates/tag-groups",
      {
        name: `作品标签 ${prefix}`,
        kind: "valid",
        enabled: true,
        aliases: ["BlueArchive"],
      },
    );
    assert.equal(tagGroup.status, 201);
    tagGroupId = tagGroup.data.id;
    assert.equal(
      (
        await request<{ id: string }[]>(
          reviewer,
          "GET",
          "/api/candidates/tag-groups",
        )
      ).data.some((group) => group.id === tagGroupId),
      true,
    );

    assert.equal(
      (
        await request(member, "POST", "/api/source-fetch/runs", {
          accountIds: [accountId],
        })
      ).status,
      403,
    );
    const queuedRun = await request<{ id: string; status: string }>(
      source,
      "POST",
      "/api/source-fetch/runs",
      { accountIds: [accountId] },
    );
    assert.equal(queuedRun.data.status, "queued");
    assert.deepEqual(Object.keys(queuedRun.data).sort(), ["id", "status"]);
    const reusedRun = await request<{ id: string; status: string }>(
      source,
      "POST",
      "/api/source-fetch/runs",
      { accountIds: [accountId] },
    );
    assert.equal(reusedRun.data.id, queuedRun.data.id);
    assert.deepEqual(Object.keys(reusedRun.data).sort(), ["id", "status"]);
    for (const actor of [source, reviewer])
      assert.equal(
        (
          await request(
            actor,
            "GET",
            `/api/source-fetch/runs/${queuedRun.data.id}`,
          )
        ).status,
        403,
      );
    await moduleRef
      .get(JobsService)
      .runNext("network", undefined, "source:fixture");
    const run = await request<{
      status: string;
      items: {
        candidatesCreated: number;
        candidatesExisting: number;
        mediaStored: number;
      }[];
    }>(admin, "GET", `/api/source-fetch/runs/${queuedRun.data.id}`);
    assert.equal(run.status, 200);
    assert.equal(run.data.status, "queued", JSON.stringify(run.data));
    const interruptedState = await db.sourceAdapterState.findUniqueOrThrow({
      where: {
        externalAccountId_adapterKey: {
          externalAccountId: accountId,
          adapterKey: "fixture_default",
        },
      },
    });
    assert.equal(interruptedState.highWaterPublishedAt, null);
    assert.equal(interruptedState.lastSuccessAt, null);
    assert.equal(interruptedState.lastErrorCode, "invalid_response");
    const interruptedCursor = interruptedState.cursorJson as SourceCursor;
    assert.equal(interruptedCursor.page, 1);
    assert.equal(typeof interruptedCursor.endTime, "string");
    assert.equal(interruptedState.completedThroughAt, null);
    assert.deepEqual(
      run.data.items.map((item) => [
        item.candidatesCreated,
        item.candidatesExisting,
        item.mediaStored,
      ]),
      [
        [0, 0, 0],
        [1, 0, 2],
      ],
    );
    const resumedQueued = await request<{ id: string }>(
      source,
      "POST",
      "/api/source-fetch/runs",
      { accountIds: [accountId] },
    );
    assert.equal(resumedQueued.data.id, queuedRun.data.id);
    const retryTask = await db.sourceFetchAccountTask.findUniqueOrThrow({
      where: { runId_accountId: { runId: resumedQueued.data.id, accountId } },
    });
    await db.backgroundJob.update({
      where: { id: retryTask.jobId! },
      data: { availableAt: new Date() },
    });
    await moduleRef
      .get(JobsService)
      .runNext("network", undefined, "source:fixture");
    const resumedRun = await request<{
      status: string;
      items: {
        adapterKey: string;
        candidatesCreated: number;
        candidatesExisting: number;
        mediaStored: number;
      }[];
    }>(admin, "GET", `/api/source-fetch/runs/${resumedQueued.data.id}`);
    assert.equal(
      resumedRun.data.status,
      "succeeded",
      JSON.stringify(resumedRun.data),
    );
    assert.deepEqual(
      resumedRun.data.items
        .filter((item) => item.adapterKey === "fixture_default")
        .map((item) => [
          item.candidatesCreated,
          item.candidatesExisting,
          item.mediaStored,
        ]),
      [[2, 1, 3]],
    );
    // Reclaim the SAME run after a crash; its unique run/account/adapter item must be reused.
    const crashRun = await request<{ id: string }>(
      source,
      "POST",
      "/api/source-fetch/runs",
      { accountIds: [accountId] },
    );
    const crashJob = await moduleRef
      .get(JobsService)
      .claim("network", new Date(), "source:fixture");
    assert.equal(
      (
        await db.sourceFetchAccountTask.findUniqueOrThrow({
          where: { id: crashJob!.resourceId },
        })
      ).runId,
      crashRun.data.id,
    );
    const stableState = await db.sourceAdapterState.findUniqueOrThrow({
      where: {
        externalAccountId_adapterKey: {
          externalAccountId: accountId,
          adapterKey: "fixture_default",
        },
      },
    });
    const recoveryUpper = new Date().toISOString();
    await db.sourceAdapterState.update({
      where: { id: stableState.id },
      data: {
        cursorJson: {
          page: 1,
          endTime: recoveryUpper,
          _sourceScanWindow: {
            sourceId: `account-${prefix}`,
            adapterKey: "fixture_default",
            firstSyncMode: "none",
            startTime: null,
            endTime: recoveryUpper,
          },
        },
        fetchLeaseId: crashRun.data.id,
        fetchLeaseUntil: new Date(Date.now() + 1800000),
      },
    });
    await db.sourceAccountScanState.update({
      where: { accountId },
      data: {
        windowJson: {
          version: 1,
          sourceId: `account-${prefix}`,
          firstSyncMode: "none",
          startTime: null,
          endTime: recoveryUpper,
        },
        leaseOwnerJobId: crashJob!.id,
        leaseUntil: new Date(Date.now() + 1800000),
        epoch: { increment: 1 },
      },
    });
    const oldItem = await db.sourceFetchRunItem.create({
      data: {
        runId: crashRun.data.id,
        externalAccountId: accountId,
        adapterStateId: stableState.id,
        adapterKey: "fixture_default",
        cursorBefore: { page: 0 },
        status: "running",
        pagesFetched: 1,
      },
    });
    await db.backgroundJob.update({
      where: { id: crashJob!.id },
      data: { leaseUntil: new Date(0) },
    });
    await moduleRef
      .get(JobsService)
      .runNext("network", undefined, "source:fixture");
    assert.equal(
      (
        await db.sourceFetchRun.findUniqueOrThrow({
          where: { id: crashRun.data.id },
        })
      ).status,
      "succeeded",
    );
    const recoveredItem = await db.sourceFetchRunItem.findUniqueOrThrow({
      where: { id: oldItem.id },
    });
    assert.equal(recoveredItem.status, "succeeded");
    assert.equal(recoveredItem.errorCode, null);
    assert.equal(recoveredItem.errorMessage, null);
    assert.equal(recoveredItem.pagesFetched, 2);
    assert.equal(recoveredItem.candidatesCreated, 0);
    assert.equal(
      await db.sourceFetchRunItem.count({
        where: { runId: crashRun.data.id, adapterKey: "fixture_default" },
      }),
      1,
    );

    const exhaustedRun = await request<{ id: string }>(
      source,
      "POST",
      "/api/source-fetch/runs",
      { accountIds: [accountId] },
    );
    const exhaustedJob = await moduleRef
      .get(JobsService)
      .claim("network", new Date(), "source:fixture");
    assert.equal(
      (
        await db.sourceFetchAccountTask.findUniqueOrThrow({
          where: { id: exhaustedJob!.resourceId },
        })
      ).runId,
      exhaustedRun.data.id,
    );
    await db.backgroundJob.update({
      where: { id: exhaustedJob!.id },
      data: { attempts: 3, leaseUntil: new Date(0) },
    });
    await db.sourceAdapterState.update({
      where: { id: stableState.id },
      data: {
        fetchLeaseId: exhaustedRun.data.id,
        fetchLeaseUntil: new Date(Date.now() + 1800000),
      },
    });
    await db.sourceAccountScanState.update({
      where: { accountId },
      data: {
        leaseOwnerJobId: exhaustedJob!.id,
        leaseUntil: new Date(Date.now() + 1800000),
      },
    });
    assert.equal(
      await moduleRef
        .get(JobsService)
        .claim("network", new Date(), "source:fixture"),
      null,
    );
    await moduleRef.get(SourceFetchService).reconcileExhausted();
    assert.equal(
      (
        await db.sourceFetchRun.findUniqueOrThrow({
          where: { id: exhaustedRun.data.id },
        })
      ).status,
      "failed",
    );
    assert.equal(
      (
        await db.sourceAdapterState.findUniqueOrThrow({
          where: { id: stableState.id },
        })
      ).fetchLeaseId,
      null,
    );

    assert.equal(
      (
        await db.sourceAccountScanState.findUniqueOrThrow({
          where: { accountId },
        })
      ).leaseOwnerJobId,
      null,
    );

    const revokedRun = await request<{ id: string }>(
      source,
      "POST",
      "/api/source-fetch/runs",
      { accountIds: [accountId] },
    );
    const actorId = (
      await db.sourceFetchRun.findUniqueOrThrow({
        where: { id: revokedRun.data.id },
      })
    ).requestedById!;
    await db.userRole.deleteMany({
      where: { userId: actorId, role: "source" },
    });
    await moduleRef
      .get(JobsService)
      .runNext("network", undefined, "source:fixture");
    assert.equal(
      (
        await db.sourceFetchRun.findUniqueOrThrow({
          where: { id: revokedRun.data.id },
        })
      ).status,
      "failed",
    );
    assert.equal(
      await db.sourceFetchRunItem.count({
        where: { runId: revokedRun.data.id },
      }),
      0,
    );
    await db.userRole.create({ data: { userId: actorId, role: "source" } });
    assert.equal((await request(member, "GET", "/api/candidates")).status, 403);
    assert.equal(
      (await request(reviewer, "GET", "/api/source-fetch/runs")).status,
      403,
    );
    assert.equal(
      (await request(source, "GET", "/api/source-fetch/runs")).status,
      403,
    );
    assert.equal(
      (await request(admin, "GET", "/api/source-fetch/runs")).status,
      200,
    );

    const page = await request<{
      items: {
        id: string;
        revision: number;
        hashtags: string[];
        sourceAdapters: string[];
        sourceLanguage: string;
        media: { id: string; orderIndex: number }[];
      }[];
    }>(reviewer, "GET", "/api/candidates?status=pending");
    assert.equal(page.status, 200);
    assert.equal(page.data.items.length, 2);
    assert.equal("tagDisposition" in page.data.items[0], false);
    assert.deepEqual(page.data.items[0].hashtags, ["BlueArchive"]);
    assert.deepEqual(page.data.items[0].sourceAdapters, ["fixture_default"]);
    assert.equal(page.data.items[0].sourceLanguage, "ja");
    assert.equal("visualClass" in page.data.items[0], false);
    const validOnly = await request<{ items: { id: string }[] }>(
      reviewer,
      "GET",
      "/api/candidates?status=pending&triageGroup=priority&sourceLanguage=ja",
    );
    assert.deepEqual(
      validOnly.data.items.map((item) => item.id),
      [page.data.items[0].id],
    );
    assert.deepEqual(
      page.data.items
        .find((item) => item.media.length === 2)
        ?.media.map((item) => item.orderIndex),
      [0, 1],
    );
    const first = page.data.items[0];
    const second = page.data.items[1];
    assert.equal(
      (
        await request(
          source,
          "PATCH",
          `/api/candidates/${first.id}/classification`,
          { label: "photo", expectedRevision: null },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          reviewer,
          "GET",
          "/api/candidates?status=pending&triageGroup=photo",
        )
      ).status,
      400,
    );
    assert.match(
      (
        await request<{ url: string }>(
          reviewer,
          "GET",
          `/api/candidates/${first.id}/media/${first.media[0].id}/url`,
        )
      ).data.url,
      /^memory:/,
    );

    const discarded = await request<{ results: { outcome: string }[] }>(
      source,
      "POST",
      "/api/candidates/actions",
      {
        action: "discard",
        items: [{ id: first.id, expectedRevision: first.revision }],
      },
    );
    assert.deepEqual(
      discarded.data.results.map((item) => item.outcome),
      ["succeeded"],
    );
    const stale = await request<{ results: { outcome: string }[] }>(
      source,
      "POST",
      "/api/candidates/actions",
      {
        action: "restore",
        items: [{ id: first.id, expectedRevision: first.revision }],
      },
    );
    assert.deepEqual(
      stale.data.results.map((item) => item.outcome),
      ["conflict"],
    );
    const current = await request<{ revision: number }>(
      source,
      "GET",
      `/api/candidates/${first.id}`,
    );
    assert.equal(
      (
        await request<{ results: { outcome: string }[] }>(
          source,
          "POST",
          "/api/candidates/actions",
          {
            action: "restore",
            items: [{ id: first.id, expectedRevision: current.data.revision }],
          },
        )
      ).data.results[0].outcome,
      "succeeded",
    );

    const imported = await request<{
      results: { outcome: string; workId: string }[];
    }>(source, "POST", "/api/candidates/actions", {
      action: "import",
      items: [{ id: second.id, expectedRevision: second.revision }],
    });
    assert.equal(imported.data.results[0].outcome, "succeeded");
    assert.ok(imported.data.results[0].workId);
    assert.equal(
      (
        await request<{ results: { outcome: string }[] }>(
          source,
          "POST",
          "/api/candidates/actions",
          {
            action: "import",
            items: [{ id: second.id, expectedRevision: second.revision }],
          },
        )
      ).data.results[0].outcome,
      "unchanged",
    );
    const work = await db.work.findUniqueOrThrow({
      where: { id: imported.data.results[0].workId },
      include: { images: { orderBy: { orderIndex: "asc" } } },
    });
    assert.equal(work.workflowStatus, "pending_translate");
    assert.equal(work.reviewStatus, "normal");
    assert.deepEqual(
      work.images.map((image) => image.orderIndex),
      second.media.map((_, index) => index),
    );
    assert.equal(
      await db.candidateActionLog.count({
        where: { candidatePostId: { in: [first.id, second.id] } },
      }),
      3,
    );
    assert.equal(
      await db.workEvent.count({
        where: { workId: work.id, action: "imported" },
      }),
      1,
    );

    assert.equal(
      await db.sourceAdapterBudgetUsage.count({
        where: { adapterKey: "fixture_default", used: 4 },
      }),
      2,
    );
    const adapterState = await db.sourceAdapterState.findUniqueOrThrow({
      where: {
        externalAccountId_adapterKey: {
          externalAccountId: accountId,
          adapterKey: "fixture_default",
        },
      },
    });
    assert.equal(adapterState.health, "healthy");
    assert.equal(adapterState.cursorJson instanceof Object, true);
    assert.equal(
      await db.candidateSourceObservation.count({
        where: { adapterStateId: adapterState.id },
      }),
      2,
    );
    const disabledAccount = await request<{
      adapterStates: {
        adapterKey: string;
        enabled: boolean;
        revision: number;
      }[];
    }>(
      admin,
      "PATCH",
      `/api/authors/${authorId}/accounts/${accountId}/adapters/fixture_default`,
      { enabled: false, expectedRevision: adapterState.revision },
    );
    assert.equal(disabledAccount.status, 200);
    const disabledState = disabledAccount.data.adapterStates.find(
      (state) => state.adapterKey === "fixture_default",
    )!;
    assert.equal(disabledState.enabled, false);
    assert.equal(
      (
        await request(
          admin,
          "PATCH",
          `/api/authors/${authorId}/accounts/${accountId}/adapters/fixture_default`,
          { enabled: true, expectedRevision: disabledState.revision },
        )
      ).status,
      200,
    );

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      "base64",
    );
    const archive = zipSync({
      "139/manual-page-02.png": png,
      "139/manual-page-01.png": png,
    });
    const checksum = createHash("sha256").update(archive).digest("hex");
    const uploadSession = await request<{
      id: string;
      status: string;
      items: {
        id: string;
        sourceName: string;
        upload: {
          url: string;
          method: string;
          headers: Record<string, string>;
        };
      }[];
    }>(source, "POST", "/api/candidates/upload-sessions", {
      authorId,
      files: [
        {
          sourceName: "manual-pages.zip",
          contentType: "application/zip",
          size: archive.byteLength,
          checksum,
        },
      ],
    });
    assert.equal(uploadSession.status, 201);
    assert.equal(uploadSession.data.status, "pending");
    const target = uploadSession.data.items[0].upload;
    const put = await fetch(base + target.url, {
      method: target.method,
      headers: {
        Origin: "http://localhost:5173",
        ...target.headers,
      },
      body: archive,
    });
    assert.equal(put.status, 200);
    const uploaded = await request<{
      status: string;
      items: {
        status: string;
        candidate: {
          id: string;
          revision: number;
          platform: string;
          externalPostUrl: string | null;
          media: { id: string; externalMediaId: string }[];
        };
      }[];
    }>(
      source,
      "POST",
      `/api/candidates/upload-sessions/${uploadSession.data.id}/finalize`,
    );
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.status, "finalizing");
    const finalizeJob = await db.backgroundJob.findUniqueOrThrow({
      where: { idempotencyKey: `candidate-finalize:${uploadSession.data.id}` },
    });
    await db.backgroundJob.update({
      where: { id: finalizeJob.id },
      data: { priority: 100, createdAt: new Date("2000-01-01") },
    });
    await app.get(JobsService).runNext("heavy");
    const finished = await request<typeof uploaded.data>(
      source,
      "GET",
      `/api/candidates/upload-sessions/${uploadSession.data.id}`,
    );
    uploaded.data = finished.data;
    assert.equal(uploaded.data.status, "completed");
    const manual = uploaded.data.items[0].candidate;
    assert.equal(uploaded.data.items[0].status, "created");
    assert.equal(manual.platform, "manual");
    assert.equal(manual.externalPostUrl, null);
    assert.deepEqual(
      manual.media.map((item) => item.externalMediaId.replace(/^\d+:/, "")),
      ["139/manual-page-01.png", "139/manual-page-02.png"],
    );

    const metadata = await request<{
      revision: number;
      text: string | null;
      externalPostUrl: string | null;
    }>(source, "PATCH", `/api/candidates/${manual.id}/manual-metadata`, {
      authorId,
      text: "手动上传时保留的原帖配文",
      sourceUrl: "https://example.test/manual-source",
      expectedRevision: manual.revision,
    });
    assert.equal(metadata.status, 200);
    assert.equal(metadata.data.text, "手动上传时保留的原帖配文");
    assert.equal(
      metadata.data.externalPostUrl,
      "https://example.test/manual-source",
    );

    const reordered = await request<{
      revision: number;
      media: { id: string }[];
    }>(source, "POST", `/api/candidates/${manual.id}/media-order`, {
      expectedRevision: metadata.data.revision,
      mediaIds: manual.media.map((item) => item.id).reverse(),
    });
    assert.equal(reordered.status, 200);
    assert.deepEqual(
      reordered.data.media.map((item) => item.id),
      manual.media.map((item) => item.id).reverse(),
    );
    const manualImported = await request<{
      results: { outcome: string; workId: string }[];
    }>(source, "POST", "/api/candidates/actions", {
      action: "import",
      items: [{ id: manual.id, expectedRevision: reordered.data.revision }],
    });
    assert.equal(manualImported.data.results[0].outcome, "succeeded");
    const manualWork = await db.work.findUniqueOrThrow({
      where: { id: manualImported.data.results[0].workId },
    });
    assert.equal(
      manualWork.sourcePostUrl,
      "https://example.test/manual-source",
    );
    assert.equal(manualWork.sourceText, "手动上传时保留的原帖配文");
    assert.equal(manualWork.title, null);
    assert.ok(manualWork.workNumber > 0);
    assert.equal(await db.candidatePost.count({ where: { authorId } }), 3);
  } finally {
    const candidates = authorId
      ? await db.candidatePost.findMany({
          where: { authorId },
          select: { id: true },
        })
      : [];
    const candidateIds = candidates.map((item) => item.id);
    const fileIds = candidateIds.length
      ? (
          await db.candidateMedia.findMany({
            where: { candidatePostId: { in: candidateIds } },
            select: { fileObjectId: true },
          })
        ).map((item) => item.fileObjectId)
      : [];
    await db.candidateActionLog.deleteMany({
      where: { candidatePostId: { in: candidateIds } },
    });
    if (authorId) {
      await db.workReviewCase.deleteMany({ where: { work: { authorId } } });
      await db.workEvent.deleteMany({ where: { work: { authorId } } });
      await db.workStageParticipant.deleteMany({
        where: { work: { authorId } },
      });
      await db.workImage.deleteMany({ where: { work: { authorId } } });
      await db.work.deleteMany({ where: { authorId } });
    }
    await db.candidateMedia.deleteMany({
      where: { candidatePostId: { in: candidateIds } },
    });
    await db.candidateUploadSession.deleteMany({
      where: { actorId: { in: userIds } },
    });
    await db.candidatePost.deleteMany({ where: { id: { in: candidateIds } } });
    if (tagGroupId) {
      await db.candidateTagAlias.deleteMany({ where: { groupId: tagGroupId } });
      await db.candidateTagGroup.deleteMany({ where: { id: tagGroupId } });
    }
    if (accountId)
      await db.sourceFetchRunItem.deleteMany({
        where: { externalAccountId: accountId },
      });
    await db.backgroundJob.deleteMany({ where: { actorId: { in: userIds } } });
    await db.sourceFetchRun.deleteMany({
      where: { requestedById: { in: userIds } },
    });
    if (accountId) {
      await db.sourceRecoveryCampaign.deleteMany({
        where: { discoveryPost: { accountId } },
      });
      await db.sourceDiscoveryMedia.deleteMany({
        where: { discoveryPost: { accountId } },
      });
      await db.sourceDiscoveryPost.deleteMany({ where: { accountId } });
    }
    if (accountId)
      await db.authorExternalAccount.deleteMany({ where: { id: accountId } });
    await db.sourceAdapterBudgetUsage.deleteMany({
      where: { adapterKey: "fixture_default" },
    });
    if (authorId) {
      await db.authorTag.deleteMany({ where: { authorId } });
      await db.author.deleteMany({ where: { id: authorId } });
    }
    await db.tag.deleteMany({ where: { normalizedName: "抓取测试" } });
    await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
    await db.accountAudit.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
      },
    });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.userLanguageCapability.deleteMany({
      where: { userId: { in: userIds } },
    });
    await db.sourcePlatformState.deleteMany({
      where: { platform: "fixture", credentialGeneration: generation },
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
