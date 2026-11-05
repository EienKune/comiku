import assert from "node:assert/strict";
import test from "node:test";
import { XProfileProofs } from "../src/authors/x-profile-proof.js";
const profile = {
  externalUserId: "42",
  handle: "artist",
  avatarFileObjectId: null,
  adapterKey: "x_gallery_dl",
  syncedAt: "2026-11-05T00:00:00.000Z",
};
test("profile proof rejects tampering, replay by another actor or author, and expiry", () => {
  const proofs = new XProfileProofs("synthetic-server-secret");
  const token = proofs.issue(profile, "actor", "author", 1000);
  assert.equal(
    proofs.verify(token, "actor", "author", 1001).externalUserId,
    "42",
  );
  for (const [actor, author, now] of [
    ["other", "author", 1001],
    ["actor", "other", 1001],
    ["actor", "author", 601001],
  ] as const)
    assert.throws(() => proofs.verify(token, actor, author, now));
  assert.throws(() => proofs.verify(token + "a", "actor", "author", 1001));
  assert.throws(() =>
    new XProfileProofs("different-secret").verify(
      token,
      "actor",
      "author",
      1001,
    ),
  );
});
