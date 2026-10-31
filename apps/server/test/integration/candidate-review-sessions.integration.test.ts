import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import {
  REVIEW_HARD_MS,
  REVIEW_IDLE_MS,
} from "../../src/candidates/candidate-review-sessions.js";

test("snapshot survives new posts and score/group changes; state, owner, filter, model and cursor stay live", async () => {
  const f = await candidateReviewFixture();
  try {
    const a = await f.post({ analysisScore: 0.9 });
    const b = await f.post({ analysisScore: 0.8 });
    const c = await f.post({ analysisScore: 0.7 });
    const photo = await f.post({ analysisPredictions: [] });
    await f.db.candidateClassificationDecision.create({
      data: {
        candidatePostId: photo.id,
        label: "photo",
        decidedById: f.actor.id,
      },
    });
    const session = await f.create();
    assert.deepEqual(Object.keys(session).sort(), [
      "counts",
      "expiresAt",
      "sessionId",
    ]);
    assert.equal(session.counts.priority, 3);
    assert.equal(session.counts.uncertain, 1);
    const query = {
      ...f.filter,
      reviewSessionId: session.sessionId,
      triageGroup: "priority" as const,
      limit: 1,
    };
    const first = await f.service.list(query, f.actor.id);
    assert.equal(first.items[0].id, a.id);
    await f.post({ analysisScore: 1 });
    await f.db.candidatePost.update({
      where: { id: a.id },
      data: { analysisScore: 0.1 },
    });
    await f.db.candidatePost.update({
      where: { id: b.id },
      data: { tagDisposition: "blocked", revision: 1 },
    });
    const second = await f.service.list(
      { ...query, cursor: first.nextCursor! },
      f.actor.id,
    );
    assert.equal(second.items[0].id, b.id);
    assert.equal(second.items[0].revision, 1);
    const third = await f.service.list(
      { ...query, cursor: second.nextCursor! },
      f.actor.id,
    );
    assert.deepEqual(
      third.items.map((row) => row.id),
      [c.id],
    );
    assert.equal(third.nextCursor, null);
    assert.equal(
      (await f.service.list({ ...query, triageGroup: "uncertain" }, f.actor.id))
        .items[0].id,
      photo.id,
    );
    await assert.rejects(f.service.list(query, randomUUID()), /职务|用户/);
    await assert.rejects(
      f.service.list({ ...query, search: "different" }, f.actor.id),
      /筛选/,
    );
    await assert.rejects(
      new CandidatesService(f.db, {} as never).list(query, f.actor.id),
      /模型/,
    );
    await assert.rejects(
      f.service.list(
        { ...query, triageGroup: "uncertain", cursor: first.nextCursor! },
        f.actor.id,
      ),
      /游标/,
    );
    const [body, signature] = first.nextCursor!.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString());
    forged.ordinal = 2;
    await assert.rejects(
      f.service.list(
        {
          ...query,
          cursor: `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`,
        },
        f.actor.id,
      ),
      /游标/,
    );
    await f.db.candidatePost.update({
      where: { id: b.id },
      data: { status: "discarded" },
    });
    assert.deepEqual(
      (
        await f.service.list(
          { ...query, cursor: first.nextCursor! },
          f.actor.id,
        )
      ).items.map((row) => row.id),
      [c.id],
    );
    await f.db.author.update({
      where: { id: f.author.id },
      data: { deletedAt: new Date() },
    });
    assert.equal((await f.service.list(query, f.actor.id)).total, 0);
    await f.db.user.update({
      where: { id: f.actor.id },
      data: { isActive: false },
    });
    await assert.rejects(f.service.list(query, f.actor.id), /职务/);
  } finally {
    await f.close();
  }
});

test("atomic replacement, idempotency and concurrent tabs keep quota available; expiry and touch are bounded", async () => {
  const f = await candidateReviewFixture();
  try {
    await f.post();
    const first = await f.create();
    const key = randomUUID();
    const duplicate = await Promise.all([
      f.create(first.sessionId, key),
      f.create(first.sessionId, key),
    ]);
    assert.equal(duplicate[0].sessionId, duplicate[1].sessionId);
    await Promise.all(Array.from({ length: 5 }, () => f.create()));
    assert.equal(
      await f.db.candidateReviewSession.count({
        where: { actorId: f.actor.id, expiresAt: { gt: new Date() } },
      }),
      3,
    );
    const old = await f.db.candidateReviewSession.findFirstOrThrow({
      where: { actorId: f.actor.id, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    assert.equal(+old.hardExpiresAt - +old.createdAt, REVIEW_HARD_MS);
    assert.equal(+old.expiresAt - +old.createdAt, REVIEW_IDLE_MS);
    await f.db.candidateReviewSession.update({
      where: { id: old.id },
      data: { lastUsedAt: new Date(Date.now() - 6 * 60_000) },
    });
    await f.service.list({ ...f.filter, reviewSessionId: old.id }, f.actor.id);
    const touched = await f.db.candidateReviewSession.findUniqueOrThrow({
      where: { id: old.id },
    });
    await f.service.list({ ...f.filter, reviewSessionId: old.id }, f.actor.id);
    assert.equal(
      +(
        await f.db.candidateReviewSession.findUniqueOrThrow({
          where: { id: old.id },
        })
      ).lastUsedAt,
      +touched.lastUsedAt,
    );
    await f.db.candidateReviewSession.update({
      where: { id: old.id },
      data: { expiresAt: new Date(0) },
    });
    await assert.rejects(
      f.service.list({ ...f.filter, reviewSessionId: old.id }, f.actor.id),
      /过期/,
    );
    const restored = await f.create(old.id);
    assert.equal(restored.counts.priority, 1);
    const liveQuery = { ...f.filter, limit: 1 };
    await assert.rejects(
      f.service.list({ ...liveQuery, cursor: randomUUID() }, f.actor.id),
      /版本/,
    );
  } finally {
    await f.close();
  }
});
