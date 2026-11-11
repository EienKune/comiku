import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorsService } from "../src/authors/authors.service.js";
import { ProfileProofs } from "../src/authors/profile-proof.js";
import { GalleryDlContentSource } from "../src/source-ingestion/adapters/gallery-dl/gallery-dl-content-source.js";
import type { ContentSourceClient } from "../src/source-ingestion/content-source.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
import { HttpMediaDownloader } from "../src/source-ingestion/media-downloader.js";
import { SourceResponseError } from "../src/source-ingestion/source-response.js";

function fixture(
  options: {
    platform?: "x" | "pixiv";
    avatar?: string | null;
    fetch?: typeof fetch;
    storeError?: unknown;
    signError?: unknown;
    externalAdapter?: boolean;
  } = {},
) {
  const platform = options.platform ?? "x";
  const avatar =
    options.avatar === undefined
      ? "https://pbs.twimg.com/profile_images/42/avatar.png"
      : options.avatar;
  let client: ContentSourceClient = new GalleryDlContentSource(
    platform,
    { python: "unused", configPath: "unused" },
    async () => ({
      version: 1,
      platform,
      profile: {
        external_user_id: "42",
        handle: "fixture",
        display_name: "Fixture",
        avatar_url: avatar,
      },
    }),
  );
  if (options.externalAdapter) {
    client = {
      platform,
      adapterKey: "external_fixture",
      available: true,
      priority: 1,
      metered: false,
      supportedFirstSyncModes: ["none"],
      allowedMediaHosts: ["fixture.invalid"],
      initialCursor: () => ({}),
      checkAccount: async () => ({
        externalUserId: "42",
        handle: "fixture",
        avatarUrl: avatar ?? undefined,
      }),
      resolveProfileByHandle: async () => ({
        externalUserId: "42",
        handle: "fixture",
        avatarUrl: avatar ?? undefined,
      }),
      fetchPage: async () => ({ items: [], complete: true }),
    };
  }
  const registry = new ContentSourceRegistry();
  let inProfile = false;
  registry.register(client);
  const db = { authorExternalAccount: { findFirst: async () => null } };
  const files = {
    store: async () => {
      if (options.storeError) throw options.storeError;
      return { id: "stored-avatar" };
    },
    signedReadUrl: async () => {
      if (options.signError) throw options.signError;
      return { url: "https://storage.invalid/fixture" };
    },
  };
  const downloader = new HttpMediaDownloader(
    options.fetch ??
      (async () =>
        new Response("synthetic image", {
          headers: { "Content-Type": "image/png" },
        })),
  );
  const args = [
    db,
    registry,
    files,
    downloader,
    {
      platforms: {
        profileNetwork: async (_actor: string, run: () => Promise<unknown>) => {
          inProfile = true;
          try {
            return await run();
          } finally {
            inProfile = false;
          }
        },
      },
    },
  ] as unknown as ConstructorParameters<typeof AuthorsService>;
  const service = new AuthorsService(...args);
  return {
    client,
    downloader,
    inProfile: () => inProfile,
    resolve: () =>
      platform === "x"
        ? service.resolveXProfile("actor", "fixture")
        : service.resolvePixivProfile("actor", "42"),
  };
}

test("profile execution remains admitted until the avatar body and storage finish", async () => {
  for (const platform of ["x", "pixiv"] as const) {
    let observed = false;
    const f = fixture({
      platform,
      avatar:
        platform === "pixiv" ? "https://i.pximg.net/avatar.png" : undefined,
      fetch: async () => {
        observed = f.inProfile();
        return new Response("synthetic image", {
          headers: { "Content-Type": "image/png" },
        });
      },
    });
    await f.resolve();
    assert.equal(
      observed,
      true,
      "avatar network must stay inside the profile execution boundary",
    );
    assert.equal(f.inProfile(), false);
  }
});

test("gallery default avatars use profile-only CDN hosts without widening post downloads", async () => {
  for (const [platform, avatar] of [
    [
      "x",
      "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
    ],
    ["pixiv", "https://s.pximg.net/common/images/no_profile.png"],
  ] as const) {
    const f = fixture({ platform, avatar });
    const profile = await f.resolve();
    assert.equal(profile.avatarFileObjectId, "stored-avatar");
    assert.equal(profile.avatarUrl, "https://storage.invalid/fixture");
    assert.equal(profile.externalUserId, "42");
    assert.equal(
      new ProfileProofs().verify(profile.profileProof, platform, "actor")
        .avatarFileObjectId,
      "stored-avatar",
    );
    await assert.rejects(
      f.downloader.download(avatar, f.client.allowedMediaHosts),
      (error: unknown) =>
        error instanceof SourceResponseError &&
        error.details?.reason === "media_url_not_allowed",
    );
  }
});

test("external adapters without an avatar host policy retain their media-host fallback", async () => {
  const profile = await fixture({
    externalAdapter: true,
    avatar: "https://fixture.invalid/avatar.png",
  }).resolve();
  assert.equal(profile.avatarFileObjectId, "stored-avatar");
});

test("unknown avatar hosts are rejected before network and log no URL", async (t) => {
  const events: string[] = [];
  t.mock.method(console, "warn", (event: string) => events.push(event));
  let requested = false;
  const profile = await fixture({
    avatar: "https://unknown.invalid/PRIVATE_PATH?token=PRIVATE_TOKEN",
    fetch: async () => {
      requested = true;
      throw new Error("must not fetch");
    },
  }).resolve();
  assert.equal(profile.avatarFileObjectId, null);
  assert.equal(requested, false);
  assert.equal(events.length, 1);
  const event = JSON.parse(events[0]);
  assert.equal(event.stage, "download");
  assert.equal(event.reason, "media_url_not_allowed");
  assert.equal(event.failureScope, "media");
  assert.doesNotMatch(events.join(""), /https|unknown.invalid|PRIVATE/);
});

test("missing avatar and each optional failure stage retain identity with safe diagnostics", async (t) => {
  const events: string[] = [];
  t.mock.method(console, "warn", (event: string) => events.push(event));
  const privateFailure = Object.assign(
    new TypeError("https://private.invalid/SECRET_PATH?token=SECRET_VALUE"),
    {
      cause: Object.assign(new Error("Authorization: SECRET_HEADER"), {
        code: "ETIMEDOUT",
      }),
    },
  );
  for (const [options, stage, reason, fileId] of [
    [{ avatar: null }, "missing", "avatar_url_missing", null],
    [
      {
        fetch: async () => {
          throw privateFailure;
        },
      },
      "download",
      "media_network_error",
      null,
    ],
    [{ storeError: privateFailure }, "store", "storage_failure", null],
    [
      { signError: privateFailure },
      "sign",
      "avatar_sign_failure",
      "stored-avatar",
    ],
  ] as const) {
    const profile = await fixture(options).resolve();
    assert.equal(profile.externalUserId, "42");
    assert.equal(
      new ProfileProofs().verify(profile.profileProof, "x", "actor")
        .avatarFileObjectId,
      fileId,
    );
    assert.equal(profile.avatarFileObjectId, fileId);
    assert.equal(profile.avatarUrl, null);
    assert.ok(events.length, "optional failure emits a diagnostic event");
    const event = JSON.parse(events.at(-1)!);
    assert.equal(event.event, "source_profile_avatar_failed");
    assert.equal(event.platform, "x");
    assert.equal(event.adapter, "x_gallery_dl");
    assert.equal(event.stage, stage);
    assert.equal(event.reason, reason);
    if (stage !== "missing") {
      assert.equal(event.exception_type, "TypeError");
      assert.equal(event.error_code, "ETIMEDOUT");
    }
  }
  assert.equal(events.length, 4);
  assert.doesNotMatch(
    events.join(""),
    /https|private.invalid|SECRET|Authorization/,
  );
});

test("avatar HTTP diagnostics preserve status while omitting upstream endpoint and text", async (t) => {
  const events: string[] = [];
  t.mock.method(console, "warn", (event: string) => events.push(event));
  const profile = await fixture({
    fetch: async () => new Response(null, { status: 403 }),
  }).resolve();
  assert.equal(profile.avatarFileObjectId, null);
  assert.equal(events.length, 1);
  const event = JSON.parse(events[0]);
  assert.equal(event.reason, "media_http_403");
  assert.equal(event.failureScope, "media");
  assert.equal(event.http_status, "403");
  assert.doesNotMatch(events[0], /https|pbs|profile_images|http_endpoint/);
});

test("arbitrary error names and codes cannot inject secrets into avatar logs", async (t) => {
  const events: string[] = [];
  t.mock.method(console, "warn", (event: string) => events.push(event));
  const error = Object.assign(new Error("SECRET_MESSAGE"), {
    name: "SECRET_NAME",
    code: "SECRET_CODE",
    cause: { code: "SECRET_CAUSE" },
  });
  const profile = await fixture({
    fetch: async () => {
      throw error;
    },
  }).resolve();
  assert.equal(profile.avatarFileObjectId, null);
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0]).exception_type, "Error");
  assert.doesNotMatch(events[0], /SECRET/);
});
