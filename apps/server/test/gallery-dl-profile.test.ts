import assert from "node:assert/strict";
import test from "node:test";
import { GalleryDlContentSource } from "../src/source-ingestion/adapters/gallery-dl/gallery-dl-content-source.js";

test("gallery profile uses bounded metadata and refreshes a bound numeric ID", async () => {
  const client = new GalleryDlContentSource(
    "x",
    { python: "/none", configPath: "/none" },
    async (source) => {
      assert.deepEqual(source, {
        mode: "profile",
        platform: "x",
        remote_id: "42",
      });
      return {
        version: 1,
        platform: "x",
        profile: {
          external_user_id: "42",
          handle: "latest",
          display_name: "Artist",
        },
      };
    },
  );
  const result = await client.checkAccount({
    externalUserId: "42",
    handle: "stale",
  });
  assert.equal(result.handle, "latest");
  assert.equal(result.externalUserId, "42");
});

test("gallery profile rejects a mismatched or malformed identity", async () => {
  for (const profile of [
    { external_user_id: "43", handle: "artist" },
    { external_user_id: "42", handle: "other" },
    { external_user_id: "0", handle: "artist" },
    { external_user_id: "42" },
  ]) {
    const client = new GalleryDlContentSource(
      "x",
      { python: "/none", configPath: "/none" },
      async () => ({ version: 1, platform: "x", profile }),
    );
    await assert.rejects(
      profile.external_user_id === "43"
        ? client.checkAccount({ externalUserId: "42" })
        : client.resolveProfileByHandle("artist"),
    );
  }
});

test("Pixiv profile resolves an empty account directly by stable ID without an X handle", async () => {
  const client = new GalleryDlContentSource(
    "pixiv",
    { python: "/none", configPath: "/none" },
    async (source, cursor) => {
      assert.deepEqual(source, {
        mode: "profile",
        platform: "pixiv",
        remote_id: "42",
      });
      assert.equal(cursor, null);
      return {
        version: 1,
        platform: "pixiv",
        profile: {
          external_user_id: "42",
          display_name: "  Artist  ",
          avatar_url: "https://i.pximg.net/user-profile/a.jpg",
        },
      };
    },
  );
  assert.deepEqual(
    await client.checkAccount({ externalUserId: "42", handle: "stale" }),
    {
      externalUserId: "42",
      displayName: "Artist",
      profileUrl: "https://www.pixiv.net/users/42",
      avatarUrl: "https://i.pximg.net/user-profile/a.jpg",
    },
  );
});

test("profile rejects cross-platform envelopes and Pixiv invalid identities", async () => {
  for (const platform of ["x", "pixiv"] as const) {
    const client = new GalleryDlContentSource(
      platform,
      { python: "/none", configPath: "/none" },
      async () => ({
        version: 1,
        platform: platform === "x" ? "pixiv" : "x",
        profile: {
          external_user_id: "42",
          handle: "artist",
          display_name: "Artist",
        },
      }),
    );
    await assert.rejects(client.checkAccount({ externalUserId: "42" }));
  }
  for (const external_user_id of [
    "0",
    "042",
    "43",
    "1".repeat(21),
    42,
    undefined,
  ]) {
    const client = new GalleryDlContentSource(
      "pixiv",
      { python: "/none", configPath: "/none" },
      async () => ({
        version: 1,
        platform: "pixiv",
        profile: { external_user_id },
      }),
    );
    await assert.rejects(client.checkAccount({ externalUserId: "42" }));
  }
});

test("Pixiv profile normalizes optional metadata and validates requested IDs before calling native", async () => {
  for (const display_name of [undefined, "", "   ", " A ".repeat(300)]) {
    const client = new GalleryDlContentSource(
      "pixiv",
      { python: "/none", configPath: "/none" },
      async () => ({
        version: 1,
        platform: "pixiv",
        profile: {
          external_user_id: "42",
          display_name,
          avatar_url: "a".repeat(2049),
        },
      }),
    );
    const profile = await client.checkAccount({ externalUserId: "42" });
    assert.equal(
      profile.displayName,
      display_name?.trim().slice(0, 255) || "42",
    );
    assert.equal(profile.avatarUrl, undefined);
    assert.equal(profile.handle, undefined);
  }
  let calls = 0;
  const client = new GalleryDlContentSource(
    "pixiv",
    { python: "/none", configPath: "/none" },
    async () => {
      calls++;
      assert.fail("invalid target must not call native");
    },
  );
  for (const externalUserId of ["0", "042", "1".repeat(21), "-1", ""]) {
    await assert.rejects(client.checkAccount({ externalUserId }));
    assert.equal(calls, 0);
  }
});
