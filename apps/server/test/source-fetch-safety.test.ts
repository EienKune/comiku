/* Synthetic database boundary doubles keep every race deterministic. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceFetchService } from "../src/source-ingestion/source-fetch.service.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";

test("failure logs keep private reason and page context out of persisted public errors", async () => {
  const f = fixture({
    ...client,
    fetchPage: async () => {
      throw new SourceResponseError("authentication", {
        reason: "source_forbidden",
        scope: "source",
        diagnostic: {
          stage: "enumeration",
          message: "private synthetic detail",
        },
      });
    },
  });
  const logs: string[] = [];
  const original = console.info;
  console.info = (message: string) => {
    logs.push(message);
  };
  try {
    await f.service.fetchWithFallback(
      "run",
      f.account,
      null,
      new AbortController().signal,
    );
    const event = logs
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "adapter_failed");
    assert.equal(event.reason, "source_forbidden");
    assert.equal(event.failureScope, "source");
    assert.equal(event.page, "1");
    assert.equal(event.platform, "fixture");
    assert.equal(event.stage, "fetch_page");
    assert.equal(event.diagnostic.stage, "enumeration");
    assert.equal(
      f.row.errorMessage.includes("private synthetic detail"),
      false,
    );
  } finally {
    console.info = original;
  }
});

test("a second post validation failure cannot inherit the first post media context", async () => {
  const f = fixture({
    ...client,
    fetchPage: async () => ({
      items: [
        {
          ...content("1"),
          ownMedia: [
            { ...content("1").ownMedia[0], externalMediaId: "first-media" },
          ],
        },
        { ...content("2"), publishedAt: "invalid-date" },
      ],
      nextCursor: {},
      complete: true,
    }),
  });
  const logs: string[] = [];
  const original = console.info;
  console.info = (message: string) => {
    logs.push(message);
  };
  try {
    await f.service.fetchWithFallback(
      "run",
      f.account,
      null,
      new AbortController().signal,
    );
    const event = logs
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "adapter_failed");
    assert.equal(event.postId, "2");
    assert.equal(event.mediaId, undefined);
    assert.equal(event.stage, "validate_post");
  } finally {
    console.info = original;
  }
});

const environment = {
  sourceFailureThreshold: 3,
  sourceCooldownMinutes: 5,
  sourceOverlapMinutes: 60,
  xOfficialDailyBudget: 1,
  xOfficialMonthlyBudget: 1,
};
const content = (id: string, mediaCount = 1) => ({
  externalContentId: id,
  publishedAt: "2026-10-02T00:00:00Z",
  permalink: `https://fixture.invalid/${id}`,
  text: "#synthetic",
  type: "post",
  ownMedia: Array.from({ length: mediaCount }, (_, i) => ({
    url: `https://fixture.invalid/${id}/${i}.png`,
    type: "photo",
  })),
  rawJson: {},
});
const client: any = {
  adapterKey: "synthetic",
  platform: "fixture",
  priority: 1,
  available: true,
  metered: false,
  supportedFirstSyncModes: ["none"],
  allowedMediaHosts: ["fixture.invalid"],
  initialCursor: () => ({}),
  fetchPage: async () => ({
    items: [content("1"), content("2")],
    nextCursor: { done: true },
    complete: true,
  }),
};

function fixture(source = client) {
  const snapshot: any = {
    id: "state",
    adapterKey: source.adapterKey,
    enabled: true,
    revision: 1,
    health: "idle",
    cursorJson: {},
    highWaterPublishedAt: null,
    highWaterExternalId: null,
    completedThroughAt: null,
    discoveryCheckpointJson: {},
    consecutiveFailures: 2,
    nextAttemptAt: null,
    fetchLeaseId: "run",
    fetchLeaseUntil: new Date(Date.now() + 60_000),
  };
  const live = { ...snapshot };
  const account: any = {
    id: "account",
    authorId: "author",
    author: { revision: 1 },
    externalUserId: "1",
    platform: "fixture",
    revision: 1,
    firstSyncMode: "none",
    adapterStates: [snapshot],
  };
  let eligible = true;
  let actorAllowed = true;
  const committed: string[] = [];
  const purged: string[] = [];
  let downloads = 0;
  let stores = 0;
  let observations = 0;
  const row: any = {
    id: "item",
    status: "running",
    errorCode: null,
    errorMessage: null,
    pagesFetched: 0,
    itemsSeen: 0,
    candidatesCreated: 0,
    candidatesExisting: 0,
    mediaStored: 0,
    apiRequests: 0,
  };
  const stateMatches = (where: any) =>
    (where.revision === undefined || where.revision === live.revision) &&
    (where.fetchLeaseId === undefined ||
      where.fetchLeaseId === live.fetchLeaseId) &&
    (!where.enabled || live.enabled) &&
    (!where.fetchLeaseUntil?.gt ||
      live.fetchLeaseUntil > where.fetchLeaseUntil.gt);
  const apply = (data: any) => {
    for (const [key, value] of Object.entries(data))
      (live as any)[key] = key === "revision" ? live.revision + 1 : value;
  };
  const db: any = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    user: { count: async () => (actorAllowed ? 1 : 0) },
    authorExternalAccount: {
      count: async ({ where }: any) =>
        eligible &&
        (!where.adapterStates || stateMatches(where.adapterStates.some))
          ? 1
          : 0,
    },
    sourceAdapterState: {
      findUniqueOrThrow: async () => ({
        discoveryCheckpointJson: live.discoveryCheckpointJson,
      }),
      updateMany: async ({ where, data }: any) => {
        if (!stateMatches(where)) return { count: 0 };
        apply(data);
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        apply(data);
        return live;
      },
    },
    sourceFetchRunItem: {
      findUnique: async () => null,
      findUniqueOrThrow: async () =>
        Object.fromEntries(
          [
            "pagesFetched",
            "itemsSeen",
            "candidatesCreated",
            "candidatesExisting",
            "mediaStored",
            "apiRequests",
          ].map((key) => [key, row[key]]),
        ),
      create: async () => row,
      update: async ({ data }: any) => Object.assign(row, data),
      updateMany: async ({ data }: any) => {
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    candidatePost: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        committed.push(data.externalPostId);
        return { id: data.externalPostId };
      },
      update: async () => ({}),
    },
    candidateMedia: { createMany: async () => ({ count: 1 }) },
    candidateSourceObservation: {
      upsert: async () => {
        observations++;
      },
    },
    candidateHashtag: {
      createMany: async () => ({}),
      findMany: async () => [],
    },
    candidateTagAlias: { findMany: async () => [] },
  };
  db.$transaction = async (input: any) =>
    typeof input === "function" ? input(db) : Promise.all(input);
  const jobs: any = { assertCurrentLease: async () => {} };
  const downloader: any = {
    download: async () => {
      downloads++;
      return { body: Buffer.from("synthetic"), contentType: "image/png" };
    },
  };
  const files: any = {
    store: async () => ({ id: `file${++stores}`, contentType: "image/png" }),
    purgeUnreferenced: async (id: string) => {
      purged.push(id);
    },
  };
  const registry = new ContentSourceRegistry().register(source);
  const service: any = new SourceFetchService(
    jobs,
    db,
    registry,
    downloader,
    files,
    { available: false } as any,
    environment as any,
  );
  return {
    service,
    db,
    jobs,
    account,
    snapshot,
    live,
    row,
    downloader,
    files,
    committed,
    purged,
    revoke: () => {
      eligible = false;
    },
    revokeActor: () => {
      actorAllowed = false;
    },
    get downloads() {
      return downloads;
    },
    get stores() {
      return stores;
    },
    get observations() {
      return observations;
    },
  };
}

test("empty successful scans advance fixed coverage, independently of the latest publication", async () => {
  const f = fixture();
  const now = new Date("2026-10-27T04:00:00.000Z");
  const next = new Date("2026-10-27T06:00:00.000Z");
  f.snapshot.completedThroughAt = new Date("2026-10-26T04:00:00.000Z");
  f.snapshot.highWaterPublishedAt = new Date("2026-10-01T00:00:00.000Z");
  const cursors: any[] = [];
  const source = {
    ...client,
    fetchPage: async (_account: unknown, cursor: any) => {
      cursors.push(cursor);
      if (cursors.length === 1) clock.setTime(now.getTime() + 5 * 60_000);
      return { items: [], nextCursor: {}, complete: true };
    },
  };
  const clock = test.mock.timers;
  clock.enable({ apis: ["Date"], now });
  try {
    await f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    );
    assert.equal(cursors[0].startTime, "2026-10-26T03:00:00.000Z");
    assert.equal(cursors[0].endTime, now.toISOString());
    assert.equal(f.live.completedThroughAt.toISOString(), now.toISOString());
    assert.equal(
      f.live.lastSuccessAt.toISOString(),
      "2026-10-27T04:05:00.000Z",
    );
    assert.equal(
      f.live.highWaterPublishedAt.toISOString(),
      "2026-10-01T00:00:00.000Z",
    );
    Object.assign(f.snapshot, f.live);
    clock.setTime(next.getTime());
    f.live.fetchLeaseId = "run";
    f.live.fetchLeaseUntil = new Date(next.getTime() + 60_000);
    await f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    );
    assert.equal(cursors[1].startTime, "2026-10-27T03:00:00.000Z");
    assert.equal(f.live.completedThroughAt.toISOString(), next.toISOString());
  } finally {
    clock.reset();
  }
});

test("first scans use the configured window and exclude the exact upper bound and future posts", async () => {
  const f = fixture();
  const upper = new Date("2026-10-27T04:00:00.000Z");
  const source = {
    ...client,
    initialCursor: (mode: string, now: Date) => {
      assert.equal(mode, "last_24_hours");
      assert.equal(now.toISOString(), upper.toISOString());
      return { startTime: "2026-10-26T04:00:00.000Z" };
    },
    fetchPage: async () => ({
      items: [
        { ...content("past"), publishedAt: "2026-10-26T03:59:59.999Z" },
        { ...content("inside"), publishedAt: "2026-10-27T03:59:59.999Z" },
        { ...content("upper"), publishedAt: upper.toISOString() },
        { ...content("future"), publishedAt: "2099-01-01T00:00:00.000Z" },
      ],
      nextCursor: {},
      complete: true,
    }),
  };
  f.account.firstSyncMode = "last_24_hours";
  test.mock.timers.enable({ apis: ["Date"], now: upper });
  try {
    await f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    );
    assert.deepEqual(f.committed, ["inside"]);
    assert.equal(f.live.highWaterExternalId, "inside");
    assert.equal(f.live.completedThroughAt.toISOString(), upper.toISOString());
  } finally {
    test.mock.timers.reset();
  }
});

test("discovery cache is loaded once per scan and only the terminal checkpoint is committed", async () => {
  const f = fixture();
  f.live.discoveryCheckpointJson = { ids: ["old"] };
  let reads = 0;
  let page = 0;
  f.db.sourceAdapterState.findUniqueOrThrow = async (query: any) => {
    reads++;
    assert.deepEqual(query.select, { discoveryCheckpointJson: true });
    return { discoveryCheckpointJson: f.live.discoveryCheckpointJson };
  };
  const source = {
    ...client,
    fetchPage: async (_account: unknown, _cursor: unknown, context: any) => {
      assert.deepEqual(context.checkpoint, { ids: ["old"] });
      page++;
      if (page === 2) throw new Error("interrupted cache");
      return {
        items: [],
        nextCursor: { page },
        complete: false,
        boundaryReached: false,
        checkpoint: { ids: ["uncommitted"] },
      };
    },
  };
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    ),
    /interrupted cache/,
  );
  assert.equal(reads, 1);
  assert.equal(f.live.completedThroughAt, null);
  assert.deepEqual(f.live.discoveryCheckpointJson, { ids: ["old"] });
  assert.equal(
    JSON.stringify(f.live.cursorJson).includes("uncommitted"),
    false,
  );
  Object.assign(f.snapshot, f.live);
  source.fetchPage = async (
    _account: unknown,
    _cursor: unknown,
    context: any,
  ) => {
    assert.deepEqual(context.checkpoint, { ids: ["old"] });
    return {
      items: [],
      nextCursor: {},
      complete: true,
      boundaryReached: false,
      checkpoint: { ids: ["new"] },
    };
  };
  await f.service.fetchAdapter(
    "item",
    "run",
    f.account,
    f.snapshot,
    source,
    null,
    new AbortController().signal,
  );
  assert.equal(reads, 2);
  assert.deepEqual(f.live.discoveryCheckpointJson, { ids: ["new"] });
});

test("adapter cursor changes cannot replace the service window or its observed provenance", async () => {
  const f = fixture();
  const cursors: any[] = [];
  const source = {
    ...client,
    initialCursor: () => ({ startTime: "2026-10-01T00:00:00.000Z" }),
    fetchPage: async (_account: unknown, cursor: any) => {
      cursors.push(cursor);
      return {
        items: [],
        complete: cursors.length === 2,
        boundaryReached: false,
        nextCursor: {
          startTime: "2098-01-01T00:00:00.000Z",
          endTime: "2099-01-01T00:00:00.000Z",
          _sourceScanWindow: { sourceId: "forged" },
          _sourceWindowWatermark: {
            externalId: "forged",
            publishedAt: "2099-01-01T00:00:00.000Z",
          },
        },
      };
    },
  };
  await f.service.fetchAdapter(
    "item",
    "run",
    f.account,
    f.snapshot,
    source,
    null,
    new AbortController().signal,
  );
  assert.equal(cursors[1].startTime, cursors[0].startTime);
  assert.equal(cursors[1].endTime, cursors[0].endTime);
  assert.deepEqual(cursors[1]._sourceScanWindow, cursors[0]._sourceScanWindow);
  assert.equal(cursors[1]._sourceWindowWatermark, undefined);
  assert.equal(f.live.highWaterPublishedAt, null);
});

test("a changed source, adapter or window binding is rejected before requesting a page", async () => {
  const startTime = "2026-10-01T00:00:00.000Z";
  const endTime = "2026-10-02T00:00:00.000Z";
  for (const change of [
    { sourceId: "2" },
    { adapterKey: "different" },
    { startTime: "2026-09-01T00:00:00.000Z" },
    { endTime: "2026-10-03T00:00:00.000Z" },
  ]) {
    const f = fixture();
    f.snapshot.cursorJson = {
      startTime,
      endTime,
      _sourceScanWindow: {
        sourceId: "1",
        adapterKey: "synthetic",
        firstSyncMode: "none",
        startTime,
        endTime,
        ...change,
      },
    };
    const source = {
      ...client,
      fetchPage: async () => {
        assert.fail("invalid binding reached adapter");
      },
    };
    await assert.rejects(
      f.service.fetchAdapter(
        "item",
        "run",
        f.account,
        f.snapshot,
        source,
        null,
        new AbortController().signal,
      ),
      /window binding changed/,
    );
    assert.equal(f.live.completedThroughAt, null);
  }
});

test("changing the first window before success restarts from its new configuration", async () => {
  const f = fixture();
  const startTime = "2026-10-01T00:00:00.000Z";
  const endTime = "2026-10-02T00:00:00.000Z";
  f.snapshot.cursorJson = {
    startTime,
    endTime,
    page: 8,
    _sourceScanWindow: {
      sourceId: "1",
      adapterKey: "synthetic",
      firstSyncMode: "last_24_hours",
      startTime,
      endTime,
    },
  };
  const source = {
    ...client,
    initialCursor: (_mode: string, now: Date) => ({
      startTime: now.toISOString(),
    }),
    fetchPage: async (_account: unknown, cursor: any) => {
      assert.equal(cursor.startTime, cursor.endTime);
      assert.equal(cursor.page, undefined);
      assert.notEqual(cursor.endTime, endTime);
      return { items: [], nextCursor: {}, complete: true };
    },
  };
  await f.service.fetchAdapter(
    "item",
    "run",
    f.account,
    f.snapshot,
    source,
    null,
    new AbortController().signal,
  );
  assert.ok(f.live.completedThroughAt > new Date(endTime));
});

test("invalid or oversized terminal discovery checkpoints cannot advance coverage", async () => {
  for (const checkpoint of [[], { large: "x".repeat(4 * 1024 * 1024) }]) {
    const f = fixture();
    const source = {
      ...client,
      fetchPage: async () => ({
        items: [],
        nextCursor: {},
        complete: true,
        checkpoint,
      }),
    };
    await assert.rejects(
      f.service.fetchAdapter(
        "item",
        "run",
        f.account,
        f.snapshot,
        source,
        null,
        new AbortController().signal,
      ),
      /checkpoint is invalid/,
    );
    assert.equal(f.live.completedThroughAt, null);
    assert.deepEqual(f.live.discoveryCheckpointJson, {});
  }
});

test("a resumed scan retains its observed watermark and ignores an adapter-supplied checkpoint", async () => {
  const startTime = "2026-10-01T00:00:00.000Z";
  let resumed = false;
  let reads = 0;
  const source = {
    ...client,
    initialCursor: () => ({ startTime }),
    prepareCursor: (_account: unknown, cursor: unknown) => cursor,
    fetchPage: async () => {
      if (resumed)
        return { items: [], nextCursor: { startTime }, complete: true };
      if (++reads > 1) throw new Error("synthetic network interruption");
      return {
        items: [{ ...content("verified-post"), ownMedia: [] }],
        nextCursor: {
          startTime,
          _sourceWindowWatermark: {
            sourceId: "1",
            adapterKey: "synthetic",
            startTime,
            publishedAt: "2099-01-01T00:00:00.000Z",
            externalId: "forged",
          },
        },
        complete: false,
        boundaryReached: false,
      };
    },
  };
  const f = fixture(source);
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    ),
    /synthetic network interruption/,
  );
  assert.equal(f.live.highWaterPublishedAt, null);
  assert.equal(
    f.live.cursorJson._sourceWindowWatermark.publishedAt,
    "2026-10-02T00:00:00.000Z",
  );
  resumed = true;
  Object.assign(f.snapshot, f.live);
  await f.service.fetchAdapter(
    "item",
    "run",
    f.account,
    f.snapshot,
    source,
    null,
    new AbortController().signal,
  );
  assert.equal(
    f.live.highWaterPublishedAt.toISOString(),
    "2026-10-02T00:00:00.000Z",
  );
  assert.equal(f.live.highWaterExternalId, "verified-post");
});

test("unbound or noncanonical scan watermarks cannot advance the source", async () => {
  const startTime = "2026-10-01T00:00:00.000Z";
  const source = {
    ...client,
    prepareCursor: (_account: unknown, cursor: unknown) => cursor,
    fetchPage: async () => ({
      items: [],
      nextCursor: { startTime },
      complete: true,
    }),
  };
  for (const change of [
    { sourceId: "different" },
    { adapterKey: "different" },
    { startTime: "2026-09-01T00:00:00.000Z" },
    { publishedAt: "2026-10-02" },
    { publishedAt: "2026-09-01T00:00:00.000Z" },
    { externalId: "" },
  ]) {
    const f = fixture(source);
    f.snapshot.cursorJson = {
      startTime,
      _sourceWindowWatermark: {
        sourceId: "1",
        adapterKey: "synthetic",
        startTime,
        publishedAt: "2026-10-02T00:00:00.000Z",
        externalId: "verified-post",
        ...change,
      },
    };
    await f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    );
    assert.equal(f.live.highWaterPublishedAt, null);
    assert.equal(f.live.highWaterExternalId, null);
  }
});

test("the hundred-page guard retains a checkpoint that a later run can complete", async () => {
  const startTime = "2026-10-01T00:00:00.000Z";
  const source = {
    ...client,
    initialCursor: () => ({ startTime, page: 0 }),
    prepareCursor: (_account: unknown, cursor: unknown) => cursor,
    fetchPage: async (_account: unknown, cursor: any) => ({
      items: cursor.page === 0 ? [{ ...content("900"), ownMedia: [] }] : [],
      nextCursor: { startTime, page: cursor.page + 1 },
      complete: cursor.page === 100,
      boundaryReached: false,
    }),
  };
  const f = fixture(source);
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    ),
    /pagination exceeded the safety limit/,
  );
  assert.equal(f.live.cursorJson.page, 100);
  assert.equal(f.live.highWaterPublishedAt, null);
  assert.equal(f.live.completedThroughAt, null);
  const retainedUpper = f.live.cursorJson.endTime;
  Object.assign(f.snapshot, f.live);
  await f.service.fetchAdapter(
    "item",
    "run",
    f.account,
    f.snapshot,
    source,
    null,
    new AbortController().signal,
  );
  assert.equal(
    f.live.highWaterPublishedAt.toISOString(),
    "2026-10-02T00:00:00.000Z",
  );
  assert.equal(f.live.highWaterExternalId, "900");
  assert.equal(f.live.completedThroughAt.toISOString(), retainedUpper);
  assert.deepEqual(f.live.cursorJson, {});
  assert.equal(f.row.pagesFetched, 101);
});

test("a recovered same-second watermark keeps the greater external ID without rolling state back", async () => {
  const startTime = "2026-10-01T00:00:00.000Z";
  const endTime = "2026-10-03T00:00:00.000Z";
  const source = {
    ...client,
    prepareCursor: (_account: unknown, cursor: unknown) => cursor,
    fetchPage: async () => ({
      items: [],
      nextCursor: { startTime },
      complete: true,
    }),
  };
  for (const [prior, recovered] of [
    ["900", "901"],
    ["902", "901"],
  ]) {
    const f = fixture(source);
    f.snapshot.highWaterPublishedAt = new Date("2026-10-02T00:00:00.000Z");
    f.snapshot.highWaterExternalId = prior;
    f.snapshot.cursorJson = {
      startTime,
      endTime,
      _sourceScanWindow: {
        sourceId: "1",
        adapterKey: "synthetic",
        firstSyncMode: "none",
        startTime,
        endTime,
      },
      _sourceWindowWatermark: {
        sourceId: "1",
        adapterKey: "synthetic",
        startTime,
        endTime,
        publishedAt: "2026-10-02T00:00:00.000Z",
        externalId: recovered,
      },
    };
    await f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    );
    assert.equal(f.live.highWaterExternalId, prior === "900" ? "901" : "902");
  }
});

test("revocation during a media store purges its original and commits no page candidates", async () => {
  const f = fixture();
  const store = f.files.store;
  f.files.store = async () => {
    const stored = await store();
    f.revoke();
    return stored;
  };
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      client,
      null,
      new AbortController().signal,
    ),
    /Source account changed/,
  );
  assert.deepEqual(f.committed, []);
  assert.equal(f.downloads, 1);
  assert.deepEqual(f.purged, ["file1"]);
});

test("a replaced lease prevents the next media download within the same candidate", async () => {
  const source = {
    ...client,
    fetchPage: async () => ({
      items: [content("1", 2)],
      nextCursor: {},
      complete: true,
    }),
  };
  const f = fixture(source);
  const store = f.files.store;
  f.files.store = async () => {
    const stored = await store();
    f.live.fetchLeaseId = "replacement";
    return stored;
  };
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      null,
      new AbortController().signal,
    ),
    /Source account changed/,
  );
  assert.equal(f.downloads, 1);
  assert.deepEqual(f.committed, []);
  assert.deepEqual(f.purged, ["file1"]);
});

test("a long multi-image page keeps its current source lease alive until completion", async () => {
  const f = fixture();
  const now = new Date("2026-10-27T04:00:00.000Z");
  const clock = test.mock.timers;
  clock.enable({ apis: ["Date"], now });
  f.live.fetchLeaseUntil = new Date(now.getTime() + 30 * 60_000);
  f.snapshot.fetchLeaseUntil = f.live.fetchLeaseUntil;
  const renewals: Date[] = [];
  const update = f.db.sourceAdapterState.updateMany;
  f.db.sourceAdapterState.updateMany = async (input: any) => {
    if (input.data.fetchLeaseUntil) renewals.push(new Date());
    return update(input);
  };
  f.downloader.download = async () => {
    clock.tick(1000);
    return { body: Buffer.from("synthetic"), contentType: "image/png" };
  };
  const store = f.files.store;
  f.files.store = async () => {
    clock.tick(1000);
    return store();
  };
  try {
    await f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      {
        ...client,
        fetchPage: async () => ({
          items: [content("long-manga", 1000)],
          complete: true,
          nextCursor: {},
        }),
      },
      null,
      new AbortController().signal,
    );
    assert.deepEqual(f.committed, ["long-manga"]);
    assert.equal(f.row.mediaStored, 1000);
    assert.equal(f.row.status, "succeeded");
    assert.equal(f.live.completedThroughAt.toISOString(), now.toISOString());
    assert.equal(f.purged.length, 0);
    assert.ok(renewals.length >= 6 && renewals.length <= 7);
    for (let i = 1; i < renewals.length - 1; i++)
      assert.ok(
        renewals[i].getTime() - renewals[i - 1].getTime() >= 5 * 60_000,
      );
  } finally {
    clock.reset();
  }
});

for (const change of [
  "revoked",
  "actor",
  "replacement",
  "expired",
  "worker",
] as const)
  test(`a long-page lease renewal cannot overwrite ${change} ownership`, async () => {
    const f = fixture();
    const now = new Date("2026-10-27T04:00:00.000Z");
    const clock = test.mock.timers;
    clock.enable({ apis: ["Date"], now });
    f.live.fetchLeaseUntil = new Date(now.getTime() + 30 * 60_000);
    f.snapshot.fetchLeaseUntil = f.live.fetchLeaseUntil;
    const store = f.files.store;
    f.files.store = async () => {
      clock.tick(5 * 60_000);
      if (change === "revoked") f.revoke();
      if (change === "actor") f.revokeActor();
      if (change === "replacement") f.live.fetchLeaseId = "replacement";
      if (change === "expired") f.live.fetchLeaseUntil = new Date();
      if (change === "worker")
        f.jobs.assertCurrentLease = async () => {
          throw new Error("worker lease changed");
        };
      return store();
    };
    try {
      await assert.rejects(
        f.service.fetchAdapter(
          "item",
          "run",
          f.account,
          f.snapshot,
          client,
          "actor",
          new AbortController().signal,
        ),
        /changed|权限已失效/,
      );
      assert.equal(f.live.completedThroughAt, null);
      assert.equal(f.committed.length, 0);
      assert.equal(f.purged.length, 1);
      assert.equal(
        f.live.fetchLeaseId,
        change === "replacement" ? "replacement" : "run",
      );
      assert.equal(
        f.live.fetchLeaseUntil.getTime(),
        now.getTime() + (change === "expired" ? 5 : 30) * 60_000,
      );
    } finally {
      clock.reset();
    }
  });

test("existing-candidate observations cannot be written after revocation", async () => {
  const f = fixture();
  f.db.candidatePost.findUnique = async () => {
    f.revoke();
    return { id: "existing" };
  };
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      client,
      null,
      new AbortController().signal,
    ),
    /Source account changed/,
  );
  assert.equal(f.observations, 0);
});

test("actor revocation after an existing lookup prevents observations, cursor and watermark writes", async () => {
  const f = fixture();
  f.db.candidatePost.findUnique = async () => {
    f.revokeActor();
    return { id: "existing" };
  };
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      client,
      "actor",
      new AbortController().signal,
    ),
    /权限已失效/,
  );
  assert.equal(f.observations, 0);
  assert.equal(f.live.highWaterPublishedAt, null);
  assert.equal(f.live.cursorJson.done, undefined);
  assert.equal(f.live.completedThroughAt, null);
  assert.notEqual(f.row.status, "succeeded");
});

test("actor revocation on a duplicate insert prevents the P2002 observation path", async () => {
  const f = fixture();
  f.db.candidatePost.create = async () => {
    f.revokeActor();
    throw new Prisma.PrismaClientKnownRequestError(
      "synthetic unique conflict",
      { code: "P2002", clientVersion: "synthetic" },
    );
  };
  f.db.candidatePost.findUniqueOrThrow = async () => ({ id: "existing" });
  await assert.rejects(
    f.service.saveCandidate(
      f.account,
      f.snapshot,
      client,
      content("1"),
      "actor",
      "run",
      new AbortController().signal,
    ),
    /权限已失效/,
  );
  assert.equal(f.observations, 0);
  assert.deepEqual(f.purged, ["file1"]);
});

test("actor revocation after a page commit prevents successful watermark completion", async () => {
  const source = {
    ...client,
    fetchPage: async () => ({
      items: [],
      nextCursor: { done: true },
      complete: true,
    }),
  };
  const f = fixture(source);
  const update = f.db.sourceFetchRunItem.update;
  f.db.sourceFetchRunItem.update = async (input: any) => {
    const result = await update(input);
    if (input.data.pagesFetched) f.revokeActor();
    return result;
  };
  await assert.rejects(
    f.service.fetchAdapter(
      "item",
      "run",
      f.account,
      f.snapshot,
      source,
      "actor",
      new AbortController().signal,
    ),
    /权限已失效/,
  );
  assert.equal(f.live.highWaterPublishedAt, null);
  assert.notEqual(f.live.health, "healthy");
  assert.notEqual(f.row.status, "succeeded");
});

for (const change of ["replacement", "admin_reset"] as const)
  test(`a stale failure preserves ${change} state and never invokes paid fallback`, async () => {
    const f = fixture();
    let fallbackCalls = 0;
    const paid = { ...client, adapterKey: "paid", priority: 2, metered: true };
    f.account.adapterStates.push({
      ...f.snapshot,
      id: "paid-state",
      adapterKey: "paid",
    });
    f.service.sources.register(paid);
    f.service.fetchAdapter = async (
      _item: string,
      _run: string,
      _account: unknown,
      _state: unknown,
      source: any,
    ) => {
      if (source.metered) {
        fallbackCalls++;
        return;
      }
      if (change === "replacement") f.live.fetchLeaseId = "replacement";
      else
        Object.assign(f.live, {
          revision: 3,
          fetchLeaseId: null,
          health: "idle",
          consecutiveFailures: 0,
          nextAttemptAt: null,
        });
      throw new Error("stale failure");
    };
    await f.service.fetchWithFallback(
      "run",
      f.account,
      null,
      new AbortController().signal,
    );
    assert.equal(fallbackCalls, 0);
    assert.equal(f.live.health, "idle");
    assert.equal(f.live.consecutiveFailures, change === "replacement" ? 2 : 0);
    assert.equal(
      f.live.fetchLeaseId,
      change === "replacement" ? "replacement" : null,
    );
  });

test("interrupted items clear their current errors on running and success while logging recovery", async () => {
  const source = {
    ...client,
    fetchPage: async () => ({ items: [], nextCursor: {}, complete: true }),
  };
  const f = fixture(source);
  Object.assign(f.row, {
    status: "failed",
    errorCode: "interrupted",
    errorMessage: "interrupted",
    pagesFetched: 2,
  });
  f.db.sourceFetchRunItem.findUnique = async () => ({ ...f.row });
  const messages: string[] = [];
  const original = console.info;
  console.info = (message: string) => {
    messages.push(message);
  };
  try {
    const fetchPage = source.fetchPage;
    source.fetchPage = async () => {
      assert.equal(f.row.errorCode, null);
      assert.equal(f.row.errorMessage, null);
      return fetchPage();
    };
    await f.service.fetchWithFallback(
      "run",
      f.account,
      null,
      new AbortController().signal,
    );
    assert.equal(f.row.status, "succeeded");
    assert.equal(f.row.errorCode, null);
    assert.equal(f.row.errorMessage, null);
    assert.ok(
      messages.some(
        (message) => JSON.parse(message).event === "adapter_resumed",
      ),
    );
    assert.equal(f.row.pagesFetched, 3);
  } finally {
    console.info = original;
  }
});

function manualFixture() {
  const jobs: any[] = [];
  const runs: any[] = [];
  const leases: any[] = [];
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === "OR") return value.some((part: any) => matches(row, part));
      if (value && typeof value === "object") {
        if (value.in) return value.in.includes(row[key]);
        if (value.not !== undefined) return row[key] !== value.not;
        if (value.lt !== undefined) return row[key] < value.lt;
        if (value.lte !== undefined) return row[key] <= value.lte;
        if (value.gte !== undefined) return row[key] >= value.gte;
        if (value.gt !== undefined) return row[key] > value.gt;
      }
      return value === null ? row[key] == null : row[key] === value;
    });
  let tail: Promise<unknown> = Promise.resolve();
  const db: any = {
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    user: { count: async () => 1 },
    authorExternalAccount: {
      findMany: async ({ where }: any) =>
        [...new Set(where.id?.in ?? ["a", "b"])].map((id) => ({ id })),
    },
    sourceFetchRun: {
      create: async ({ data }: any) => {
        const run = { id: `run${runs.length}`, ...data };
        runs.push(run);
        return run;
      },
      findMany: async ({ where }: any) =>
        runs.filter((run) => matches(run, where)),
      updateMany: async ({ where, data }: any) => {
        const rows = runs.filter((run) => matches(run, where));
        rows.forEach((run) => Object.assign(run, data));
        return { count: rows.length };
      },
    },
    sourceFetchRunItem: { updateMany: async () => ({ count: 1 }) },
    sourceAdapterState: {
      findMany: async ({ where }: any) =>
        leases.filter((lease) => matches(lease, where)),
      updateMany: async ({ where, data }: any) => {
        const rows = leases.filter((lease) => matches(lease, where));
        rows.forEach((lease) => Object.assign(lease, data));
        return { count: rows.length };
      },
    },
    backgroundJob: {
      findMany: async ({ where }: any) =>
        jobs.filter((job) => matches(job, where)),
      findFirst: async ({ where }: any) =>
        jobs.find((job) => matches(job, where)) ?? null,
      update: async ({ where, data }: any) =>
        Object.assign(
          jobs.find((job) => matches(job, where)),
          data,
        ),
    },
  };
  db.$transaction = (fn: any) => {
    const result = tail.then(() => fn(db));
    tail = result.catch(() => {});
    return result;
  };
  const service: any = new SourceFetchService(
    {
      enqueue: async (job: any) => {
        jobs.push({
          id: `job${jobs.length}`,
          ...job,
          status: "queued",
          attempts: 0,
        });
      },
    } as any,
    db,
    null as any,
    null as any,
    null as any,
    null as any,
    environment as any,
  );
  service.get = async (id: string) => runs.find((row) => row.id === id);
  return { service, jobs, runs, leases };
}

test("manual clicks from different actors reuse the same normalized active account set", async () => {
  const f = manualFixture();
  const results = await Promise.all([
    f.service.runManual("actor1", { accountIds: ["b", "a", "a"] }),
    f.service.runManual("actor2", { accountIds: ["a", "b"] }),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(f.jobs.length, 1);
});

test("overlapping different account sets conflict while disjoint accounts can queue", async () => {
  const f = manualFixture();
  await f.service.runManual("actor1", { accountIds: ["a"] });
  await assert.rejects(
    f.service.runManual("actor2", { accountIds: ["a", "b"] }),
    (error: any) => error.getStatus?.() === 409,
  );
  await f.service.runManual("actor2", { accountIds: ["b"] });
  assert.equal(f.jobs.length, 2);
});

test("empty accountIds means all eligible accounts, and retrying active jobs are reused", async () => {
  const f = manualFixture();
  const first = await f.service.runManual("actor1", { accountIds: [] });
  f.jobs[0].attempts = 2;
  const second = await f.service.runManual("actor2", {});
  assert.equal(first.id, second.id);
  assert.equal(f.jobs.length, 1);
});

for (const terminal of ["failed", "queued", "running"] as const)
  test(`manual retry settles ${terminal} exhausted ownership before creating a new batch`, async () => {
    const f = manualFixture();
    const first = await f.service.runManual("actor", { accountIds: ["a"] });
    Object.assign(f.jobs[0], {
      status: terminal,
      attempts: 3,
      leaseId: "old-worker",
      leaseUntil: new Date(0),
    });
    f.leases.push({
      externalAccountId: "a",
      fetchLeaseId: first.id,
      fetchLeaseUntil: new Date(Date.now() + 30 * 60_000),
      cursorJson: { page: 7 },
    });
    const next = await f.service.runManual("actor", { accountIds: ["a"] });
    assert.notEqual(next.id, first.id);
    assert.equal(f.leases[0].fetchLeaseId, null);
    assert.equal(f.leases[0].fetchLeaseUntil, null);
    assert.deepEqual(f.leases[0].cursorJson, { page: 7 });
    assert.equal(f.jobs[0].status, "failed");
    assert.equal(f.runs[0].status, "failed");
    assert.ok(f.runs[0].completedAt);
  });

test("a live final-attempt execution is reused and its source lease remains owned", async () => {
  const f = manualFixture();
  const first = await f.service.runManual("actor", { accountIds: ["a"] });
  Object.assign(f.jobs[0], {
    status: "running",
    attempts: 3,
    leaseId: "live-worker",
    leaseUntil: new Date(Date.now() + 60_000),
  });
  f.leases.push({
    externalAccountId: "a",
    fetchLeaseId: first.id,
    fetchLeaseUntil: new Date(Date.now() + 30 * 60_000),
  });
  assert.equal(
    (await f.service.runManual("actor", { accountIds: ["a"] })).id,
    first.id,
  );
  assert.equal(f.leases[0].fetchLeaseId, first.id);
  assert.equal(f.jobs[0].status, "running");
});
