import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GalleryDlContentSource,
  galleryProcessResult,
} from "../src/source-ingestion/adapters/gallery-dl/gallery-dl-content-source.js";
import { sourceDiagnostic } from "../src/source-ingestion/source-diagnostics.js";

test("gallery consumption omits malformed percent UTF8 without losing stage", async () => {
  for (const bytes of [
    "%FF",
    "%C3",
    "%E0%A4",
    "%F0%9F",
    "%E2%28%A1",
    "%ED%A0%80",
    "%25FF",
  ]) {
    const message = `https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3Dfirst${bytes}privatesuffix`;
    const source = new GalleryDlContentSource(
      "x",
      { python: "/none", configPath: "/absent/qa.json" },
      async () =>
        page({
          error: "auth_failed",
          diagnostic: { stage: "enumeration", message },
        }),
    );
    await assert.rejects(
      source.fetchPage(account, initial),
      (error: unknown) => {
        assert.deepEqual(sourceDiagnostic(error).diagnostic, {
          stage: "enumeration",
          message: "[diagnostic omitted]",
        });
        return true;
      },
    );
  }
});

test("gallery consumption suppresses suffixes after encoded URL and sensitive JSON delimiters", async () => {
  for (const message of [
    "https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3Dfirst%0Aprivatesuffix",
    "https:\\u002f\\u002fexample.invalid/path?q=first\\u000aprivatesuffix",
    '{"access_token":"first\\u000aprivatesuffix"}',
    '{"access_token":"first\\u000dprivatesuffix"}',
    '{"access_token":"first\\u0022privatesuffix"}',
  ]) {
    const source = new GalleryDlContentSource(
      "x",
      { python: "/none", configPath: "/absent/qa.json" },
      async () =>
        page({
          error: "auth_failed",
          diagnostic: { stage: "enumeration", message },
        }),
    );
    await assert.rejects(
      source.fetchPage(account, initial),
      (error: unknown) => {
        const result = sourceDiagnostic(error);
        assert.equal(JSON.stringify(result).includes("privatesuffix"), false);
        assert.equal(
          (result.diagnostic as Record<string, string>).stage,
          "enumeration",
        );
        assert.equal(
          (result.diagnostic as Record<string, string>).message,
          "[diagnostic omitted]",
        );
        return true;
      },
    );
  }
});

test("trusted synthetic config and cookie values are suppressed at the bridge consumption boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "comiku-diagnostic-test-"));
  try {
    const configPath = join(directory, "synthetic-config.json");
    const cookiePath = join(directory, "synthetic-cookies.txt");
    await writeFile(
      configPath,
      JSON.stringify({
        extractor: {
          pixiv: { "refresh-token": "synthetic-pixiv-credential" },
          twitter: { cookies: cookiePath },
        },
      }),
    );
    await writeFile(
      cookiePath,
      ".example.invalid\tTRUE\t/\tTRUE\t0\tauth_token\tsynthetic-cookie-credential\n",
    );
    const bridge = new GalleryDlContentSource(
      "x",
      { python: "/synthetic/python", configPath },
      async () =>
        page({
          error: "auth_failed",
          diagnostic: {
            stage: "enumeration",
            message: [
              configPath,
              cookiePath,
              "synthetic-pixiv-credential",
              "synthetic-cookie-credential",
            ].join("\n"),
          },
        }),
    );
    await assert.rejects(
      bridge.fetchPage(account, initial),
      (error: unknown) => {
        const text = JSON.stringify(sourceDiagnostic(error));
        for (const secret of [
          configPath,
          cookiePath,
          "synthetic-pixiv-credential",
          "synthetic-cookie-credential",
        ])
          assert.equal(text.includes(secret), false);
        assert.equal(sourceDiagnostic(error).reason, "auth_failed");
        assert.equal(
          (sourceDiagnostic(error).diagnostic as Record<string, string>).stage,
          "enumeration",
        );
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner diagnostics distinguish exit, timeout, spawn, output cap and malformed JSON", () => {
  for (const [error, reason] of [
    [{ code: 2 }, "process_exit"],
    [{ killed: true, signal: "SIGTERM" }, "process_timeout"],
    [{ code: "ENOENT" }, "process_start"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "process_output_limit"],
    [null, "invalid_json"],
  ] as const) {
    assert.throws(
      () =>
        galleryProcessResult(
          error,
          "bad JSON secret-fixture",
          "Authorization: secret-fixture\nfailed",
          10,
          ["secret-fixture"],
        ),
      (failure: unknown) => {
        const detail = sourceDiagnostic(failure);
        assert.equal(detail.reason, reason);
        assert.equal(JSON.stringify(detail).includes("secret-fixture"), false);
        assert.equal(
          (detail.diagnostic as Record<string, string>).duration,
          "10",
        );
        return true;
      },
    );
  }
});

test("native failures preserve credential versus source scope without publishing diagnostics", async () => {
  for (const [reason, scope] of [
    ["auth_failed", "credential"],
    ["challenge_required", "credential"],
    ["source_forbidden", "source"],
    ["not_found", "source"],
    ["source_not_found", "source"],
    ["post_not_found", "post"],
    ["network_error", "transport"],
  ]) {
    await assert.rejects(
      client([
        page({
          error: reason,
          diagnostic: {
            stage: "enumeration",
            message: "private fixture",
            payload: "never",
          },
        }),
      ]).fetchPage(account, initial),
      (error: unknown) => {
        assert.equal(sourceDiagnostic(error).reason, reason);
        assert.equal(sourceDiagnostic(error).failureScope, scope);
        assert.equal(JSON.stringify(error).includes("private fixture"), false);
        return true;
      },
    );
  }
});

const account = { externalUserId: "798688505224273920", handle: "example" };
const initial = { startTime: "2026-10-24T00:00:00.000Z" };
const page = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  platform: "x",
  source_id: account.externalUserId,
  records: [],
  failed_ids: [],
  next: "next-page",
  terminal: false,
  page_complete: true,
  boundary: true,
  neutral: false,
  order_anomaly: false,
  first_date: "2026-10-23T12:00:00Z",
  last_date: "2026-10-23T10:00:00Z",
  coverage: {
    ordinary: 2,
    owned_context: 0,
    foreign: 0,
    excluded_retweet: 0,
    quoted_context: 0,
    recent: 0,
    unknown_date: 0,
    ignored_pins: 0,
  },
  ...extra,
});
const client = (pages: Record<string, unknown>[]) =>
  new GalleryDlContentSource(
    "x",
    {
      python: "/python",
      configPath: "/private/config.json",
    },
    async () => pages.shift()!,
  );

test("one old page cannot finish a gallery scan; two ordered old pages can", async () => {
  const c = client([
    page(),
    page({
      next: "page-3",
      first_date: "2026-10-22T12:00:00Z",
      last_date: "2026-10-22T10:00:00Z",
    }),
  ]);
  const first = await c.fetchPage(account, initial);
  assert.equal(first.complete, false);
  assert.equal(first.boundaryReached, false);
  const second = await c.fetchPage(account, first.nextCursor!);
  assert.equal(second.complete, true);
  assert.equal(second.nextCursor!.startTime, initial.startTime);
});

test("partial pages, mismatched identities and repeated cursors cannot advance coverage", async () => {
  for (const input of [
    page({ page_complete: false }),
    page({ failed_ids: ["11"] }),
    page({ source_id: "123" }),
    page({ error: "auth_failed" }),
  ]) {
    await assert.rejects(client([input]).fetchPage(account, initial));
  }
  const c = client([page(), page()]);
  const first = await c.fetchPage(account, initial);
  await assert.rejects(c.fetchPage(account, first.nextCursor!));
});

test("cross-page out-of-order posts invalidate an apparent time boundary", async () => {
  const c = client([
    page(),
    page({ next: "page-3", first_date: "2026-10-23T11:00:00Z" }),
  ]);
  const first = await c.fetchPage(account, initial);
  const second = await c.fetchPage(account, first.nextCursor!);
  assert.equal(second.complete, false);
  assert.equal(second.nextCursor!.orderUnsafe, true);
});

test("a new worker scan replays from the head while retaining its lower boundary", () => {
  const c = client([]);
  assert.deepEqual(
    c.prepareCursor(account, {
      ...initial,
      sourceId: account.externalUserId,
      providerCursor: "expired",
      oldBatches: 1,
    }),
    { ...initial, sourceId: account.externalUserId },
  );
});

test("Pixiv resumes only a source- and window-bound v3 supplement cursor", () => {
  const c = new GalleryDlContentSource("pixiv", {
    python: "/python",
    configPath: "/private/config.json",
  });
  const providerCursor = {
    _v: 3,
    _phase: "sanity",
    _source: account.externalUserId,
    _cutoff: initial.startTime,
    _until: "2026-10-27T10:00:00+00:00",
    _offset: 100,
  };
  const cursor = {
    ...initial,
    endTime: "2026-10-27T10:00:00Z",
    providerCursor,
  };
  assert.deepEqual(c.prepareCursor(account, cursor), {
    ...cursor,
    sourceId: account.externalUserId,
  });
  for (const changed of [
    { ...providerCursor, _source: "99" },
    { ...providerCursor, _cutoff: "2026-10-20T00:00:00.000Z" },
    { offset: "100" },
  ])
    assert.deepEqual(
      c.prepareCursor(account, { ...cursor, providerCursor: changed }),
      { ...initial, endTime: cursor.endTime, sourceId: account.externalUserId },
    );
});

test("Pixiv passes the frozen upper bound and separate discovery cache through the bridge", async () => {
  const checkpoint = {
    version: 1,
    sourceId: account.externalUserId,
    ids: ["123"],
  };
  const c = new GalleryDlContentSource(
    "pixiv",
    { python: "/python", configPath: "/private/config.json" },
    async (source) => {
      assert.equal(source.until, "2026-10-27T10:00:00Z");
      assert.deepEqual(source.checkpoint, checkpoint);
      return page({
        platform: "pixiv",
        next: null,
        terminal: true,
        checkpoint,
      });
    },
  );
  const result = await c.fetchPage(
    account,
    { ...initial, endTime: "2026-10-27T10:00:00Z" },
    { checkpoint },
  );
  assert.deepEqual(result.checkpoint, checkpoint);
  assert.equal(result.nextCursor?.endTime, "2026-10-27T10:00:00Z");
});

test("Pixiv never persists partial, foreign, duplicated or extra-key discovery caches", async () => {
  const valid = { version: 1, sourceId: account.externalUserId, ids: ["123"] };
  for (const [checkpoint, terminal] of [
    [valid, false],
    [{ ...valid, sourceId: "99" }, true],
    [{ ...valid, ids: ["123", "123"] }, true],
    [{ ...valid, credential: "fixture-private" }, true],
  ] as const) {
    const c = new GalleryDlContentSource(
      "pixiv",
      { python: "/python", configPath: "/private/config.json" },
      async () =>
        page({
          platform: "pixiv",
          checkpoint,
          terminal,
          next: terminal ? null : "next",
        }),
    );
    await assert.rejects(c.fetchPage(account, initial));
  }
});

test("gallery fixed windows exclude future and old records before candidate normalization escapes", async () => {
  const records = [
    "2026-10-24 00:00:00",
    "2026-10-23 23:59:59",
    "2026-10-25 00:00:00",
  ].map((date, index) => [
    2,
    {
      tweet_id: String(10 + index),
      author: { id: account.externalUserId },
      date,
      count: 0,
    },
  ]);
  const result = await client([
    page({ records, terminal: true, next: null, boundary: false }),
  ]).fetchPage(account, { ...initial, endTime: "2026-10-25T00:00:00Z" });
  assert.deepEqual(
    result.items.map((item) => item.externalContentId),
    ["10"],
  );
});

test("Pixiv cursor drift replays the same window once, without retrying network errors", async () => {
  const calls: unknown[] = [];
  const c = new GalleryDlContentSource(
    "pixiv",
    { python: "/python", configPath: "/private/config.json" },
    async (source, cursor) => {
      calls.push({ source, cursor });
      return cursor
        ? { error: "cursor_invalid" }
        : page({
            platform: "pixiv",
            boundary: false,
            next: { _v: 2, _phase: "app" },
          });
    },
  );
  const result = await c.fetchPage(account, {
    ...initial,
    providerCursor: { _v: 2, _phase: "sanity" },
  });
  assert.equal(calls.length, 2);
  assert.equal((calls[1] as { cursor: unknown }).cursor, null);
  assert.equal(
    (calls[1] as { source: { cutoff: string } }).source.cutoff,
    initial.startTime,
  );
  assert.equal(result.complete, false);
  let networkCalls = 0;
  const failing = new GalleryDlContentSource(
    "pixiv",
    { python: "/python", configPath: "/private/config.json" },
    async () => {
      networkCalls++;
      return { error: "network_error" };
    },
  );
  await assert.rejects(
    failing.fetchPage(account, { ...initial, providerCursor: {} }),
    /暂时不可用/,
  );
  assert.equal(networkCalls, 1);
});

test("string IDs preserve all digits and only owned original photos become media", async () => {
  const metadata = {
    tweet_id: "2114345454486143109",
    author: { id: account.externalUserId },
    date: "2026-10-25 13:16:53",
    retweet_id: "0",
    quoted_id: "0",
    reply_id: "0",
    quote_id: "0",
    content: "Example",
    count: 1,
  };
  const c = client([
    page({
      boundary: false,
      records: [
        [2, metadata],
        [
          3,
          "https://pbs.twimg.com/media/example.jpg:orig",
          {
            ...metadata,
            extension: "jpg",
            filename: "example",
            type: "photo",
            num: 1,
            width: 100,
            height: 200,
          },
        ],
      ],
    }),
  ]);
  const result = await c.fetchPage(account, initial);
  assert.equal(result.items[0].externalContentId, "2114345454486143109");
  assert.equal(result.items[0].publishedAt, "2026-10-25T13:16:53.000Z");
  assert.equal(result.items[0].ownMedia.length, 1);
  assert.match(result.items[0].ownMedia[0].url, /:orig$/);
  await assert.rejects(
    client([
      page({
        records: [
          [2, { ...metadata, tweet_id: Number("2114345454486143109") }],
        ],
      }),
    ]).fetchPage(account, initial),
  );
});

test("native authored quotes retain their own attachments and referenced target", async () => {
  const metadata = {
    tweet_id: "2114345454486143109",
    author: { id: account.externalUserId },
    date: "2026-10-25 13:16:53",
    retweet_id: "0",
    quote_id: "0", // gallery-dl's quoted_by_id_str: expanded context
    quoted_id: "2114345454486143108", // quoted_status_id_str: authored reference
    reply_id: "0",
    count: 1,
  };
  const result = await client([
    page({
      boundary: false,
      records: [
        [2, metadata],
        [
          3,
          "https://pbs.twimg.com/media/own-quote.jpg:orig",
          { ...metadata, type: "photo", extension: "jpg", num: 1 },
        ],
      ],
    }),
  ]).fetchPage(account, initial);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].type, "quote");
  assert.equal(result.items[0].referencedContentId, "2114345454486143108");
  assert.deepEqual(
    result.items[0].ownMedia.map((media) => media.url),
    ["https://pbs.twimg.com/media/own-quote.jpg:orig"],
  );
});

test("native expanded quote context and retweets never become owned candidates", async () => {
  for (const excluded of [
    { quote_id: "2114345454486143109", retweet_id: "0" },
    { quote_id: "0", retweet_id: "2114345454486143109" },
  ]) {
    const metadata = {
      tweet_id: "2114345454486143108",
      author: { id: account.externalUserId },
      date: "2026-10-25 13:16:53",
      quoted_id: "0",
      reply_id: "0",
      count: 1,
      ...excluded,
    };
    const result = await client([
      page({
        boundary: false,
        records: [
          [2, metadata],
          [
            3,
            "https://pbs.twimg.com/media/context.jpg:orig",
            {
              ...metadata,
              type: "photo",
              extension: "jpg",
              num: 1,
            },
          ],
        ],
      }),
    ]).fetchPage(account, initial);
    assert.deepEqual(result.items, []);
  }
});

test("foreign reply authors cannot be normalized as the configured source", async () => {
  await assert.rejects(
    client([
      page({
        records: [
          [
            2,
            {
              tweet_id: "2114345454486143108",
              author: { id: "99" },
              reply_id: "2114345454486143109",
              date: "2026-10-25 13:16:53",
              count: 0,
            },
          ],
        ],
      }),
    ]).fetchPage(account, initial),
  );
});

test("an empty repeated terminal cursor needs prior old coverage and no order anomaly", async () => {
  const terminal = page({
    next: null,
    terminal: true,
    boundary: false,
    neutral: true,
    empty_cursor_repeat: true,
    first_date: null,
    last_date: null,
    coverage: {
      ordinary: 0,
      owned_context: 0,
      foreign: 0,
      excluded_retweet: 0,
      quoted_context: 0,
      recent: 0,
      unknown_date: 0,
      ignored_pins: 0,
    },
  });
  await assert.rejects(client([terminal]).fetchPage(account, initial));
  const c = client([page(), terminal]);
  const first = await c.fetchPage(account, initial);
  assert.equal((await c.fetchPage(account, first.nextCursor!)).complete, true);
});

test("incomplete, duplicated or missing media positions cannot create a partial candidate", async () => {
  const meta = {
    tweet_id: "2114345454486143109",
    author: { id: account.externalUserId },
    date: "2026-10-25 13:16:53",
    count: 2,
    type: "photo",
    extension: "jpg",
    filename: "example",
    num: 1,
  };
  for (const records of [
    [
      [2, meta],
      [3, "https://pbs.twimg.com/media/a.jpg:orig", meta],
    ],
    [
      [2, meta],
      [3, "https://pbs.twimg.com/media/a.jpg:orig", meta],
      [3, "https://pbs.twimg.com/media/b.jpg:orig", meta],
    ],
  ]) {
    await assert.rejects(
      client([page({ terminal: true, next: null, records })]).fetchPage(
        account,
        initial,
      ),
    );
  }
  const records = [
    [2, meta],
    [3, "https://pbs.twimg.com/media/a.jpg:orig", meta],
    [
      3,
      "https://video.twimg.com/movie.mp4",
      { ...meta, num: 2, type: "video", extension: "mp4" },
    ],
  ];
  const result = await client([
    page({ terminal: true, next: null, records }),
  ]).fetchPage(account, initial);
  assert.equal(result.items[0].ownMedia.length, 1);
});

test("Pixiv skips unsupported ugoira without treating it as an incomplete static image", async () => {
  const c = new GalleryDlContentSource(
    "pixiv",
    { python: "/python", configPath: "/private/config.json" },
    async () =>
      page({
        platform: "pixiv",
        terminal: true,
        next: null,
        records: [
          [
            2,
            {
              id: "123",
              user: { id: account.externalUserId },
              type: "ugoira",
              page_count: 1,
              count: 0,
              date: "2026-10-25 13:16:53",
            },
          ],
        ],
      }),
  );
  assert.deepEqual((await c.fetchPage(account, initial)).items, []);
});

test("Pixiv structured tags survive normalization when the title has no hashtags", async () => {
  const metadata = {
    id: "123",
    user: { id: account.externalUserId },
    type: "illust",
    page_count: 1,
    count: 1,
    date: "2026-10-25 13:16:53",
    title: "Fixture title",
    tags: ["ブルーアーカイブ", { name: "漫画", translated_name: "manga" }],
    num: 0,
    extension: "jpg",
  };
  const c = new GalleryDlContentSource(
    "pixiv",
    { python: "/python", configPath: "/private/config.json" },
    async () =>
      page({
        platform: "pixiv",
        terminal: true,
        next: null,
        records: [
          [2, metadata],
          [3, "https://i.pximg.net/img-original/fixture.jpg", metadata],
        ],
      }),
  );
  assert.deepEqual((await c.fetchPage(account, initial)).items[0].hashtags, [
    "ブルーアーカイブ",
    "漫画",
  ]);
});
