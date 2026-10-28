import assert from "node:assert/strict";
import test from "node:test";
import {
  recoveryDue,
  recoveryKey,
  readyManifest,
} from "../src/source-ingestion/source-discovery.service.js";

test("campaign backoff counts business failures, stops after eight, and has stable keys", () => {
  const now = new Date("2026-10-28T00:00:00Z");
  assert.equal(recoveryDue(1, now)?.getTime(), now.getTime() + 900000);
  assert.equal(recoveryDue(2, now)?.getTime(), now.getTime() + 3600000);
  assert.equal(recoveryDue(7, now)?.getTime(), now.getTime() + 21600000);
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
