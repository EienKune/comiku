import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import {
  IMAGE_ANALYSIS_ADAPTER,
  activateImageAnalysisAdapter,
} from "../../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../../src/image-analysis/example-adapter.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL required");

test("model switches hide stale summaries and rebuild existing history in bounded batches", async () => {
  const model = activateImageAnalysisAdapter(
    createExampleImageAnalysisAdapter(),
  );
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  })
    .overrideProvider(IMAGE_ANALYSIS_ADAPTER)
    .useValue(model)
    .compile();
  const app = module.createNestApplication();
  await app.init();
  const db = app.get(PrismaService),
    files = app.get(FileObjectsService);
  const author = await db.author.create({
    data: { displayName: "Model switch fixture" },
  });
  const postIds = Array.from({ length: 21 }, () => randomUUID());
  const mediaIds = postIds.map(() => randomUUID());
  const previousKey = "a".repeat(64);
  let fileId = "";
  try {
    const file = await files.store({
      body: Buffer.from("switch-fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "model-switch-fixture",
    });
    fileId = file.id;
    await db.candidatePost.createMany({
      data: postIds.map((id, index) => ({
        id,
        authorId: author.id,
        platform: "fixture",
        externalPostId: id,
        postedAt: new Date(index * 1000),
        rawJson: {},
        analysisModelKey: index === 0 ? null : previousKey,
        analysisScore: 0.99,
        analysisState: "succeeded",
      })),
    });
    await db.candidateMedia.createMany({
      data: mediaIds.map((id, index) => ({
        id,
        candidatePostId: postIds[index],
        fileObjectId: file.id,
        externalMediaId: id,
        orderIndex: 0,
        mediaType: "photo",
      })),
    });
    await db.candidateMediaAnalysis.createMany({
      data: mediaIds.flatMap((mediaId) =>
        [previousKey, model.modelKey].map((modelKey) => ({
          mediaId,
          modelKey,
          modelRevision: "fixture",
          decisionVersion: "fixture",
          sourceSha256: file.checksum,
          status: "succeeded",
          score: modelKey === previousKey ? 0.99 : 0.2,
          resultJson: { fixture: true },
        })),
      ),
    });
    const candidates = app.get(CandidatesService),
      analysis = app.get(ImageAnalysisService);
    const before = await candidates.list({ authorId: author.id, limit: 24 });
    assert.ok(
      before.items.every((post) => post.reviewPriority === "unprocessed"),
    );
    assert.equal(before.items[0].id, postIds.at(-1));
    await analysis.schedulePending();
    assert.equal(
      await db.candidatePost.count({
        where: { authorId: author.id, analysisModelKey: model.modelKey },
      }),
      20,
    );
    await analysis.schedulePending();
    const after = await candidates.list({ authorId: author.id, limit: 24 });
    assert.equal(after.items.length, 21);
    assert.ok(after.items.every((post) => post.reviewPriority === "low"));
    assert.ok(
      after.items.every(
        (post) => post.revision === 0 && post.status === "pending",
      ),
    );
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { mediaId: { in: mediaIds } },
      }),
      42,
    );
    assert.equal(
      await db.backgroundJob.count({
        where: { kind: "image_analysis", resourceId: { in: mediaIds } },
      }),
      0,
    );
    const old = await db.candidateMediaAnalysis.findFirstOrThrow({
      where: { mediaId: mediaIds[0], modelKey: previousKey },
    });
    assert.equal(old.score, 0.99);
    assert.equal(old.status, "succeeded");
  } finally {
    await db.backgroundJob.deleteMany({
      where: { kind: "image_analysis", resourceId: { in: mediaIds } },
    });
    await db.candidatePost.deleteMany({ where: { id: { in: postIds } } });
    await db.author.delete({ where: { id: author.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await app.close();
  }
});

test("current-model SQL-null prediction caches rebuild from winners without inference or identity changes", async () => {
  const example = createExampleImageAnalysisAdapter();
  const model = activateImageAnalysisAdapter({
    ...example,
    async analyze() {
      assert.fail("Stored successes must never be inferred again");
    },
  });
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
      ),
    ],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  const db = app.get(PrismaService),
    files = app.get(FileObjectsService);
  const author = await db.author.create({
    data: { displayName: "Prediction cache fixture" },
  });
  let postId = "",
    fileId = "";
  try {
    const file = await files.store({
      body: Buffer.from("prediction-fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "prediction-cache-fixture",
    });
    fileId = file.id;
    const post = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
        analysisModelKey: model.modelKey,
        analysisScore: 0.99,
        analysisState: "succeeded",
        analysisPredictions: Prisma.DbNull,
        media: {
          create: [0, 1].map((orderIndex) => ({
            fileObjectId: file.id,
            externalMediaId: String(orderIndex),
            orderIndex,
            mediaType: "photo",
          })),
        },
      },
      include: { media: { orderBy: { orderIndex: "asc" } } },
    });
    postId = post.id;
    const results = [
      {
        score: 0.99,
        predictedClass: "comic",
        classScores: [
          { label: "comic", value: 0.485 },
          { label: "comic_related", value: 0.3 },
          { label: "other", value: 0.215 },
        ],
        evidence: [],
      },
      {
        score: 0.1,
        predictedClass: "other",
        classScores: [
          { label: "comic", value: 0.1 },
          { label: "comic_related", value: 0.1 },
          { label: "other", value: 0.8 },
        ],
        evidence: [],
      },
    ];
    await db.candidateMediaAnalysis.createMany({
      data: post.media.map((media, index) => ({
        mediaId: media.id,
        modelKey: model.modelKey,
        modelRevision: model.identity.modelRevision,
        decisionVersion: model.identity.decisionVersion,
        sourceSha256: file.checksum,
        status: "succeeded",
        score: results[index].score,
        resultJson: {
          ...results[index],
          identity: model.identity,
          modelKey: model.modelKey,
        } as unknown as Prisma.InputJsonValue,
      })),
    });
    const service = new ImageAnalysisService(
      db,
      new JobsService(db),
      files,
      model,
    );
    await service.schedulePending(post.id);
    const rebuilt = await db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(rebuilt.analysisModelKey, model.modelKey);
    assert.equal(rebuilt.analysisScore, 0.99);
    assert.deepEqual(rebuilt.analysisPredictions, [
      { label: "comic", confidence: 0.485 },
      { label: "other", confidence: 0.8 },
    ]);
    assert.equal(service.promotesReview(rebuilt.analysisPredictions), false);
    const updatedPolicy = activateImageAnalysisAdapter({
      ...example,
      reviewPolicy: { positiveLabels: ["comic"], minimumConfidence: 0.4 },
    });
    assert.equal(updatedPolicy.modelKey, model.modelKey);
    assert.equal(
      new ImageAnalysisService(
        db,
        new JobsService(db),
        files,
        updatedPolicy,
      ).promotesReview(rebuilt.analysisPredictions),
      true,
    );
    await service.schedulePending(post.id);
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { media: { candidatePostId: post.id } },
      }),
      2,
    );
    assert.equal(
      await db.backgroundJob.count({
        where: {
          kind: "image_analysis",
          resourceId: { in: post.media.map((media) => media.id) },
        },
      }),
      0,
    );
    assert.equal(rebuilt.status, post.status);
    assert.equal(rebuilt.revision, post.revision);
    assert.deepEqual(
      (
        await db.candidateMediaAnalysis.findUniqueOrThrow({
          where: {
            mediaId_modelKey: {
              mediaId: post.media[0].id,
              modelKey: model.modelKey,
            },
          },
        })
      ).resultJson,
      { ...results[0], identity: model.identity, modelKey: model.modelKey },
    );
  } finally {
    if (postId) await db.candidatePost.delete({ where: { id: postId } });
    await db.author.delete({ where: { id: author.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await app.close();
  }
});
