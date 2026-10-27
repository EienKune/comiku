import assert from "node:assert/strict";
import test from "node:test";
import { GalleryDlContentSource } from "../src/source-ingestion/adapters/gallery-dl/gallery-dl-content-source.js";

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
