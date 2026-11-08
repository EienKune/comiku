import assert from "node:assert/strict";
import test from "node:test";
import { ProfileProofs } from "../src/authors/profile-proof.js";
const profile = {
  platform: "x" as const,
  externalUserId: "42",
  handle: "artist",
  avatarFileObjectId: null,
  adapterKey: "x_gallery_dl",
  syncedAt: "2026-11-05T00:00:00.000Z",
};
test("profile proof rejects tampering, replay by another actor or author, and expiry", () => {
  const proofs = new ProfileProofs("synthetic-server-secret");
  const token = proofs.issue(profile, "actor", "author", 1000);
  assert.equal(
    proofs.verify(token, "x", "actor", "author", 1001).externalUserId,
    "42",
  );
  for (const [actor, author, now] of [
    ["other", "author", 1001],
    ["actor", "other", 1001],
    ["actor", "author", 601001],
  ] as const)
    assert.throws(() => proofs.verify(token, "x", actor, author, now));
  assert.throws(() => proofs.verify(token + "a", "x", "actor", "author", 1001));
  assert.throws(() =>
    new ProfileProofs("different-secret").verify(
      token,
      "x",
      "actor",
      "author",
      1001,
    ),
  );
});
