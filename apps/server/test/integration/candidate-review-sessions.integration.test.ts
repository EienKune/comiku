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
    const photo = await f.post();
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
    assert.equal(session.counts.valid_manga, 3);
    assert.equal(session.counts.photo, 1);
    const query = {
      ...f.filter,
      reviewSessionId: session.sessionId,
      triageGroup: "valid_manga" as const,
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
      (await f.service.list({ ...query, triageGroup: "photo" }, f.actor.id))
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
        { ...query, triageGroup: "photo", cursor: first.nextCursor! },
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
    assert.equal(restored.counts.valid_manga, 1);
    const liveQuery = { ...f.filter, limit: 1 };
    await assert.rejects(
      f.service.list({ ...liveQuery, cursor: randomUUID() }, f.actor.id),
      /版本/,
    );
  } finally {
    await f.close();
  }
});

test("SQL ranking validates every cache entry and preserves photo > blocked > manual/current model > neutral", async () => {
  const f = await candidateReviewFixture();
  try {
    const positive = await f.post({ analysisState: "failed" });
    const partial = await f.post({
      analysisState: "queued",
      analysisScore: 0.9,
    });
    const threshold = await f.post({
      analysisPredictions: [{ label: "positive", confidence: 0.5, score: 0.8 }],
    });
    const below = await f.post({
      analysisPredictions: [
        { label: "positive", confidence: 0.49, score: 0.8 },
      ],
    });
    const tagged = await f.post({
      tagDisposition: "valid",
      analysisPredictions: [],
    });
    const blocked = await f.post({ tagDisposition: "blocked" });
    const photo = await f.post({ tagDisposition: "blocked" });
    await f.db.candidateClassificationDecision.create({
      data: {
        candidatePostId: photo.id,
        label: "photo",
        decidedById: f.actor.id,
      },
    });
    const malformed = [];
    for (const predictions of [
      null,
      [],
      {},
      [null],
      [{ confidence: 0.9, score: 0.9 }],
      [{ label: "unknown", confidence: 0.9, score: 0.9 }],
      [{ label: "positive", confidence: "0.9", score: 0.9 }],
      [{ label: "positive", confidence: 0.9 }],
      [{ label: "positive", confidence: 0.9, score: null }],
      [{ label: "positive", confidence: 1.1, score: 0.9 }],
      [
        { label: "positive", confidence: 0.9, score: 0.9 },
        { label: "positive", confidence: 0.9, score: 0.9 },
      ],
    ]) {
      malformed.push(
        await f.post({
          analysisPredictions: predictions === null ? undefined : predictions,
        }),
      );
      if (predictions === null)
        await f.db
          .$executeRaw`UPDATE candidate_posts SET analysis_predictions = NULL WHERE id = ${malformed.at(-1)!.id}::uuid`;
    }
    const old = await f.post({ analysisModelKey: "retired" });
    const session = await f.create();
    const ids = async (
      triageGroup: "valid_manga" | "neutral_manga" | "blocked_manga" | "photo",
    ) =>
      (
        await f.service.list(
          {
            ...f.filter,
            reviewSessionId: session.sessionId,
            triageGroup,
            limit: 100,
          },
          f.actor.id,
        )
      ).items
        .map((row) => row.id)
        .sort();
    assert.deepEqual(
      await ids("valid_manga"),
      [positive.id, partial.id, threshold.id, tagged.id].sort(),
    );
    assert.deepEqual(
      await ids("neutral_manga"),
      [below.id, old.id, ...malformed.map((row) => row.id)].sort(),
    );
    assert.deepEqual(await ids("blocked_manga"), [blocked.id]);
    assert.deepEqual(await ids("photo"), [photo.id]);
    const live = await f.service.list({ ...f.filter, limit: 1 }, f.actor.id);
    assert.equal(live.items[0].id, partial.id);
    const next = await f.service.list(
      { ...f.filter, limit: 100, cursor: live.nextCursor! },
      f.actor.id,
    );
    assert.equal(next.items.length, 18);
    assert.ok(next.items.every((row) => row.id !== partial.id));
    const disabled = new CandidatesService(f.db, {} as never);
    assert.deepEqual(
      (
        await disabled.list(
          { ...f.filter, triageGroup: "valid_manga" },
          f.actor.id,
        )
      ).items.map((row) => row.id),
      [tagged.id],
    );
  } finally {
    await f.close();
  }
});
