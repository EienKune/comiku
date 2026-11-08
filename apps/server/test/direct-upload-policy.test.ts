import assert from "node:assert/strict";
import test from "node:test";
import {
  directUploadGrantSeconds,
  recoverableDirectUploadJob,
} from "../src/transfers/direct-upload-policy.js";
const now = new Date("2026-11-07T00:00:00Z");
const session = {
  id: "upload",
  purpose: "author_avatar" as const,
  actorId: "source",
};
const job = {
  resourceId: session.id,
  actorId: session.actorId,
  kind: "direct_author_avatar",
  idempotencyKey: "direct:upload",
  status: "queued" as const,
  attempts: 1,
  leaseUntil: null,
};
test("accepted uploads retain queued, leased and reclaimable work independently of the upload deadline", () => {
  assert.equal(recoverableDirectUploadJob(session, job, now), true);
  assert.equal(
    recoverableDirectUploadJob(
      session,
      {
        ...job,
        status: "running",
        attempts: 3,
        leaseUntil: new Date(now.getTime() + 1),
      },
      now,
    ),
    true,
  );
  assert.equal(
    recoverableDirectUploadJob(
      session,
      { ...job, status: "running", attempts: 2, leaseUntil: new Date(0) },
      now,
    ),
    true,
  );
});
test("only matching recoverable tasks protect uploads", () => {
  for (const patch of [
    { actorId: "other" },
    { kind: "direct_author_evidence" },
    { resourceId: "other" },
    { idempotencyKey: "other" },
    { status: "failed" as const },
    { attempts: 3 },
    { status: "running" as const, leaseUntil: null },
    { status: "running" as const, attempts: 3, leaseUntil: new Date(0) },
  ])
    assert.equal(
      recoverableDirectUploadJob(session, { ...job, ...patch }, now),
      false,
    );
  assert.equal(recoverableDirectUploadJob(session, null, now), false);
});
test("write grants are integral, capped and never cross the upload admission cutoff", () => {
  assert.equal(
    directUploadGrantSeconds(new Date(now.getTime() + 1_501), now),
    1,
  );
  assert.equal(directUploadGrantSeconds(new Date(now.getTime() + 999), now), 0);
  assert.equal(directUploadGrantSeconds(new Date(0), now), 0);
  assert.equal(
    directUploadGrantSeconds(new Date(now.getTime() + 86_400_000), now),
    900,
  );
});
