import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
import { WorksService } from "../../src/works/works.service.js";
import { CandidateCompositionsService } from "../../src/candidates/composition.service.js";
import type { ComposeCandidatesDto } from "../../src/candidates/composition.dto.js";

test("actual-source scopes cover candidate SQL, pending, sessions/cursors and Work direct EXISTS without duplicates", async () => {
  const f = await candidateReviewFixture();
  const accountIds: string[] = [];
  try {
    async function account(platform: string, retired = false) {
      const row = await f.db.authorExternalAccount.create({
        data: {
          authorId: f.author.id,
          platform,
          externalUserId: randomUUID(),
          fetchEnabled: false,
          deletedAt: retired ? new Date("2026-01-01") : null,
          notes: "private-source-canary",
        },
      });
      accountIds.push(row.id);
      return row;
    }
    const main = await account("x"),
      side = await account("x"),
      pixiv = await account("pixiv", true);
    const a = await f.post({ platform: "x", authorExternalAccountId: main.id });
    const a2 = await f.post({
      platform: "x",
      authorExternalAccountId: main.id,
    });
    const b = await f.post({ platform: "x", authorExternalAccountId: side.id });
    const p = await f.post({
      platform: "pixiv",
      authorExternalAccountId: pixiv.id,
    });
    const unknownX = await f.post({ platform: "x" });
    const unknownPixiv = await f.post({ platform: "pixiv" });
    const manual = await f.post({ platform: "manual" });
    await f.db.candidateMediaAnalysis.deleteMany({
      where: { media: { candidatePostId: b.id } },
    });
    const firstQuery = { ...f.filter, sourceAccountId: main.id, limit: 1 };
    const first = await f.service.list(firstQuery, f.actor.id);
    assert.equal(first.total, 2);
    assert.equal(first.analysisPending, false);
    assert.ok(first.nextCursor);
    assert.equal(
      (
        await f.service.list(
          { ...firstQuery, cursor: first.nextCursor },
          f.actor.id,
        )
      ).items.length,
      1,
    );
    assert.equal(
      (
        await f.service.list(
          { ...f.filter, sourceAccountId: side.id },
          f.actor.id,
        )
      ).analysisPending,
      true,
    );
    await assert.rejects(
      f.service.list(
        { ...firstQuery, sourceAccountId: side.id, cursor: first.nextCursor },
        f.actor.id,
      ),
      /游标/,
    );
    const retired = await f.service.list(
      { ...f.filter, sourceAccountId: pixiv.id },
      f.actor.id,
    );
    assert.equal(retired.total, 1);
    assert.equal(retired.items[0].sourceAccount?.id, pixiv.id);
    assert.ok(retired.items[0].sourceAccount?.deletedAt);
    assert.doesNotMatch(
      JSON.stringify(retired),
      /private-source-canary|notes|metadataJson/,
    );
    const unbound = await f.service.list(
      { ...f.filter, sourceUnbound: true },
      f.actor.id,
    );
    assert.deepEqual(
      new Set(unbound.items.map(({ id }) => id)),
      new Set([unknownX.id, unknownPixiv.id]),
    );
    assert.equal(
      (
        await f.service.list(
          { ...f.filter, sourcePlatform: "manual" },
          f.actor.id,
        )
      ).items[0].id,
      manual.id,
    );
    const session = await f.service.createReviewSession(f.actor.id, {
      ...firstQuery,
      idempotencyKey: randomUUID(),
    });
    assert.equal(session.counts.priority, 2);
    assert.equal(
      (
        await f.service.list(
          { ...firstQuery, reviewSessionId: session.sessionId },
          f.actor.id,
        )
      ).total,
      2,
    );
    await assert.rejects(
      f.service.list(
        {
          ...f.filter,
          sourceAccountId: side.id,
          reviewSessionId: session.sessionId,
        },
        f.actor.id,
      ),
      /筛选/,
    );
    // The old stored JSON has no source keys; counting and reading still accept it.
    const legacy = await f.create();
    const stored = await f.db.candidateReviewSession.findUniqueOrThrow({
      where: { id: legacy.sessionId },
    });
    assert.equal(
      "sourcePlatform" in (stored.normalizedFilterJson as object),
      false,
    );
    assert.equal(
      (
        await f.service.list(
          { ...f.filter, reviewSessionId: legacy.sessionId },
          f.actor.id,
        )
      ).total,
      7,
    );
    await assert.rejects(
      f.service.list({ ...firstQuery, authorId: randomUUID() }, f.actor.id),
      /作者/,
    );
    await assert.rejects(
      f.service.createReviewSession(f.actor.id, {
        ...firstQuery,
        authorId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
      /作者/,
    );
    async function work(posts: (typeof a)[]) {
      const row = await f.db.work.create({
        data: {
          authorId: f.author.id,
          sourceCandidatePostId: posts[0].id,
          importedById: f.actor.id,
          sources: {
            create: posts.map((post, orderIndex) => ({
              candidatePostId: post.id,
              orderIndex,
            })),
          },
        },
      });
      const media = await f.db.candidateMedia.findFirstOrThrow({
        where: { candidatePostId: posts[0].id },
      });
      await f.db.workImage.create({
        data: {
          workId: row.id,
          originalFileObjectId: media.fileObjectId,
          orderIndex: 0,
        },
      });
      return row;
    }
    const both = await work([a, a2, b, p]);
    const crossed = await work([a, unknownPixiv, manual]);
    const unknown = await work([unknownX, unknownPixiv]);
    const works = new WorksService(f.db, {} as never, {} as never);
    const workQuery = { authorId: f.author.id, mine: false, limit: 24 };
    const sameAccount = await works.list(f.actor.id, {
      ...workQuery,
      sourceAccountId: main.id,
    });
    assert.equal(sameAccount.total, 2);
    assert.deepEqual(
      new Set(sameAccount.items.map(({ id }) => id)),
      new Set([both.id, crossed.id]),
    );
    const sameRow = await works.list(f.actor.id, {
      ...workQuery,
      sourcePlatform: "x",
      sourceUnbound: true,
    });
    assert.equal(sameRow.total, 1);
    assert.equal(sameRow.items[0].id, unknown.id);
    const album = await works.album(f.actor.id, {
      ...workQuery,
      sourcePlatform: "x",
      sourceUnbound: true,
      limit: 1,
    });
    assert.equal(album.workTotal, 1);
    assert.equal(album.total, 1);
    assert.equal(album.items[0].workId, unknown.id);
    const retiredWork = await works.list(f.actor.id, {
      ...workQuery,
      sourceAccountId: pixiv.id,
    });
    assert.equal(retiredWork.total, 1);
    assert.equal(retiredWork.items[0].id, both.id);
  } finally {
    await f.db.workImage.deleteMany({
      where: { work: { importedById: f.actor.id } },
    });
    await f.db.work.deleteMany({ where: { importedById: f.actor.id } });
    await f.db.candidateReviewSessionEntry.deleteMany({
      where: { session: { actorId: f.actor.id } },
    });
    await f.db.candidateReviewSession.deleteMany({
      where: { actorId: f.actor.id },
    });
    await f.db.candidatePost.deleteMany({ where: { authorId: f.author.id } });
    await f.db.authorExternalAccount.deleteMany({
      where: { id: { in: accountIds } },
    });
    await f.close();
  }
});

test("merge source checks run in the locked transaction while historical successful receipts remain replayable", async () => {
  const f = await candidateReviewFixture();
  const accounts: string[] = [];
  const service = new CandidateCompositionsService(f.db, {
    authorizeImport: async () => undefined,
  } as never);
  const actor = { userId: f.actor.id, sessionId: randomUUID() };
  try {
    async function account(platform: string) {
      const row = await f.db.authorExternalAccount.create({
        data: {
          authorId: f.author.id,
          platform,
          externalUserId: randomUUID(),
          fetchEnabled: false,
        },
      });
      accounts.push(row.id);
      return row;
    }
    const main = await account("x"),
      side = await account("x"),
      pixiv = await account("pixiv");
    for (const [left, right, accepted] of [
      [
        { platform: "x", authorExternalAccountId: main.id },
        { platform: "x", authorExternalAccountId: main.id },
        true,
      ],
      [{ platform: "manual" }, { platform: "manual" }, true],
      [{ platform: "x" }, { platform: "x" }, false],
      [{ platform: "manual" }, { platform: "x" }, false],
      [
        { platform: "x", authorExternalAccountId: main.id },
        { platform: "x", authorExternalAccountId: side.id },
        false,
      ],
      [
        { platform: "x", authorExternalAccountId: main.id },
        { platform: "pixiv", authorExternalAccountId: pixiv.id },
        false,
      ],
      [
        { platform: "x", authorExternalAccountId: main.id },
        { platform: "pixiv", authorExternalAccountId: main.id },
        false,
      ],
    ] as const) {
      const posts = [await f.post(left), await f.post(right)];
      const media = await f.db.candidateMedia.findMany({
        where: { candidatePostId: { in: posts.map(({ id }) => id) } },
      });
      const input: ComposeCandidatesDto = {
        mode: "merge",
        idempotencyKey: randomUUID(),
        candidates: posts.map(({ id }) => ({ id, expectedRevision: 0 })),
        works: [{ title: null, mediaIds: media.map(({ id }) => id) }],
      };
      if (accepted) {
        const result = await service.compose(actor, input);
        // A preexisting receipt wins over the new provenance rule, even after source facts change.
        await f.db.candidatePost.updateMany({
          where: { id: { in: posts.map(({ id }) => id) } },
          data: {
            authorExternalAccountId: null,
            platform: "historical-unknown",
          },
        });
        assert.deepEqual(await service.compose(actor, input), result);
      } else {
        await assert.rejects(
          service.compose(actor, input),
          /来源账号|来源候选/,
        );
        assert.equal(
          await f.db.candidateCompositionReceipt.count({
            where: {
              actorId: actor.userId,
              idempotencyKey: input.idempotencyKey,
            },
          }),
          0,
        );
        assert.equal(
          await f.db.candidatePost.count({
            where: { id: { in: posts.map(({ id }) => id) }, status: "pending" },
          }),
          2,
        );
      }
    }
  } finally {
    await f.db.candidateActionLog.deleteMany({
      where: { actorId: f.actor.id },
    });
    await f.db.workEvent.deleteMany({ where: { actorId: f.actor.id } });
    await f.db.workImage.deleteMany({
      where: { work: { importedById: f.actor.id } },
    });
    await f.db.work.deleteMany({ where: { importedById: f.actor.id } });
    await f.db.candidateCompositionReceipt.deleteMany({
      where: { actorId: f.actor.id },
    });
    await f.db.candidatePost.deleteMany({ where: { authorId: f.author.id } });
    await f.db.authorExternalAccount.deleteMany({
      where: { id: { in: accounts } },
    });
    await f.close();
  }
});
