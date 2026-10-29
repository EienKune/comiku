import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
import {
  CandidateReviewSessions,
  REVIEW_CLEANUP_ENTRIES,
} from "../../src/candidates/candidate-review-sessions.js";
import type { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { activateImageAnalysisAdapter } from "../../src/image-analysis/image-analysis-adapter.js";

test("replacement failure rolls back both new entries and old expiry; foreign owner replacement is denied", async () => {
  const f = await candidateReviewFixture();
  const foreign = await candidateReviewFixture();
  try {
    await f.post();
    const old = await f.create();
    const rejectedKey = randomUUID();
    const failing = new CandidateReviewSessions({
      $transaction: (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) =>
        f.db.$transaction(async (tx) => {
          await callback(tx);
          throw Error("synthetic transaction failure");
        }),
    } as unknown as PrismaService);
    await assert.rejects(
      failing.create(
        f.actor.id,
        {
          ...f.filter,
          idempotencyKey: rejectedKey,
          replaceSessionId: old.sessionId,
        },
        f.analysis.candidateQueryPolicy,
      ),
      /synthetic transaction failure/,
    );
    assert.equal(
      await f.db.candidateReviewSession.count({
        where: { actorId: f.actor.id },
      }),
      1,
    );
    assert.equal(
      (
        await f.service.list(
          { ...f.filter, reviewSessionId: old.sessionId },
          f.actor.id,
        )
      ).items.length,
      1,
    );
    const foreignSession = await foreign.create();
    await assert.rejects(f.create(foreignSession.sessionId), /不属于/);
    await assert.rejects(
      f.service.list(
        { ...f.filter, reviewSessionId: old.sessionId },
        foreign.actor.id,
      ),
      /不属于/,
    );
    const next = await f.create(old.sessionId, rejectedKey);
    assert.notEqual(next.sessionId, old.sessionId);
  } finally {
    await foreign.close();
    await f.close();
  }
});

test("cleanup deletes at most 2000 entries per pass and never cascades a populated session", async () => {
  const f = await candidateReviewFixture();
  try {
    await f.db
      .$executeRaw`INSERT INTO candidate_posts(id, author_id, platform, external_post_id, posted_at, raw_json, updated_at) SELECT gen_random_uuid(), ${f.author.id}::uuid, 'review-cleanup', gen_random_uuid()::text, now(), '{}'::jsonb, now() FROM generate_series(1, 2001)`;
    const session = await f.create();
    await f.db.candidateReviewSession.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(0) },
    });
    const first = await f.sessions.cleanup(new Date(1));
    assert.equal(first.entries, REVIEW_CLEANUP_ENTRIES);
    assert.equal(first.sessions, 0);
    assert.equal(
      await f.db.candidateReviewSessionEntry.count({
        where: { sessionId: session.sessionId },
      }),
      1,
    );
    const second = await f.sessions.cleanup(new Date(1));
    assert.deepEqual(second, { entries: 1, sessions: 1 });
  } finally {
    await f.close();
  }
});

test("SQL supports a binary adapter taxonomy and hard expiry cannot be renewed", async () => {
  const f = await candidateReviewFixture();
  try {
    const model = activateImageAnalysisAdapter({
      ...f.model,
      identity: { ...f.model.identity, labels: ["accept", "reject"] },
      reviewPolicy: { positiveLabels: ["accept"], minimumConfidence: 0 },
    });
    const analysis = new ImageAnalysisService(
      f.db,
      {} as never,
      {} as never,
      model,
    );
    const service = new CandidatesService(
      f.db,
      {} as never,
      undefined,
      analysis,
    );
    const post = await f.post({
      analysisModelKey: model.modelKey,
      analysisPredictions: [{ label: "accept", confidence: 0.6, score: 0.8 }],
    });
    const session = await service.createReviewSession(f.actor.id, {
      ...f.filter,
      idempotencyKey: randomUUID(),
    });
    assert.deepEqual(
      (
        await service.list(
          {
            ...f.filter,
            triageGroup: "valid_manga",
            reviewSessionId: session.sessionId,
          },
          f.actor.id,
        )
      ).items.map((row) => row.id),
      [post.id],
    );
    await f.db.candidateReviewSession.update({
      where: { id: session.sessionId },
      data: {
        hardExpiresAt: new Date(0),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await assert.rejects(
      service.list(
        { ...f.filter, reviewSessionId: session.sessionId },
        f.actor.id,
      ),
      /过期/,
    );
  } finally {
    await f.close();
  }
});
