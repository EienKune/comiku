import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";
import { XContentSourceClient } from "../src/source-ingestion/adapters/x-official/x-content-source.js";
import { XWebSessionContentSourceClient } from "../src/source-ingestion/adapters/x-web-session/x-web-session-content-source.js";

test("X adapter maps own photo media, references and durable pagination cursor", async () => {
  const requested: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "102",
            text: "reply with own photo",
            created_at: "2026-09-07T00:00:00.000Z",
            attachments: { media_keys: ["media-1"] },
            referenced_tweets: [{ type: "replied_to", id: "99" }],
          },
          {
            id: "101",
            text: "repost",
            created_at: "2026-09-06T23:59:00.000Z",
            attachments: { media_keys: ["media-2"] },
            referenced_tweets: [{ type: "retweeted", id: "98" }],
          },
        ],
        includes: {
          media: [
            {
              media_key: "media-1",
              type: "photo",
              url: "https://pbs.twimg.com/a.jpg",
            },
            {
              media_key: "media-2",
              type: "video",
              url: "https://pbs.twimg.com/a.mp4",
            },
          ],
        },
        meta: { next_token: "next-page" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new XContentSourceClient(
    "fixture-token",
    fakeFetch,
    "https://x.invalid/2",
  );
  const initial = client.initialCursor(
    "last_24_hours",
    new Date("2026-09-08T00:00:00Z"),
  );
  assert.deepEqual(initial, { startTime: "2026-09-07T00:00:00.000Z" });
  const page = await client.fetchPage(
    { externalUserId: "42", handle: "fixture" },
    initial,
  );
  assert.equal(page.complete, false);
  assert.equal(page.items[0].type, "reply");
  assert.equal(page.items[0].ownMedia.length, 1);
  assert.equal(page.items[0].referencedContentId, "99");
  assert.equal(page.items[1].type, "repost");
  assert.deepEqual(page.nextCursor, {
    startTime: "2026-09-07T00:00:00.000Z",
    paginationToken: "next-page",
    highestSeenId: "102",
  });
  assert.match(requested[0], /start_time=2026-09-07T00%3A00%3A00.000Z/);
  assert.ok(!requested[0].includes("fixture-token"));
});

const webConfig = {
  bearerToken: "secret-bearer",
  authToken: "secret-cookie",
  csrfToken: "secret-csrf",
  userMediaQueryId: "media",
  userByScreenNameQueryId: "profile",
  features: {},
};

for (const kind of ["official", "web"] as const) {
  for (const fixture of [
    {
      status: 200,
      body: { errors: [{ code: 89, message: "secret-cookie" }] },
      code: "authentication",
    },
    { status: 200, body: { errors: [{ code: 88 }] }, code: "rate_limited" },
    {
      status: 200,
      body: { data: [], errors: [{ message: "secret-bearer" }] },
      code: "invalid_response",
    },
    { status: 401, body: {}, code: "authentication" },
    { status: 403, body: {}, code: "authentication" },
    { status: 429, body: {}, code: "rate_limited" },
    { status: 503, body: {}, code: "temporary_failure" },
    { status: 400, body: {}, code: "configuration" },
    { status: 200, body: {}, code: "invalid_response" },
    {
      status: 200,
      body: "invalid json secret-cookie",
      code: "invalid_response",
    },
  ]) {
    test(`${kind} rejects HTTP ${fixture.status} / ${fixture.code} without leaking upstream text`, async () => {
      const fakeFetch = (async () =>
        new Response(
          typeof fixture.body === "string"
            ? fixture.body
            : JSON.stringify(fixture.body),
          { status: fixture.status },
        )) as typeof fetch;
      const client =
        kind === "official"
          ? new XContentSourceClient("secret-bearer", fakeFetch)
          : new XWebSessionContentSourceClient(webConfig, fakeFetch);
      for (const action of [
        () => client.fetchPage({ externalUserId: "42" }, {}),
        () => client.resolveProfileByHandle("fixture"),
      ]) {
        await assert.rejects(
          action,
          (error) =>
            error instanceof SourceResponseError &&
            error.code === fixture.code &&
            !error.message.includes("secret"),
        );
      }
    });
  }
  test(`${kind} accepts a structured empty timeline`, async () => {
    const body =
      kind === "official"
        ? { meta: { result_count: 0 } }
        : {
            data: {
              user: {
                result: { timeline_v2: { timeline: { instructions: [] } } },
              },
            },
          };
    const fakeFetch = (async () => Response.json(body)) as typeof fetch;
    const client =
      kind === "official"
        ? new XContentSourceClient("token", fakeFetch)
        : new XWebSessionContentSourceClient(webConfig, fakeFetch);
    const page = await client.fetchPage(
      { externalUserId: "42" },
      { startTime: "2026-10-04T00:00:00Z" },
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.complete, true);
  });
}

test("web rejects a timeline with missing or repeated pagination", async () => {
  const tweet = {
    rest_id: "123",
    legacy: {
      user_id_str: "42",
      created_at: "2026-10-04T00:00:00Z",
      extended_entities: { media: [] },
    },
  };
  for (const entries of [
    [tweet],
    [tweet, { cursorType: "Bottom", value: "same" }],
  ]) {
    const fakeFetch = (async () =>
      Response.json({
        data: {
          user: {
            result: { timeline_v2: { timeline: { instructions: entries } } },
          },
        },
      })) as typeof fetch;
    const client = new XWebSessionContentSourceClient(webConfig, fakeFetch);
    await assert.rejects(
      () =>
        client.fetchPage({ externalUserId: "42" }, { bottomCursor: "same" }),
      SourceResponseError,
    );
  }
});

test("X adapter resolves a profile by handle with avatar fields", async () => {
  let requested = "";
  const fakeFetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(
      JSON.stringify({
        data: {
          id: "42",
          username: "fixture",
          name: "Fixture Artist",
          profile_image_url: "https://pbs.twimg.com/profile.jpg",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new XContentSourceClient(
    "fixture-token",
    fakeFetch,
    "https://x.invalid/2",
  );
  const profile = await client.resolveProfileByHandle("fixture");
  assert.equal(profile.externalUserId, "42");
  assert.equal(profile.displayName, "Fixture Artist");
  assert.equal(profile.avatarUrl, "https://pbs.twimg.com/profile.jpg");
  assert.match(requested, /users\/by\/username\/fixture/);
  assert.match(requested, /user.fields=profile_image_url/);
});

test("X web-session adapter resolves a profile with its dedicated query", async () => {
  let requested = "";
  const fakeFetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(
      JSON.stringify({
        data: {
          user: {
            result: {
              rest_id: "84",
              legacy: {
                screen_name: "fixture_web",
                name: "Fixture Web Artist",
                profile_image_url_https:
                  "https://pbs.twimg.com/web-profile.jpg",
              },
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new XWebSessionContentSourceClient(
    {
      bearerToken: "bearer",
      authToken: "auth",
      csrfToken: "csrf",
      userMediaQueryId: "media-query",
      userByScreenNameQueryId: "profile-query",
      features: {},
    },
    fakeFetch,
    "https://x.invalid/graphql",
  );
  const profile = await client.resolveProfileByHandle("fixture_web");
  assert.equal(profile.externalUserId, "84");
  assert.equal(profile.displayName, "Fixture Web Artist");
  assert.equal(profile.avatarUrl, "https://pbs.twimg.com/web-profile.jpg");
  assert.match(requested, /profile-query\/UserByScreenName/);
  assert.match(requested, /screen_name/);
});
