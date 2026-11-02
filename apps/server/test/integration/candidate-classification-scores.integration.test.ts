import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import { activateImageAnalysisAdapter } from "../../src/image-analysis/image-analysis-adapter.js";
import { Prisma } from "../../src/generated/prisma/client.js";

test("score projection enforces current model, checksum, lifecycle and valid vectors without loading private evidence", async () => {
  const f = await candidateReviewFixture();
  const fileIds = Array.from({ length: 9 }, () => randomUUID());
  try {
    const post = await f.post({ analysisPredictions: [] });
    await f.db.fileObject.createMany({
      data: fileIds.map((id, index) => ({
        id,
        objectKey: `synthetic-scores/${id}`,
        bucketScope: "source",
        kind: "synthetic-score-fixture",
        contentType: "image/jpeg",
        size: 1n,
        checksum: "c".repeat(64),
        ...(index === 6
          ? { lifecycleStatus: "deleted" as const, deletedAt: new Date() }
          : {}),
      })),
    });
    const mediaIds = Array.from({ length: 9 }, () => randomUUID());
    await f.db.candidateMedia.createMany({
      data: [...mediaIds].reverse().map((id) => {
        const index = mediaIds.indexOf(id);
        return {
          id,
          candidatePostId: post.id,
          externalMediaId: id,
          orderIndex: index * 2,
          fileObjectId: fileIds[index],
          mediaType: "photo",
        };
      }),
    });
    const good = {
      score: 0.9,
      predictedClass: "positive",
      classScores: [
        {
          label: "positive",
          value: 0.8,
          unreturned: "synthetic-private-vector",
        },
        { label: "related", value: 0.15 },
        { label: "other", value: 0.05 },
      ],
      evidence: [
        { private: "synthetic-private-evidence", payload: "x".repeat(900000) },
      ],
      privateUrl: "https://synthetic.invalid/private",
    };
    await f.db.candidateMediaAnalysis.createMany({
      data: mediaIds.slice(0, 8).map((mediaId, index) => ({
        mediaId,
        modelKey: index === 1 ? "old-model" : f.model.modelKey,
        modelRevision: "1",
        decisionVersion: "1",
        sourceSha256: index === 2 ? "b".repeat(64) : "c".repeat(64),
        status: index === 4 ? "queued" : index === 5 ? "failed" : "succeeded",
        score: 0.9,
        resultJson:
          index === 3
            ? { ...good, predictedClass: "other" }
            : index === 7
              ? { ...good, classScores: { not: "array" } }
              : good,
      })),
    });
    const jobsBefore = await f.db.backgroundJob.count();
    const result = await f.analysis.classificationScores(post.id);
    assert.deepEqual(
      result.images.map((row) => row.mediaId),
      mediaIds,
    );
    assert.deepEqual(
      result.images.map((row) => row.index),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.deepEqual(
      result.images.map((row) => row.state),
      [
        "succeeded",
        "unavailable",
        "unavailable",
        "unavailable",
        "pending",
        "failed",
        "unavailable",
        "unavailable",
        "unavailable",
      ],
    );
    assert.deepEqual(result.images[0].scores, [0.8, 0.15, 0.05]);
    assert.equal(result.images[0].winner, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 3000);
    assert.doesNotMatch(
      JSON.stringify(result),
      /synthetic-private|privateUrl|evidence|payload|sourceSha/,
    );
    assert.equal(await f.db.backgroundJob.count(), jobsBefore);
    await f.db.author.update({
      where: { id: f.author.id },
      data: { deletedAt: new Date() },
    });
    await assert.rejects(f.analysis.classificationScores(post.id), {
      status: 404,
    });
    await assert.rejects(f.analysis.classificationScores(randomUUID()), {
      status: 404,
    });
  } finally {
    await f.db.candidatePost.deleteMany({ where: { authorId: f.author.id } });
    await f.db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
    await f.close();
  }
});

test("binary and 100-label score contracts keep complete ordered numeric vectors and share columns", async () => {
  const f = await candidateReviewFixture();
  const fileId = randomUUID();
  try {
    const post = await f.post({ analysisPredictions: [] });
    await f.db.fileObject.create({
      data: {
        id: fileId,
        objectKey: `synthetic-scores/${fileId}`,
        bucketScope: "source",
        kind: "synthetic-score-fixture",
        contentType: "image/jpeg",
        size: 1n,
        checksum: "c".repeat(64),
      },
    });
    const media = await f.db.candidateMedia.create({
      data: {
        candidatePostId: post.id,
        externalMediaId: "one",
        orderIndex: 0,
        fileObjectId: fileId,
        mediaType: "photo",
      },
    });
    for (const count of [2, 100]) {
      const labels = Array.from(
        { length: count },
        (_, i) => `class-${i}-${"l".repeat(240)}`,
      );
      const model = activateImageAnalysisAdapter({
        identity: { ...f.model.identity, labels },
        analyze: async () => {
          throw Error("No inference");
        },
      });
      const vector = labels.map((label, i) => ({
        label,
        value: i === count - 1 ? 0.8 : 0.2 / (count - 1),
      }));
      await f.db.candidateMediaAnalysis.create({
        data: {
          mediaId: media.id,
          modelKey: model.modelKey,
          modelRevision: "1",
          decisionVersion: "1",
          sourceSha256: "c".repeat(64),
          status: "succeeded",
          score: 0.9,
          resultJson: {
            score: 0.9,
            predictedClass: labels[count - 1],
            classScores: vector,
            evidence: [],
          } as Prisma.InputJsonValue,
        },
      });
      const analysis = new ImageAnalysisService(
        f.db,
        {} as never,
        {} as never,
        model,
      );
      const value = await analysis.classificationScores(post.id);
      assert.equal(value.columns.length, count);
      assert.deepEqual(
        value.images[0].scores,
        vector.map((v) => v.value),
      );
      assert.equal(value.images[0].winner, count - 1);
    }
    const disabled = new ImageAnalysisService(
      f.db,
      {} as never,
      {} as never,
      null,
    );
    const off = await disabled.classificationScores(post.id);
    assert.equal(off.modelKey, null);
    assert.deepEqual(off.columns, []);
    assert.equal(off.images.length, 1);
    assert.equal(off.images[0].scores, null);
  } finally {
    await f.db.candidatePost.deleteMany({ where: { authorId: f.author.id } });
    await f.db.fileObject.deleteMany({ where: { id: fileId } });
    await f.close();
  }
});
