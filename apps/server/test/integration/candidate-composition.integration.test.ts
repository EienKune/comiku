import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { ConflictException } from "@nestjs/common";
import { CandidateCompositionsService } from "../../src/candidates/composition.service.js";
import type { ComposeCandidatesDto } from "../../src/candidates/composition.dto.js";
import { CandidateAction } from "../../src/candidates/candidates.dto.js";
import { parseEnvironment } from "../../src/config/environment.js";
import type { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { WorkSeriesService } from "../../src/work-series/work-series.service.js";
import { WorksService } from "../../src/works/works.service.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

async function fixture() {
  const f = await candidateReviewFixture();
  const session = await f.db.authSession.create({
    data: {
      userId: f.actor.id,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const actor = { userId: f.actor.id, sessionId: session.id };
  const authorization = new WorkSeriesService(
    f.db,
    parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    }),
  );
  const service = new CandidateCompositionsService(f.db, authorization);
  const bulkFileIds: string[] = [];
  return {
    ...f,
    actor,
    service,
    authorization,
    async postWithMedia(count = 3, postedAt = new Date()) {
      const candidate = await f.post({
        postedAt,
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
    },
    async postWithBatchMedia(count: number) {
      const candidate = await f.db.candidatePost.create({
        data: {
          authorId: f.author.id,
          platform: "composition-boundary",
          externalPostId: randomUUID(),
          postedAt: new Date(),
          text: "Synthetic boundary source",
          rawJson: {},
        },
      });
      const media = Array.from({ length: count }, (_, orderIndex) => ({
        id: randomUUID(),
        fileObjectId: randomUUID(),
        candidatePostId: candidate.id,
        externalMediaId: randomUUID(),
        orderIndex,
        width: 10,
        height: 20,
        mediaType: "photo",
      }));
      bulkFileIds.push(...media.map((item) => item.fileObjectId));
      for (let index = 0; index < media.length; index += 200) {
        const batch = media.slice(index, index + 200);
        await f.db.fileObject.createMany({
          data: batch.map((item) => ({
            id: item.fileObjectId,
            objectKey: `composition-boundary-${randomUUID()}`,
            bucketScope: "source",
            kind: "fixture",
            contentType: "image/jpeg",
            size: 1,
            checksum: "a".repeat(64),
          })),
        });
        await f.db.candidateMedia.createMany({ data: batch });
      }
      return { ...candidate, media };
    },
    async close() {
      await f.db.candidateActionLog.deleteMany({
        where: { actorId: f.actor.id },
      });
      await f.db.workEvent.deleteMany({ where: { actorId: f.actor.id } });
      await f.db.work.deleteMany({ where: { importedById: f.actor.id } });
      await f.db.candidateCompositionReceipt.deleteMany({
        where: { actorId: f.actor.id },
      });
      await f.db.authSession.deleteMany({ where: { userId: f.actor.id } });
      if (bulkFileIds.length) {
        await f.db.candidatePost.deleteMany({
          where: { authorId: f.author.id },
        });
        for (let index = 0; index < bulkFileIds.length; index += 200)
          await f.db.fileObject.deleteMany({
            where: { id: { in: bulkFileIds.slice(index, index + 200) } },
          });
      }
      await f.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function pausedComposition(f: Fixture, phase: "observed" | "create") {
  const reached = gate(),
    resume = gate();
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(
          async (tx) => {
            let paused = false;
            const modelName = phase === "observed" ? "candidatePost" : "work";
            const method = phase === "observed" ? "findMany" : "create";
            return run(
              new Proxy(tx, {
                get(client, field) {
                  if (field !== modelName) return Reflect.get(client, field);
                  return new Proxy(client[modelName], {
                    get(model, member) {
                      if (member !== method) return Reflect.get(model, member);
                      return async (...args: unknown[]) => {
                        if (phase === "create" && !paused) {
                          paused = true;
                          reached.resolve();
                          await resume.promise;
                        }
                        const value = await Reflect.apply(
                          Reflect.get(model, member),
                          model,
                          args,
                        );
                        if (phase === "observed" && !paused) {
                          paused = true;
                          reached.resolve();
                          await resume.promise;
                        }
                        return value;
                      };
                    },
                  });
                },
              }),
            );
          },
          { timeout: 20_000 },
        );
    },
  }) as PrismaService;
  return {
    service: new CandidateCompositionsService(db, f.authorization),
    reached: reached.promise,
    resume: () => resume.resolve(),
  };
}

function transactionPid(f: Fixture) {
  const pid = gate<number>();
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(
          async (tx) => {
            const [row] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            pid.resolve(row.pid);
            return run(tx);
          },
          { timeout: 20_000 },
        );
    },
  }) as PrismaService;
  return {
    service: new CandidateCompositionsService(db, f.authorization),
    pid: pid.promise,
  };
}

async function assertTransactionBlocked(db: PrismaService, pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await db.$queryRaw<
      { blocked: boolean }[]
    >`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
    if (row.blocked) return;
    await delay(10);
  }
  assert.fail(
    "expected the competing transaction to wait on a business row lock",
  );
}

async function split(f: Fixture): Promise<ComposeCandidatesDto> {
  const candidate = await f.postWithMedia();
  return {
    idempotencyKey: randomUUID(),
    mode: "split",
    candidates: [{ id: candidate.id, expectedRevision: 0 }],
    works: [
      { title: "One", mediaIds: [candidate.media[1].id] },
      { title: "Two", mediaIds: [candidate.media[0].id] },
    ],
  };
}

test("merge stores chronological explicit sources, adopted order, one event and a durable actor receipt", async () => {
  const f = await fixture();
  try {
    const late = await f.postWithMedia(2, new Date("2026-02-02")),
      early = await f.postWithMedia(2, new Date("2026-02-01"));
    await f.db.candidatePost.update({
      where: { id: early.id },
      data: {
        text: "Primary only",
        externalPostUrl: "https://example.test/primary",
      },
    });
    const input: ComposeCandidatesDto = {
      idempotencyKey: randomUUID(),
      mode: "merge",
      candidates: [late, early].map(({ id }) => ({ id, expectedRevision: 0 })),
      works: [{ title: null, mediaIds: [late.media[1].id, early.media[0].id] }],
    };
    const result = await f.service.compose(f.actor, input);
    assert.equal(result.works.length, 1);
    assert.deepEqual(result.works[0].sourceCandidateIds, [early.id, late.id]);
    const work = await f.db.work.findUniqueOrThrow({
      where: { id: result.works[0].workId },
      include: {
        sources: { orderBy: { orderIndex: "asc" } },
        images: { orderBy: { orderIndex: "asc" } },
      },
    });
    assert.equal(work.sourceCandidatePostId, early.id);
    assert.equal(work.sourceText, "Primary only");
    assert.equal(work.publicationBody, null);
    assert.deepEqual(
      work.sources.map((source) => [
        source.candidatePostId,
        source.importedRevision,
        source.mappingKnown,
      ]),
      [
        [early.id, 0, true],
        [late.id, 0, true],
      ],
    );
    assert.deepEqual(
      work.images.map((image) => image.sourceCandidateMediaId),
      input.works[0].mediaIds,
    );
    assert.equal(
      await f.db.workEvent.count({
        where: { workId: work.id, action: "imported" },
      }),
      1,
    );
    assert.deepEqual(
      await f.service.compose(f.actor, {
        ...input,
        candidates: [...input.candidates].reverse(),
      }),
      result,
    );
    assert.deepEqual(
      await f.service.result(f.actor, input.idempotencyKey),
      result,
    );
    assert.equal(
      await f.db.candidateMedia.count({
        where: { candidatePostId: { in: [early.id, late.id] } },
      }),
      4,
    );
    for (const candidate of [early, late]) {
      const ordinary = (
        await new (
          await import("../../src/candidates/candidates.service.js")
        ).CandidatesService(f.db, {} as never).batch(f.actor.userId, {
          action: CandidateAction.import,
          items: [{ id: candidate.id, expectedRevision: 0 }],
        })
      ).results[0];
      assert.equal(ordinary.outcome, "conflict");
    }
    const reader = new WorksService(
      f.db,
      {
        imageUrl: async (fileId: string) => ({ url: `memory:${fileId}` }),
      } as never,
      {} as never,
    );
    const source = await reader.source(work.id);
    assert.equal(source.sources.length, 2);
    assert.deepEqual(
      source.sources.flatMap((entry) =>
        entry.media.map((media) => media.disposition),
      ),
      ["this_work", "unadopted", "unadopted", "this_work"],
    );
    assert.ok((await reader.sourceMediaUrl(work.id, late.media[0].id)).url);
    const unrelated = await f.postWithMedia(1);
    await assert.rejects(
      reader.sourceMediaUrl(work.id, unrelated.media[0].id),
      /来源图片不存在/,
    );
  } finally {
    await f.close();
  }
});

test("different actors contend on the candidate lock and create exactly one complete composition", async () => {
  const owner = await fixture(),
    other = await fixture();
  const paused = pausedComposition(owner, "create"),
    competing = transactionPid(other);
  let creating: ReturnType<CandidateCompositionsService["compose"]> | undefined;
  let racing: ReturnType<CandidateCompositionsService["compose"]> | undefined;
  try {
    const input = await split(owner);
    creating = paused.service.compose(owner.actor, input);
    await paused.reached;
    racing = competing.service.compose(other.actor, {
      ...input,
      idempotencyKey: randomUUID(),
    });
    const settled = Promise.allSettled([creating, racing]);
    await assertTransactionBlocked(owner.db, await competing.pid);
    paused.resume();
    const results = await settled;
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected")
      assert.ok(results[1].reason instanceof ConflictException);
    assert.equal(
      await owner.db.work.count({ where: { authorId: owner.author.id } }),
      2,
    );
    assert.equal(
      await owner.db.work.count({
        where: { importedById: other.actor.userId },
      }),
      0,
    );
    assert.equal(
      await owner.db.workCandidateSource.count({
        where: { candidatePostId: input.candidates[0].id },
      }),
      2,
    );
    assert.equal(
      await owner.db.workImage.count({
        where: { work: { authorId: owner.author.id } },
      }),
      2,
    );
    assert.equal(
      await owner.db.workEvent.count({
        where: { actorId: owner.actor.userId, action: "imported" },
      }),
      2,
    );
    assert.equal(
      await owner.db.workEvent.count({
        where: { actorId: other.actor.userId },
      }),
      0,
    );
    assert.equal(
      await owner.db.candidateActionLog.count({
        where: { candidatePostId: input.candidates[0].id },
      }),
      1,
    );
    assert.equal(
      await owner.db.candidateCompositionReceipt.count({
        where: { actorId: owner.actor.userId },
      }),
      1,
    );
    assert.equal(
      await owner.db.candidateCompositionReceipt.count({
        where: { actorId: other.actor.userId },
      }),
      0,
    );
    const candidate = await owner.db.candidatePost.findUniqueOrThrow({
      where: { id: input.candidates[0].id },
      include: { media: true },
    });
    assert.deepEqual(
      [candidate.status, candidate.revision, candidate.media.length],
      ["imported", 1, 3],
    );
  } finally {
    paused.resume();
    await Promise.allSettled(
      [creating, racing].filter((promise) => promise !== undefined),
    );
    await other.close();
    await owner.close();
  }
});

for (const revokeFirst of [true, false]) {
  test(`author revocation ${revokeFirst ? "committed before" : "waiting after"} composition's author lock preserves atomic authorization`, async () => {
    const f = await fixture(),
      paused = pausedComposition(f, revokeFirst ? "observed" : "create");
    let creating:
      ReturnType<CandidateCompositionsService["compose"]> | undefined;
    let revoking: Promise<unknown> | undefined;
    try {
      const input = await split(f);
      creating = paused.service.compose(f.actor, input);
      const settled = Promise.allSettled([creating]);
      await paused.reached;
      if (revokeFirst)
        await f.db.author.update({
          where: { id: f.author.id },
          data: { authorizationStatus: "revoked" },
        });
      else {
        const pid = gate<number>();
        revoking = f.db.$transaction(
          async (tx) => {
            const [row] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            pid.resolve(row.pid);
            return tx.author.update({
              where: { id: f.author.id },
              data: { authorizationStatus: "revoked" },
            });
          },
          { timeout: 20_000 },
        );
        await assertTransactionBlocked(f.db, await pid.promise);
      }
      paused.resume();
      const [result] = await settled;
      assert.equal(result.status, revokeFirst ? "rejected" : "fulfilled");
      if (result.status === "rejected")
        assert.ok(result.reason instanceof ConflictException);
      await revoking;
      assert.equal(
        await f.db.work.count({ where: { importedById: f.actor.userId } }),
        revokeFirst ? 0 : 2,
      );
      assert.equal(
        await f.db.workEvent.count({ where: { actorId: f.actor.userId } }),
        revokeFirst ? 0 : 2,
      );
      assert.equal(
        await f.db.candidateCompositionReceipt.count({
          where: { actorId: f.actor.userId },
        }),
        revokeFirst ? 0 : 1,
      );
      assert.equal(
        (
          await f.db.candidatePost.findUniqueOrThrow({
            where: { id: input.candidates[0].id },
          })
        ).status,
        revokeFirst ? "pending" : "imported",
      );
    } finally {
      paused.resume();
      await Promise.allSettled(
        [creating, revoking].filter((promise) => promise !== undefined),
      );
      await f.close();
    }
  });
}

test("maximum 1000-original source splits into 20 ordered works without copying or mutating source references", async (t) => {
  const f = await fixture();
  try {
    const candidate = await f.postWithBatchMedia(1000);
    const fileIds = candidate.media.map((media) => media.fileObjectId);
    const originalMedia = await f.db.candidateMedia.findMany({
      where: { candidatePostId: candidate.id },
      orderBy: { orderIndex: "asc" },
    });
    const originalFiles = await f.db.fileObject.findMany({
      where: { id: { in: fileIds } },
      orderBy: { id: "asc" },
    });
    const reversed = candidate.media.map((media) => media.id).reverse();
    const input: ComposeCandidatesDto = {
      idempotencyKey: randomUUID(),
      mode: "split",
      candidates: [{ id: candidate.id, expectedRevision: 0 }],
      works: Array.from({ length: 20 }, (_, index) => ({
        title: `Boundary ${index + 1}`,
        mediaIds: reversed.slice(index * 50, (index + 1) * 50),
      })),
    };
    const started = performance.now();
    const result = await f.service.compose(f.actor, input);
    const elapsedMs = performance.now() - started;
    t.diagnostic(
      `maximum composition: originals=1000 outputs=20 adopted=1000 elapsed_ms=${elapsedMs.toFixed(1)}`,
    );
    assert.ok(
      elapsedMs < 30_000,
      "maximum composition must finish within its existing transaction budget",
    );
    assert.equal(result.works.length, 20);
    assert.equal(result.unadoptedMediaIds.length, 0);
    assert.equal(result.candidates[0].revision, 1);
    const works = await f.db.work.findMany({
      where: {
        candidateComposition: {
          actorId: f.actor.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      include: { images: { orderBy: { orderIndex: "asc" } }, sources: true },
    });
    const byId = new Map(works.map((work) => [work.id, work]));
    for (const [index, receipt] of result.works.entries()) {
      const work = byId.get(receipt.workId)!;
      assert.equal(work.title, `Boundary ${index + 1}`);
      assert.equal(receipt.imageCount, 50);
      assert.deepEqual(receipt.sourceCandidateIds, [candidate.id]);
      assert.equal(work.sourceCandidatePostId, candidate.id);
      assert.deepEqual(
        work.images.map((image) => image.sourceCandidateMediaId),
        input.works[index].mediaIds,
      );
      assert.deepEqual(
        work.images.map((image) => image.orderIndex),
        Array.from({ length: 50 }, (_, order) => order),
      );
      const originals = new Map<string, string>(
        candidate.media.map((media) => [media.id, media.fileObjectId]),
      );
      assert.ok(
        work.images.every(
          (image) =>
            image.originalFileObjectId ===
            originals.get(image.sourceCandidateMediaId!),
        ),
      );
      assert.deepEqual(
        work.sources.map((source) => [
          source.candidatePostId,
          source.importedRevision,
          source.mappingKnown,
        ]),
        [[candidate.id, 0, true]],
      );
    }
    assert.equal(
      await f.db.workEvent.count({
        where: { actorId: f.actor.userId, action: "imported" },
      }),
      20,
    );
    assert.equal(
      await f.db.workImage.count({
        where: { work: { authorId: f.author.id } },
      }),
      1000,
    );
    assert.equal(
      await f.db.candidateCompositionReceipt.count({
        where: { actorId: f.actor.userId },
      }),
      1,
    );
    assert.deepEqual(
      await f.db.candidateMedia.findMany({
        where: { candidatePostId: candidate.id },
        orderBy: { orderIndex: "asc" },
      }),
      originalMedia,
    );
    assert.deepEqual(
      await f.db.fileObject.findMany({
        where: { id: { in: fileIds } },
        orderBy: { id: "asc" },
      }),
      originalFiles,
    );
    assert.deepEqual(await f.service.compose(f.actor, input), result);
    assert.equal(
      await f.db.workEvent.count({
        where: { actorId: f.actor.userId, action: "imported" },
      }),
      20,
    );
  } finally {
    await f.close();
  }
});

test("split returns every work, shared source dispositions, and rejects ordinary replay", async () => {
  const f = await fixture();
  try {
    const input = await split(f),
      result = await f.service.compose(f.actor, input);
    assert.equal(result.works.length, 2);
    assert.deepEqual(
      result.candidates[0].workIds,
      result.works.map((work) => work.workId),
    );
    const ordinary = (
      await new (
        await import("../../src/candidates/candidates.service.js")
      ).CandidatesService(f.db, {} as never).batch(f.actor.userId, {
        action: CandidateAction.import,
        items: input.candidates,
      })
    ).results[0];
    assert.equal(ordinary.outcome, "conflict");
    const source = await new WorksService(
      f.db,
      {} as never,
      {} as never,
    ).source(result.works[0].workId);
    assert.deepEqual(
      source.media.map((media) => [media.disposition, media.adopted]),
      [
        ["other_work", null],
        ["this_work", true],
        ["unadopted", false],
      ],
    );
    assert.equal(source.media[0].adoptedByWork!.id, result.works[1].workId);
    assert.equal(
      await f.db.workEvent.count({
        where: { actorId: f.actor.userId, action: "imported" },
      }),
      2,
    );
  } finally {
    await f.close();
  }
});

test("second output failure rolls back every work, source, event, candidate transition and receipt", async () => {
  const f = await fixture();
  try {
    const input = await split(f);
    let creations = 0;
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            run(
              new Proxy(tx, {
                get(client, field) {
                  if (field !== "work") return Reflect.get(client, field);
                  return new Proxy(client.work, {
                    get(model, method) {
                      if (method !== "create")
                        return Reflect.get(model, method);
                      return (...args: unknown[]) => {
                        if (++creations === 2)
                          throw Error("synthetic second output failure");
                        return Reflect.apply(model.create, model, args);
                      };
                    },
                  });
                },
              }),
            ),
          );
      },
    }) as PrismaService;
    await assert.rejects(
      new CandidateCompositionsService(db, f.authorization).compose(
        f.actor,
        input,
      ),
      /synthetic second output failure/,
    );
    assert.equal(
      await f.db.work.count({ where: { importedById: f.actor.userId } }),
      0,
    );
    assert.equal(
      await f.db.workEvent.count({ where: { actorId: f.actor.userId } }),
      0,
    );
    assert.equal(
      await f.db.workCandidateSource.count({
        where: { candidatePostId: input.candidates[0].id },
      }),
      0,
    );
    assert.equal(
      await f.db.candidateCompositionReceipt.count({
        where: { actorId: f.actor.userId },
      }),
      0,
    );
    assert.equal(
      (
        await f.db.candidatePost.findUniqueOrThrow({
          where: { id: input.candidates[0].id },
        })
      ).status,
      "pending",
    );
  } finally {
    await f.close();
  }
});

test("concurrent same-key replay creates once while changed-key-payload conflicts", async () => {
  const f = await fixture();
  try {
    const input = await split(f);
    const [a, b] = await Promise.all([
      f.service.compose(f.actor, input),
      f.service.compose(f.actor, input),
    ]);
    assert.deepEqual(a, b);
    await assert.rejects(
      f.service.compose(f.actor, {
        ...input,
        works: [{ ...input.works[0], title: "Changed" }, input.works[1]],
      }),
      /其他入库意图/,
    );
    assert.equal(
      await f.db.candidateCompositionReceipt.count({
        where: { actorId: f.actor.userId },
      }),
      1,
    );
    assert.equal(
      await f.db.work.count({ where: { importedById: f.actor.userId } }),
      2,
    );
  } finally {
    await f.close();
  }
});

test("simultaneous changed intent cannot share a key and distinct keys cannot import the same source twice", async () => {
  const f = await fixture();
  try {
    for (const sameKey of [true, false]) {
      const input = await split(f);
      const changed = {
        ...input,
        idempotencyKey: sameKey ? input.idempotencyKey : randomUUID(),
        works: [{ ...input.works[0], title: "Alternative" }, input.works[1]],
      };
      const results = await Promise.allSettled([
        f.service.compose(f.actor, input),
        f.service.compose(f.actor, changed),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      assert.equal(
        await f.db.workCandidateSource.count({
          where: { candidatePostId: input.candidates[0].id },
        }),
        2,
      );
    }
  } finally {
    await f.close();
  }
});

test("successful composition receipts are private to their actor", async () => {
  const owner = await fixture(),
    other = await fixture();
  try {
    const input = await split(owner);
    await owner.service.compose(owner.actor, input);
    await assert.rejects(
      other.service.result(other.actor, input.idempotencyKey),
      /尚未查到/,
    );
    assert.equal(
      await other.db.candidateCompositionReceipt.count({
        where: { actorId: other.actor.userId },
      }),
      0,
    );
  } finally {
    await other.close();
    await owner.close();
  }
});

test("stale, foreign, inactive files, unrepresented sources and author changes never partially compose", async () => {
  const f = await fixture();
  try {
    for (const mutation of [
      "stale",
      "foreign",
      "file",
      "source",
      "author",
    ] as const) {
      const input = await split(f);
      if (mutation === "stale") input.candidates[0].expectedRevision++;
      if (mutation === "foreign")
        input.works[0].mediaIds = [(await f.postWithMedia(1)).media[0].id];
      if (mutation === "file")
        await f.db.fileObject.update({
          where: {
            id: (
              await f.db.candidateMedia.findUniqueOrThrow({
                where: { id: input.works[0].mediaIds[0] },
              })
            ).fileObjectId,
          },
          data: { lifecycleStatus: "pending_deletion" },
        });
      if (mutation === "source") {
        input.mode = "merge";
        input.candidates.push({
          id: (await f.postWithMedia(1)).id,
          expectedRevision: 0,
        });
        input.works = [
          {
            title: null,
            mediaIds: input.works.flatMap((work) => work.mediaIds),
          },
        ];
      }
      if (mutation === "author")
        await f.db.author.update({
          where: { id: f.author.id },
          data: { authorizationStatus: "revoked" },
        });
      await assert.rejects(f.service.compose(f.actor, input));
      assert.equal(
        await f.db.candidateCompositionReceipt.count({
          where: { actorId: f.actor.userId },
        }),
        0,
      );
      assert.equal(
        await f.db.work.count({ where: { importedById: f.actor.userId } }),
        0,
      );
    }
  } finally {
    await f.close();
  }
});

test("replay requires live session and current candidate-management permission", async () => {
  const f = await fixture();
  try {
    const input = await split(f);
    await f.service.compose(f.actor, input);
    await f.db.userRole.deleteMany({ where: { userId: f.actor.userId } });
    await assert.rejects(f.service.compose(f.actor, input), /权限/);
    await assert.rejects(
      f.service.result(f.actor, input.idempotencyKey),
      /权限/,
    );
    await f.db.userRole.create({
      data: { userId: f.actor.userId, role: "source" },
    });
    await f.db.authSession.update({
      where: { id: f.actor.sessionId },
      data: { revokedAt: new Date() },
    });
    await assert.rejects(f.service.compose(f.actor, input), /登录已失效/);
  } finally {
    await f.close();
  }
});
