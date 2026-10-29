import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ContentSourceClient,
  SourceAccountIdentity,
  SourceAccountProfile,
  SourceCursor,
  SourcePage,
} from "../src/source-ingestion/content-source.js";
import {
  collectHashtags,
  normalizeHashtag,
} from "../src/source-ingestion/hashtags.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
import { XWebSessionContentSourceClient } from "../src/source-ingestion/adapters/x-web-session/x-web-session-content-source.js";

class FixtureSource implements ContentSourceClient {
  readonly platform = "fixture";
  readonly adapterKey = "fixture_default";
  readonly priority = 10;
  readonly metered = false;
  readonly available = true;
  readonly supportedFirstSyncModes = ["none"] as const;
  readonly allowedMediaHosts = ["fixture.invalid"] as const;
  initialCursor() {
    return { page: 0 };
  }
  async checkAccount(
    account: SourceAccountIdentity,
  ): Promise<SourceAccountProfile> {
    return { externalUserId: account.externalUserId, displayName: "Fixture" };
  }
  async fetchPage(
    _account: SourceAccountIdentity,
    cursor: SourceCursor,
  ): Promise<SourcePage> {
    return {
      complete: true,
      nextCursor: { page: Number(cursor.page ?? 0) + 1 },
      items: [
        {
          externalContentId: "content-1",
          type: "reply",
          permalink: "https://fixture.invalid/content-1",
          publishedAt: "2026-09-07T00:00:00.000Z",
          referencedContentId: "content-0",
          ownMedia: [
            {
              externalMediaId: "media-1",
              type: "photo",
              url: "https://fixture.invalid/media-1",
            },
          ],
          rawJson: { fixture: true },
        },
      ],
    };
  }
}

test("content source registry swaps providers without leaking platform cursors", async () => {
  const registry = new ContentSourceRegistry().register(new FixtureSource());
  const client = registry.require(" FIXTURE ");
  assert.equal(
    (await client.checkAccount({ externalUserId: "author-1" })).displayName,
    "Fixture",
  );
  const page = await client.fetchPage(
    { externalUserId: "author-1" },
    { page: 2 },
  );
  assert.deepEqual(page.nextCursor, { page: 3 });
  assert.equal(page.items[0].ownMedia[0].type, "photo");
  assert.equal(page.items[0].referencedContentId, "content-0");
  assert.throws(() => registry.register(new FixtureSource()), /Duplicate/);
  assert.throws(() => registry.require("unknown"), /Unsupported/);
});

test("content source registry keeps adapters independent and ordered by priority", () => {
  const slower = new FixtureSource();
  Object.defineProperties(slower, {
    adapterKey: { value: "fixture_slow" },
    priority: { value: 20 },
  });
  const faster = new FixtureSource();
  Object.defineProperties(faster, {
    adapterKey: { value: "fixture_fast" },
    priority: { value: 5 },
  });
  const registry = new ContentSourceRegistry()
    .register(slower)
    .register(faster);
  assert.deepEqual(
    registry.forPlatform("fixture").map((client) => client.adapterKey),
    ["fixture_fast", "fixture_slow"],
  );
  assert.equal(registry.require("fixture_fast"), faster);
  assert.throws(() => registry.require("fixture"), /Unsupported/);
});

test("hashtags are normalized without treating arbitrary tags as valid", () => {
  assert.deepEqual(normalizeHashtag("＃ブルアカ"), {
    normalizedValue: "ブルアカ",
    displayValue: "ブルアカ",
  });
  assert.equal(normalizeHashtag("two words"), null);
  assert.deepEqual(
    collectHashtags(["BlueArchive"], "#ブルアカ #bluearchive #日常"),
    [
      { normalizedValue: "bluearchive", displayValue: "BlueArchive" },
      { normalizedValue: "ブルアカ", displayValue: "ブルアカ" },
      { normalizedValue: "日常", displayValue: "日常" },
    ],
  );
});

test("X web-session adapter maps own photos and preserves its page cursor", async () => {
  let requested = "";
  const client = new XWebSessionContentSourceClient(
    {
      bearerToken: "public-token",
      authToken: "session-token",
      csrfToken: "csrf-token",
      userMediaQueryId: "query-id",
      features: { fixture: true },
    },
    async (input) => {
      requested = String(input);
      return new Response(
        JSON.stringify({
          data: {
            user: {
              result: {
                timeline_v2: {
                  timeline: {
                    instructions: [
                      {
                        rest_id: "123",
                        legacy: {
                          created_at: "Mon Sep 07 00:00:00 +0000 2026",
                          user_id_str: "author-1",
                          full_text: "new page #BlueArchive",
                          entities: { hashtags: [{ text: "BlueArchive" }] },
                          extended_entities: {
                            media: [
                              {
                                id_str: "media-1",
                                type: "photo",
                                media_url_https:
                                  "https://pbs.twimg.com/media/a.jpg",
                                original_info: { width: 1200, height: 800 },
                              },
                              { id_str: "video-1", type: "video" },
                            ],
                          },
                        },
                      },
                      { cursorType: "Bottom", value: "next-page" },
                    ],
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
    "https://fixture.invalid/graphql",
  );
  const start = client.initialCursor(
    "last_24_hours",
    new Date("2026-09-08T00:00:00Z"),
  );
  assert.deepEqual(start, { startTime: "2026-09-07T00:00:00.000Z" });
  const page = await client.fetchPage(
    { externalUserId: "author-1", handle: "artist" },
    start,
  );
  assert.match(requested, /query-id\/UserMedia/);
  assert.equal(page.items[0].externalContentId, "123");
  assert.deepEqual(page.items[0].hashtags, ["BlueArchive"]);
  assert.equal(page.items[0].ownMedia.length, 1);
  assert.deepEqual(page.nextCursor, {
    startTime: "2026-09-07T00:00:00.000Z",
    bottomCursor: "next-page",
  });
});
