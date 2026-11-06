import assert from "node:assert/strict";
import test from "node:test";
import {
  SourceDiscoveryService,
  recoveryDue,
  recoveryKey,
  readyManifest,
} from "../src/source-ingestion/source-discovery.service.js";

test("campaign backoff counts business failures, stops after eight, and has stable keys", () => {
  const now = new Date("2026-10-28T00:00:00Z");
  assert.equal(recoveryDue(0, now)?.getTime(), now.getTime() + 300000);
  assert.equal(recoveryDue(1, now)?.getTime(), now.getTime() + 600000);
  assert.equal(recoveryDue(2, now)?.getTime(), now.getTime() + 1800000);
  assert.equal(recoveryDue(7, now)?.getTime(), now.getTime() + 1800000);
  assert.equal(recoveryDue(8, now), null);
  assert.equal(recoveryKey("post", 2), "source-recover:post:2");
});

test("only verified nonempty complete manifests become candidates", () => {
  const stored = [
    { externalMediaId: "a", orderIndex: 0, fileObjectId: "file" },
  ];
  assert.equal(readyManifest(null, stored), false);
  assert.equal(readyManifest(0, []), false);
  assert.equal(readyManifest(2, stored), false);
  assert.equal(readyManifest(1, stored), true);
  assert.equal(readyManifest(1, [{ ...stored[0], fileObjectId: null }]), false);
  assert.equal(
    readyManifest(2, [stored[0], { ...stored[0], orderIndex: 1 }]),
    false,
  );
});

test("known policy rejections stop automatic compensation while transport errors remain retryable", async () => {
  for (const reason of [
    "media_size_limit",
    "media_type_unsupported",
    "media_empty",
    "media_url_not_allowed",
    "media_network_error",
    "media_http_503",
  ]) {
    let post: Record<string, unknown> = {};
    const tx = {
      sourceDiscoveryMedia: { updateMany: async () => ({ count: 1 }) },
      sourceDiscoveryPost: {
        updateMany: async (input: { data: Record<string, unknown> }) => {
          post = input.data;
          return { count: 1 };
        },
      },
    };
    await new SourceDiscoveryService({} as never).failedMedia(
      tx as never,
      "post",
      "media",
      reason,
    );
    assert.equal(post.failureCode, reason);
    if (!["media_size_limit", "media_url_not_allowed"].includes(reason))
      assert.ok(post.nextRetryAt instanceof Date);
    else {
      assert.equal(post.state, "needs_attention");
      assert.equal(post.nextRetryAt, null);
    }
  }
});
