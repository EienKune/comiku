import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ProfileProofs } from "../src/authors/profile-proof.js";
const secret = "synthetic-server-secret";
const profile = {
  platform: "x" as const,
  externalUserId: "42",
  handle: "artist",
  avatarFileObjectId: null,
  adapterKey: "x_gallery_dl",
  syncedAt: "2026-11-05T00:00:00.000Z",
};
test("new profile evidence includes an explicit platform and version", () => {
  const token = new ProfileProofs(secret).issue(
    { ...profile, platform: "x" },
    "actor",
    "author",
    1000,
  );
  const payload = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString(),
  );
  assert.equal(payload.v, 2);
  assert.equal(payload.platform, "x");
});
function signed(value: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
test("same numeric identity cannot replay evidence across platforms", () => {
  const proofs = new ProfileProofs(secret);
  const x = proofs.issue(profile, "actor", "author", 1000);
  const pixiv = proofs.issue(
    { ...profile, platform: "pixiv", handle: null },
    "actor",
    "author",
    1000,
  );
  assert.equal(
    proofs.verify(pixiv, "pixiv", "actor", "author", 1001).handle,
    null,
  );
  assert.throws(() => proofs.verify(x, "pixiv", "actor", "author", 1001));
  assert.throws(() => proofs.verify(pixiv, "x", "actor", "author", 1001));
  for (const mutation of [
    { handle: "artist" },
    { actorId: "other" },
    { authorId: "other" },
    { issuedAt: 2000 },
    { expiresAt: 700000 },
  ]) {
    const token = signed({
      ...profile,
      v: 2,
      platform: "pixiv",
      handle: null,
      actorId: "actor",
      authorId: "author",
      issuedAt: 1000,
      expiresAt: 601000,
      ...mutation,
    });
    assert.throws(() => proofs.verify(token, "pixiv", "actor", "author", 1001));
  }
});
test("legacy X v1 proof preserves signature actor scope and exact ten-minute expiry", () => {
  const proofs = new ProfileProofs(secret);
  const legacy = { ...profile, platform: undefined };
  const token = signed({
    ...legacy,
    v: 1,
    actorId: "actor",
    authorId: "author",
    issuedAt: 1000,
    expiresAt: 601000,
  });
  assert.equal(
    proofs.verify(token, "x", "actor", "author", 600999).externalUserId,
    "42",
  );
  assert.throws(() => proofs.verify(token, "x", "actor", "author", 601000));
  assert.throws(() => proofs.verify(token, "pixiv", "actor", "author", 1001));
  assert.throws(() => proofs.verify(token, "x", "other", "author", 1001));
  assert.throws(() => proofs.verify(token, "x", "actor", "other", 1001));
  assert.throws(() =>
    new ProfileProofs("other").verify(token, "x", "actor", "author", 1001),
  );
});
