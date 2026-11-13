import assert from "node:assert/strict";
import test from "node:test";
import { CandidateAction } from "../../src/candidates/candidates.dto.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { MemoryObjectStorage } from "../../src/files/memory-object-storage.js";
import type { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { WorksService } from "../../src/works/works.service.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

type Fixture = Awaited<ReturnType<typeof candidateReviewFixture>>;

async function post(f: Fixture, count = 3) {
  const candidate = await f.post({
    analysisPredictions: Array.from({ length: count }, () => ({
      label: "positive",
      confidence: 0.8,
      score: 0.8,
    })),
  });
  return f.db.candidatePost.findUniqueOrThrow({
    where: { id: candidate.id },
    include: { media: { orderBy: { orderIndex: "asc" } } },
  });
}

async function close(f: Fixture) {
  await f.db.candidateActionLog.deleteMany({ where: { actorId: f.actor.id } });
  await f.db.workEvent.deleteMany({
    where: { work: { authorId: f.author.id } },
  });
  await f.db.work.deleteMany({ where: { authorId: f.author.id } });
  await f.close();
}

test("an atomic ordered subset creates one work and retains every source media and file", async () => {
  const f = await candidateReviewFixture();
  try {
    const candidate = await post(f);
    const ids = candidate.media.map(({ id }) => id);
    const input = {
      action: CandidateAction.import,
      items: [
        {
          id: candidate.id,
          expectedRevision: candidate.revision,
          mediaIds: [ids[2], ids[0]],
        },
      ],
    };
    const result = (await f.service.batch(f.actor.id, input)).results[0];
    assert.equal(result.outcome, "succeeded");
    const work = await f.db.work.findUniqueOrThrow({
      where: { id: result.workId! },
      include: { sources: true, images: { orderBy: { orderIndex: "asc" } } },
    });
    assert.equal(work.sources[0].importedRevision, 0);
    assert.deepEqual(
      work.images.map((image) => [
        image.sourceCandidateMediaId,
        image.orderIndex,
        image.originalFileObjectId,
      ]),
      [
        [ids[2], 0, candidate.media[2].fileObjectId],
        [ids[0], 1, candidate.media[0].fileObjectId],
      ],
    );
    const current = await f.db.candidatePost.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { media: true },
    });
    assert.equal(current.status, "imported");
    assert.equal(current.revision, 1);
    assert.equal(current.media.length, 3);
    assert.equal(
      await f.db.candidatePost.count({ where: { authorId: f.author.id } }),
      1,
    );
    assert.equal(
      await f.db.candidateActionLog.count({
        where: { candidatePostId: candidate.id },
      }),
      1,
    );
    assert.equal(await f.db.workEvent.count({ where: { workId: work.id } }), 1);

    const storage = new MemoryObjectStorage();
    const excludedFile = await f.db.fileObject.findUniqueOrThrow({
      where: { id: candidate.media[1].fileObjectId },
    });
    await storage.put({
      key: excludedFile.objectKey,
      body: new Uint8Array([1]),
      size: 1,
      contentType: "image/jpeg",
      checksum: excludedFile.checksum,
    });
    const files = new FileObjectsService(f.db, storage, {} as never);
    await files.purgeUnreferenced(excludedFile.id);
    assert.equal(
      (
        await f.db.fileObject.findUniqueOrThrow({
          where: { id: excludedFile.id },
        })
      ).lifecycleStatus,
      "active",
    );
    assert.ok(await storage.head(excludedFile.objectKey));

    const works = new WorksService(f.db, files, {} as never);
    const source = await works.source(work.id);
    assert.deepEqual(
      source.media.map(({ adopted, workOrderIndex }) => [
        adopted,
        workOrderIndex,
      ]),
      [
        [true, 1],
        [false, null],
        [true, 0],
      ],
    );
    assert.match(
      (await works.sourceMediaUrl(work.id, ids[1])).url!,
      /^memory:/,
    );
    await assert.rejects(
      works.sourceMediaUrl(work.id, (await post(f, 1)).media[0].id),
      /来源图片不存在/,
    );
  } finally {
    await close(f);
  }
});

test("default import adopts all images and equivalent explicit intent replays without duplicate effects", async () => {
  const f = await candidateReviewFixture();
  try {
    const candidate = await post(f);
    const item = { id: candidate.id, expectedRevision: candidate.revision };
    const first = (
      await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [item],
      })
    ).results[0];
    assert.equal(first.outcome, "succeeded");
    const explicit = { ...item, mediaIds: candidate.media.map(({ id }) => id) };
    for (const retry of [item, explicit]) {
      const replay = (
        await f.service.batch(f.actor.id, {
          action: CandidateAction.import,
          items: [retry],
        })
      ).results[0];
      assert.equal(replay.outcome, "unchanged");
      assert.equal(replay.workId, first.workId);
    }
    assert.equal(
      await f.db.workImage.count({ where: { workId: first.workId! } }),
      3,
    );
    assert.equal(
      await f.db.candidateActionLog.count({
        where: { candidatePostId: candidate.id },
      }),
      1,
    );
    assert.equal(
      await f.db.workEvent.count({ where: { workId: first.workId! } }),
      1,
    );
  } finally {
    await close(f);
  }
});

test("response-loss retries reject changed selection, page order and expected revision even after author archival", async () => {
  const f = await candidateReviewFixture();
  try {
    const candidate = await post(f);
    const [a, b, c] = candidate.media.map(({ id }) => id);
    const item = { id: candidate.id, expectedRevision: 0, mediaIds: [c, a] };
    const first = (
      await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [item],
      })
    ).results[0];
    await f.db.author.update({
      where: { id: f.author.id },
      data: { deletedAt: new Date(), authorizationStatus: "revoked" },
    });
    for (const changed of [
      { ...item, mediaIds: [a, c] },
      { ...item, mediaIds: [c, b] },
      { ...item, mediaIds: undefined },
      { ...item, expectedRevision: 1 },
    ]) {
      assert.equal(
        (
          await f.service.batch(f.actor.id, {
            action: CandidateAction.import,
            items: [changed],
          })
        ).results[0].outcome,
        "conflict",
      );
    }
    const replay = (
      await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [item],
      })
    ).results[0];
    assert.equal(replay.outcome, "unchanged");
    assert.equal(replay.workId, first.workId);
    assert.equal(
      await f.db.work.count({ where: { sourceCandidatePostId: candidate.id } }),
      1,
    );
  } finally {
    await close(f);
  }
});

test("invalid media and media options on nonimport actions fail independently without modifying candidates", async () => {
  const f = await candidateReviewFixture();
  try {
    const bad = await post(f),
      foreign = await post(f),
      good = await post(f);
    const results = (
      await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [
          { id: bad.id, expectedRevision: 0, mediaIds: [foreign.media[0].id] },
          { id: good.id, expectedRevision: 0, mediaIds: [good.media[1].id] },
        ],
      })
    ).results;
    assert.deepEqual(
      results.map(({ outcome }) => outcome),
      ["conflict", "succeeded"],
    );
    for (const mediaIds of [[], [bad.media[0].id, bad.media[0].id], null]) {
      const result = await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [
          { id: bad.id, expectedRevision: 0, mediaIds: mediaIds as never },
        ],
      });
      assert.equal(result.results[0].outcome, "conflict");
    }
    for (const action of [CandidateAction.discard, CandidateAction.restore]) {
      assert.equal(
        (
          await f.service.batch(f.actor.id, {
            action,
            items: [
              { id: bad.id, expectedRevision: 0, mediaIds: [bad.media[0].id] },
            ],
          })
        ).results[0].outcome,
        "conflict",
      );
    }
    const unchanged = await f.db.candidatePost.findUniqueOrThrow({
      where: { id: bad.id },
    });
    assert.equal(unchanged.status, "pending");
    assert.equal(unchanged.revision, 0);
    assert.equal(
      await f.db.work.count({ where: { sourceCandidatePostId: bad.id } }),
      0,
    );
  } finally {
    await close(f);
  }
});

test("concurrent identical imports replay one work while concurrent different ordered selections conflict", async () => {
  const f = await candidateReviewFixture();
  try {
    for (const different of [false, true]) {
      const candidate = await post(f);
      const [a, b] = candidate.media.map(({ id }) => id);
      const items = [
        { id: candidate.id, expectedRevision: 0, mediaIds: [b, a] },
        {
          id: candidate.id,
          expectedRevision: 0,
          mediaIds: different ? [a, b] : [b, a],
        },
      ];
      const results = await Promise.all(
        items.map(
          async (item) =>
            (
              await f.service.batch(f.actor.id, {
                action: CandidateAction.import,
                items: [item],
              })
            ).results[0],
        ),
      );
      assert.deepEqual(
        results.map(({ outcome }) => outcome).sort(),
        different ? ["conflict", "succeeded"] : ["succeeded", "unchanged"],
      );
      assert.equal(
        await f.db.work.count({
          where: { sourceCandidatePostId: candidate.id },
        }),
        1,
      );
      assert.equal(
        await f.db.candidateActionLog.count({
          where: { candidatePostId: candidate.id },
        }),
        1,
      );
    }
  } finally {
    await close(f);
  }
});

function pausedInitialRead(f: Fixture) {
  let reached!: () => void, resume!: () => void;
  const read = new Promise<void>((resolve) => (reached = resolve));
  const proceed = new Promise<void>((resolve) => (resume = resolve));
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(
          async (tx) => {
            let paused = false;
            const candidatePost = new Proxy(tx.candidatePost, {
              get(model, field) {
                if (field !== "findUnique") return Reflect.get(model, field);
                return async (...args: unknown[]) => {
                  const value = await Reflect.apply(
                    model.findUnique,
                    model,
                    args,
                  );
                  if (!paused) {
                    paused = true;
                    reached();
                    await proceed;
                  }
                  return value;
                };
              },
            });
            return run(
              new Proxy(tx, {
                get(client, field) {
                  return field === "candidatePost"
                    ? candidatePost
                    : Reflect.get(client, field);
                },
              }),
            );
          },
          { timeout: 15_000 },
        );
    },
  }) as PrismaService;
  return { service: new CandidatesService(db, {} as never), read, resume };
}

test("a concurrent candidate reorder after confirmation conflicts rather than adopting the old order", async () => {
  const f = await candidateReviewFixture();
  const paused = pausedInitialRead(f);
  let importing: ReturnType<CandidatesService["batch"]> | undefined;
  try {
    const candidate = await post(f);
    const mediaIds = candidate.media.map(({ id }) => id);
    importing = paused.service.batch(f.actor.id, {
      action: CandidateAction.import,
      items: [{ id: candidate.id, expectedRevision: 0, mediaIds }],
    });
    await paused.read;
    await f.service.reorderMedia(candidate.id, {
      expectedRevision: 0,
      mediaIds: [...mediaIds].reverse(),
    });
    paused.resume();
    assert.equal((await importing).results[0].outcome, "conflict");
    assert.equal(
      await f.db.work.count({ where: { sourceCandidatePostId: candidate.id } }),
      0,
    );
  } finally {
    paused.resume();
    await importing;
    await close(f);
  }
});

test("legacy omitted replay is compatible while explicit selections cannot claim an unknown historical intent", async () => {
  const f = await candidateReviewFixture();
  try {
    const candidate = await post(f);
    const item = { id: candidate.id, expectedRevision: 0 };
    const first = (
      await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [item],
      })
    ).results[0];
    await f.db.workCandidateSource.updateMany({
      where: { workId: first.workId! },
      data: { importedRevision: null, mappingKnown: false },
    });
    await f.db.workImage.updateMany({
      where: { workId: first.workId! },
      data: { sourceCandidateMediaId: null },
    });
    assert.equal(
      (
        await f.service.batch(f.actor.id, {
          action: CandidateAction.import,
          items: [item],
        })
      ).results[0].outcome,
      "unchanged",
    );
    assert.equal(
      (
        await f.service.batch(f.actor.id, {
          action: CandidateAction.import,
          items: [{ ...item, mediaIds: candidate.media.map(({ id }) => id) }],
        })
      ).results[0].outcome,
      "conflict",
    );
    const source = await new WorksService(
      f.db,
      {} as never,
      {} as never,
    ).source(first.workId!);
    assert.deepEqual(
      source.media.map(({ adopted }) => adopted),
      [null, null, null],
    );
  } finally {
    await close(f);
  }
});
