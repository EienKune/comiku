import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import {
  IMAGE_ANALYSIS_ADAPTER,
  activateImageAnalysisAdapter,
  type ImageAnalysisResult,
} from "../../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../../src/image-analysis/example-adapter.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL required");
test("binary analysis persists independent priority, retries failures and preserves human review", async () => {
  let calls = 0;
  const example = createExampleImageAnalysisAdapter();
  const model = {
    ...activateImageAnalysisAdapter({
      ...example,
      labelPresentation: undefined,
      identity: {
        ...example.identity,
        adapterId: "binary-fixture",
        labels: ["accept", "reject"],
      },
      reviewPolicy: { positiveLabels: ["accept"], minimumConfidence: 0.5 },
    }),
  };
  model.analyze = async (): Promise<ImageAnalysisResult> => {
    calls++;
    if (calls === 1) throw Error("temporary");
    return {
      score: 0.9,
      predictedClass: "reject",
      classScores: [
        { label: "accept", value: 0.25 },
        { label: "reject", value: 0.75 },
      ],
      evidence: [],
    };
  };
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
  const jobs = new JobsService(db);
  const service = new ImageAnalysisService(db, jobs, files, model);
  service.onModuleInit();
  const author = await db.author.create({
    data: { displayName: "Analysis fixture" },
  });
  let candidateId = "",
    fileId = "";
  try {
    const file = await files.store({
      body: Buffer.from("fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "analysis-fixture",
    });
    fileId = file.id;
    const post = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
        status: "discarded",
        reviewedAt: new Date(),
        media: {
          create: {
            fileObjectId: file.id,
            externalMediaId: "image",
            orderIndex: 0,
            mediaType: "photo",
          },
        },
      },
    });
    candidateId = post.id;
    await service.schedulePending(post.id);
    await service.schedulePending(post.id);
    const media = await db.candidateMedia.findFirstOrThrow({
      where: { candidatePostId: post.id },
    });
    assert.equal(
      await db.candidateMediaAnalysis.count({ where: { mediaId: media.id } }),
      1,
    );
    const queued = await db.backgroundJob.findFirstOrThrow({
      where: { kind: "image_analysis", resourceId: media.id },
    });
    // Run the real handler via the leased worker; no model or network is called.
    const claimed = await jobs.claim("heavy");
    assert.equal(claimed?.id, queued.id);
    await jobs.execute(claimed!);
    assert.equal(
      (
        await db.candidateMediaAnalysis.findFirstOrThrow({
          where: { mediaId: media.id },
        })
      ).status,
      "queued",
    );
    await db.backgroundJob.update({
      where: { id: queued.id },
      data: { availableAt: new Date(0) },
    });
    await jobs.runNext("heavy");
    const done = await db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(done.analysisScore, 0.9);
    assert.equal(done.analysisState, "succeeded");
    assert.equal(done.analysisModelKey, model.modelKey);
    assert.deepEqual(done.analysisPredictions, [
      { label: "reject", confidence: 0.75, score: 0.9 },
    ]);
    assert.equal(service.promotesReview(done.analysisPredictions), false);
    const persisted = await db.candidateMediaAnalysis.findUniqueOrThrow({
      where: {
        mediaId_modelKey: { mediaId: media.id, modelKey: model.modelKey },
      },
    });
    assert.equal(persisted.score, 0.9);
    assert.deepEqual(
      (persisted.resultJson as { identity: { labels: string[] } }).identity
        .labels,
      ["accept", "reject"],
    );
    assert.equal(done.status, "discarded");
    assert.equal(done.revision, post.revision);
    assert.deepEqual(done.reviewedAt, post.reviewedAt);
    await service.schedulePending(post.id);
    assert.equal(
      await db.backgroundJob.count({
        where: { kind: "image_analysis", resourceId: media.id },
      }),
      1,
    );
    assert.equal(calls, 2);
    model.analyze = async (): Promise<ImageAnalysisResult> => {
      throw Error("temporary outage");
    };
    await db.candidateMediaAnalysis.updateMany({
      where: { mediaId: media.id },
      data: { status: "queued" },
    });
    await db.backgroundJob.update({
      where: { id: queued.id },
      data: { status: "queued", attempts: 0, availableAt: new Date(0) },
    });
    for (let i = 0; i < 3; i++) {
      await db.backgroundJob.update({
        where: { id: queued.id },
        data: { availableAt: new Date(0) },
      });
      await jobs.runNext("heavy");
    }
    const failed = await db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(failed.analysisState, "failed");
    assert.deepEqual(failed.analysisPredictions, []);
    assert.deepEqual(await service.retryFailed(post.id), { queued: 1 });
    assert.deepEqual(await service.retryFailed(post.id), { queued: 0 });
    await db.backgroundJob.update({
      where: { id: queued.id },
      data: { payload: { modelKey: "different-frozen-model" } },
    });
    await jobs.runNext("heavy");
    assert.equal(
      (
        await db.candidateMediaAnalysis.findFirstOrThrow({
          where: { mediaId: media.id },
        })
      ).status,
      "failed",
    );
    assert.equal(
      (await db.backgroundJob.findUniqueOrThrow({ where: { id: queued.id } }))
        .status,
      "failed",
    );
    // Crash after the final lease claim: no handler got to record the failure.
    await db.candidateMediaAnalysis.updateMany({
      where: { mediaId: media.id, modelKey: model.modelKey },
      data: { status: "queued" },
    });
    await db.backgroundJob.update({
      where: { id: queued.id },
      data: {
        status: "failed",
        attempts: 3,
        payload: { modelKey: model.modelKey },
      },
    });
    await service.schedulePending(post.id);
    assert.equal(
      (await db.candidatePost.findUniqueOrThrow({ where: { id: post.id } }))
        .analysisState,
      "failed",
    );
    assert.deepEqual(await service.retryFailed(post.id), { queued: 1 });
  } finally {
    const media = await db.candidateMedia.findMany({
      where: { candidatePostId: candidateId },
    });
    await db.backgroundJob.deleteMany({
      where: {
        kind: "image_analysis",
        resourceId: { in: media.map((m) => m.id) },
      },
    });
    if (candidateId)
      await db.candidatePost.delete({ where: { id: candidateId } });
    await db.author.delete({ where: { id: author.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await app.close();
  }
});

test("retired adapters settle safely with analysis disabled and replacement identities create independent results", async () => {
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
    data: { displayName: "Retired adapter fixture" },
  });
  let candidateId = "",
    fileId = "";
  try {
    const file = await files.store({
      body: Buffer.from("fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "retired-adapter-fixture",
    });
    fileId = file.id;
    const post = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
        status: "discarded",
        reviewedAt: new Date(),
        media: {
          create: [0, 1].map((orderIndex) => ({
            fileObjectId: file.id,
            externalMediaId: `image-${orderIndex}`,
            orderIndex,
            mediaType: "photo",
          })),
        },
      },
      include: { media: { orderBy: { orderIndex: "asc" } } },
    });
    candidateId = post.id;
    const legacyKey = "a".repeat(64);
    const originalResult = { historical: true, score: 0.8 };
    await db.candidateMediaAnalysis.createMany({
      data: post.media.map((media, index) => ({
        mediaId: media.id,
        modelKey: legacyKey,
        modelRevision: "legacy-model",
        decisionVersion: "legacy-head",
        sourceSha256: file.checksum,
        status: index === 0 ? "succeeded" : "queued",
        ...(index === 0 ? { score: 0.8, resultJson: originalResult } : {}),
      })),
    });
    const oldJob = await db.backgroundJob.create({
      data: {
        kind: "image_analysis",
        resourceId: post.media[1].id,
        idempotencyKey: `image-analysis:${post.media[1].id}:${legacyKey}`,
        status: "running",
        leaseId: randomUUID(),
        leaseUntil: new Date(Date.now() + 60_000),
        payload: { modelKey: legacyKey },
      },
    });
    const disabled = app.get(ImageAnalysisService);
    await disabled.schedulePending(post.id);
    assert.equal(
      (await db.backgroundJob.findUniqueOrThrow({ where: { id: oldJob.id } }))
        .status,
      "running",
    );
    assert.equal(
      (
        await db.candidateMediaAnalysis.findUniqueOrThrow({
          where: {
            mediaId_modelKey: {
              mediaId: post.media[1].id,
              modelKey: legacyKey,
            },
          },
        })
      ).status,
      "queued",
    );
    await db.backgroundJob.update({
      where: { id: oldJob.id },
      data: { leaseUntil: new Date(0) },
    });
    await disabled.schedulePending(post.id);
    assert.equal(
      (await db.backgroundJob.findUniqueOrThrow({ where: { id: oldJob.id } }))
        .status,
      "failed",
    );
    const history = await db.candidateMediaAnalysis.findUniqueOrThrow({
      where: {
        mediaId_modelKey: { mediaId: post.media[0].id, modelKey: legacyKey },
      },
    });
    assert.equal(history.status, "succeeded");
    assert.deepEqual(history.resultJson, originalResult);
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { media: { candidatePostId: post.id }, status: "queued" },
      }),
      0,
    );
    await assert.rejects(disabled.retryFailed(post.id));

    const model = activateImageAnalysisAdapter(
      createExampleImageAnalysisAdapter(),
    );
    const jobs = new JobsService(db);
    const active = new ImageAnalysisService(db, jobs, files, model);
    active.onModuleInit();
    await active.schedulePending(post.id);
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { media: { candidatePostId: post.id } },
      }),
      4,
    );
    await jobs.runNext("heavy");
    await jobs.runNext("heavy");
    const done = await db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(done.analysisScore, 0.75);
    assert.equal(done.analysisState, "succeeded");
    assert.deepEqual(done.analysisPredictions, [
      { label: "comic", confidence: 0.75, score: 0.75 },
    ]);
    assert.equal(done.status, post.status);
    assert.equal(done.revision, post.revision);
    assert.deepEqual(done.reviewedAt, post.reviewedAt);
    const newResult = await db.candidateMediaAnalysis.findUniqueOrThrow({
      where: {
        mediaId_modelKey: {
          mediaId: post.media[0].id,
          modelKey: model.modelKey,
        },
      },
    });
    assert.equal(
      (newResult.resultJson as { identity: { adapterId: string } }).identity
        .adapterId,
      "example-synthetic",
    );
    const example = createExampleImageAnalysisAdapter();
    const other = {
      ...example,
      identity: { ...example.identity, adapterId: "another-provider" },
    };
    const replacement = activateImageAnalysisAdapter(other);
    await new ImageAnalysisService(
      db,
      jobs,
      files,
      replacement,
    ).schedulePending(post.id);
    assert.notEqual(replacement.modelKey, model.modelKey);
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { media: { candidatePostId: post.id } },
      }),
      6,
    );
    assert.deepEqual(
      (
        await db.candidateMediaAnalysis.findUniqueOrThrow({
          where: { id: history.id },
        })
      ).resultJson,
      originalResult,
    );
  } finally {
    const media = await db.candidateMedia.findMany({
      where: { candidatePostId: candidateId },
    });
    await db.backgroundJob.deleteMany({
      where: {
        kind: { in: ["image_analysis"] },
        resourceId: { in: media.map((item) => item.id) },
      },
    });
    if (candidateId)
      await db.candidatePost.delete({ where: { id: candidateId } });
    await db.author.delete({ where: { id: author.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await app.close();
  }
});
