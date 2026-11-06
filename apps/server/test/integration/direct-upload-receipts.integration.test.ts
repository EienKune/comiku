import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DirectUploadsService } from "../../src/transfers/direct-uploads.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

async function fixture() {
  const f = await candidateReviewFixture();
  const deleted: string[] = [];
  const jobs = new JobsService(f.db);
  const service = new DirectUploadsService(
    f.db,
    {
      deleteStagingObject: async (key: string) => {
        deleted.push(key);
      },
    } as never,
    jobs,
  );
  async function session(data = {}) {
    return f.db.directUploadSession.create({
      data: {
        actorId: f.actor.id,
        resourceId: f.author.id,
        purpose: "author_avatar",
        expectedRevision: 0,
        expiresAt: new Date(0),
        manifest: [
          {
            key: randomUUID(),
            sourceName: "private.png",
            checksum: "a".repeat(64),
            contentType: "image/png",
            size: 1,
          },
        ],
        ...data,
      },
    });
  }
  return {
    ...f,
    jobs,
    service,
    deleted,
    session,
    async close() {
      await f.db.backgroundJob.deleteMany({ where: { actorId: f.actor.id } });
      await f.db.directUploadSession.deleteMany({
        where: { actorId: f.actor.id },
      });
      await f.close();
    },
  };
}

test("protected queues do not starve expired sessions and terminal receipts have a separate retention clock", async () => {
  const f = await fixture();
  try {
    const protectedIds: string[] = [];
    for (let i = 0; i < 105; i++) {
      const s = await f.session({ status: "queued" });
      protectedIds.push(s.id);
      await f.jobs.enqueue({
        kind: "direct_author_avatar",
        resourceId: s.id,
        actorId: f.actor.id,
        idempotencyKey: `direct:${s.id}`,
      });
    }
    const pending = await f.session();
    await f.service.cleanupExpired();
    assert.equal(
      await f.db.directUploadSession.count({
        where: { id: { in: protectedIds }, status: "queued", terminalAt: null },
      }),
      105,
    );
    const expired = await f.db.directUploadSession.findUniqueOrThrow({
      where: { id: pending.id },
    });
    assert.equal(expired.status, "expired");
    assert.ok(expired.terminalAt);
    assert.equal(expired.stagingCleanedAt, null);
    assert.equal(f.deleted.length, 0);
    await f.db.directUploadSession.update({
      where: { id: pending.id },
      data: { terminalAt: new Date(Date.now() - 20 * 60_000) },
    });
    await f.service.cleanupExpired();
    const receipt = await f.db.directUploadSession.findUniqueOrThrow({
      where: { id: pending.id },
    });
    assert.ok(receipt.stagingCleanedAt);
    assert.deepEqual(
      receipt.manifest,
      (pending.manifest as { key: string }[]).map(({ key }) => ({ key })),
    );
    assert.deepEqual((await f.service.get(f.actor.id, pending.id)).files, []);
    await f.service.cleanupExpired();
    assert.equal(f.deleted.length, 1);
    await f.db.directUploadSession.update({
      where: { id: pending.id },
      data: { terminalAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    await f.service.cleanupExpired();
    assert.equal(f.deleted.length, 2);
    assert.equal(
      await f.db.directUploadSession.count({ where: { id: pending.id } }),
      0,
    );
  } finally {
    await f.close();
  }
});

test("finalize samples the deadline after its row lock and cannot enqueue expired pending uploads", async () => {
  const f = await fixture();
  try {
    const s = await f.session({ expiresAt: new Date(Date.now() + 350) });
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((r) => (entered = r));
    const finish = new Promise<void>((r) => (release = r));
    const blocker = f.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM direct_upload_sessions WHERE id=${s.id}::uuid FOR UPDATE`;
      entered();
      await finish;
    });
    await locked;
    const finalization = f.service.finalize(f.actor.id, s.id);
    const result = assert.rejects(finalization, /不可确认/);
    await new Promise((r) => setTimeout(r, 450));
    release();
    await blocker;
    await result;
    assert.equal(
      await f.db.backgroundJob.count({ where: { resourceId: s.id } }),
      0,
    );
  } finally {
    await f.close();
  }
});

test("completed adoption survives failed-job reconciliation and cleanup isolates storage failure", async () => {
  const f = await fixture();
  try {
    const done = await f.session({
      status: "completed",
      terminalAt: new Date(Date.now() - 20 * 60_000),
      result: { avatarFileObjectId: randomUUID() },
    });
    await f.jobs.enqueue({
      kind: "direct_author_avatar",
      resourceId: done.id,
      actorId: f.actor.id,
      idempotencyKey: `direct:${done.id}`,
    });
    await f.db.backgroundJob.update({
      where: { idempotencyKey: `direct:${done.id}` },
      data: { status: "failed" },
    });
    assert.equal(
      (await f.service.get(f.actor.id, done.id)).status,
      "completed",
    );
    const sibling = await f.session({
      status: "failed",
      terminalAt: new Date(Date.now() - 19 * 60_000),
    });
    const service = new DirectUploadsService(
      f.db,
      {
        deleteStagingObject: async (key: string) => {
          if (key === (done.manifest as { key: string }[])[0].key)
            throw Error("synthetic storage failure");
        },
      } as never,
      f.jobs,
    );
    await assert.rejects(service.cleanupExpired(), /synthetic/);
    assert.equal(
      (
        await f.db.directUploadSession.findUniqueOrThrow({
          where: { id: done.id },
        })
      ).stagingCleanedAt,
      null,
    );
    assert.ok(
      (
        await f.db.directUploadSession.findUniqueOrThrow({
          where: { id: sibling.id },
        })
      ).stagingCleanedAt,
    );
  } finally {
    await f.close();
  }
});
