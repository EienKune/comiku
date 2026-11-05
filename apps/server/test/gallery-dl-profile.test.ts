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
