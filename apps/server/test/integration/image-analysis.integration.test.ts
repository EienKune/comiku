import { analysisActivationFixture } from "./analysis-activation-fixture.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { createBaPixaiImageAnalysisAdapter } from "../../src/image-analysis/adapters/ba-pixai/ba-pixai-adapter.js";
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
  const activation = await analysisActivationFixture(
    db,
    app.get(ImageAnalysisService).activeModelKey,
  );
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
    const claimed = await jobs.claim("analysis");
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
    await jobs.runNext("analysis");
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
      await jobs.runNext("analysis");
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
    await jobs.runNext("analysis");
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
    await activation.restore();
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
  const activation = await analysisActivationFixture(
    db,
    app.get(ImageAnalysisService).activeModelKey,
  );
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
    await activation.activate(model.modelKey);
    await active.schedulePending(post.id);
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { media: { candidatePostId: post.id } },
      }),
      4,
    );
    await jobs.runNext("analysis");
    await jobs.runNext("analysis");
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
    await activation.activate(replacement.modelKey);
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
    await activation.restore();
    await app.close();
  }
});

test("partial BA evidence survives failures and malformed siblings, with independent retry and pending state", async () => {
  const model = activateImageAnalysisAdapter({
    ...createBaPixaiImageAnalysisAdapter({
      url: "http://127.0.0.1:19123",
      token: "synthetic-partial-token",
      modelRevision: "fixture",
      decisionVersion: "fixture",
      preprocessVersion: "original-whole-v1",
    }),
    async analyze() {
      assert.fail("Persisted successful images must not repeat inference");
    },
  });
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
  const analysis = app.get(ImageAnalysisService),
    candidates = app.get(CandidatesService);
  const activation = await analysisActivationFixture(
    db,
    app.get(ImageAnalysisService).activeModelKey,
  );
  const author = await db.author.create({
    data: { displayName: "Partial BA fixture" },
  });
  let postId = "",
    fileId = "";
  try {
    const file = await files.store({
      body: Buffer.from("partial-ba-fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "partial-ba-fixture",
    });
    fileId = file.id;
    const post = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
        revision: 7,
        status: "pending",
        analysisModelKey: model.modelKey,
        media: {
          create: [0, 1, 2, 3].map((orderIndex) => ({
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
    const result = {
      score: 0.4,
      predictedClass: "ba_art",
      classScores: [
        { label: "ba_art", value: 0.4 },
        { label: "ba_related", value: 0.35 },
        { label: "other", value: 0.25 },
      ],
      evidence: [],
    };
    await db.candidateMediaAnalysis.createMany({
      data: post.media.map((media, index) => ({
        mediaId: media.id,
        modelKey: model.modelKey,
        modelRevision: model.identity.modelRevision,
        decisionVersion: model.identity.decisionVersion,
        sourceSha256: file.checksum,
        status: index === 1 ? "failed" : index === 2 ? "queued" : "succeeded",
        ...(index === 0
          ? {
              score: result.score,
              resultJson: {
                ...result,
                identity: model.identity,
                modelKey: model.modelKey,
              } as unknown as Prisma.InputJsonValue,
            }
          : index === 3
            ? { score: 0.99, resultJson: { malformed: true } }
            : {}),
      })),
    });
    await db.backgroundJob.createMany({
      data: [1, 2].map((index) => ({
        kind: "image_analysis",
        resourceId: post.media[index].id,
        idempotencyKey: `image-analysis:${post.media[index].id}:${model.modelKey}`,
        status: index === 1 ? "failed" : "queued",
        payload: { modelKey: model.modelKey },
      })),
    });
    const successBefore = await db.candidateMediaAnalysis.findUniqueOrThrow({
      where: {
        mediaId_modelKey: {
          mediaId: post.media[0].id,
          modelKey: model.modelKey,
        },
      },
    });
    await Promise.all([
      analysis.schedulePending(post.id),
      analysis.schedulePending(post.id),
    ]);
    const summary = await db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(summary.analysisSummaryVersion, 1);
    assert.equal(summary.analysisState, "failed");
    assert.equal(summary.analysisScore, 0.4);
    assert.deepEqual(summary.analysisPredictions, [
      { label: "ba_art", confidence: 0.4, score: 0.4 },
    ]);
    assert.equal(summary.revision, 7);
    assert.equal(summary.status, "pending");
    const page = await candidates.list({
      authorId: author.id,
      limit: 24,
      triageGroup: "priority",
    });
    assert.equal(
      page.analysisPending,
      true,
      "A failed sibling cannot hide queued media",
    );
    assert.equal(page.items[0]?.id, post.id);
    assert.equal(page.items[0]?.canRetryAnalysis, true);
    assert.equal(page.items[0]?.triageGroup, "priority");
    assert.deepEqual(page.items[0]?.classificationTags, [
      { label: "ba_art", text: "BA 漫画／插画", tone: "success" },
    ]);
    await db.candidateClassificationSuggestion.create({
      data: {
        candidatePostId: post.id,
        label: "photo",
        classifierName: "legacy-fixture",
        classifierVersion: "1",
        score: 1,
      },
    });
    assert.equal(
      (
        await candidates.list({
          authorId: author.id,
          limit: 24,
          triageGroup: "priority",
        })
      ).items[0]?.id,
      post.id,
    );
    await db.candidateClassificationSuggestion.deleteMany({
      where: { candidatePostId: post.id },
    });
    await db.candidatePost.update({
      where: { id: post.id },
      data: { tagDisposition: "blocked" },
    });
    assert.equal(
      (
        await candidates.list({
          authorId: author.id,
          limit: 24,
          triageGroup: "priority",
        })
      ).items[0]?.id,
      post.id,
    );
    const disabled = new ImageAnalysisService(
      db,
      app.get(JobsService),
      files,
      null,
    );
    await activation.activate(null);
    await disabled.schedulePending(post.id);
    const retired = await db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(retired.analysisSummaryVersion, 0);
    assert.equal(retired.status, post.status);
    assert.equal(retired.revision, 7);
    assert.equal(
      (await candidates.list({ authorId: author.id, limit: 24 }))
        .analysisPending,
      true,
      "Same-key re-enable advertises the pending bounded repair",
    );
    assert.equal(
      (
        await db.candidateMediaAnalysis.findUniqueOrThrow({
          where: {
            mediaId_modelKey: {
              mediaId: post.media[2].id,
              modelKey: model.modelKey,
            },
          },
        })
      ).status,
      "failed",
    );
    // Same-key re-enable must restore the successful evidence without inference.
    await activation.activate(model.modelKey);
    await analysis.schedulePending(post.id);
    const restored = await db.candidatePost.findUniqueOrThrow({
      where: { id: post.id },
    });
    assert.equal(restored.analysisSummaryVersion, 1);
    assert.equal(restored.analysisScore, summary.analysisScore);
    assert.deepEqual(restored.analysisPredictions, summary.analysisPredictions);
    assert.equal(restored.status, post.status);
    assert.equal(restored.revision, 7);
    assert.equal(analysis.promotesReview(restored.analysisPredictions), true);
    assert.deepEqual(
      (await candidates.get(post.id)).classificationTags,
      page.items[0]?.classificationTags,
    );
    assert.equal((await candidates.get(post.id)).canRetryAnalysis, true);
    assert.equal(
      (await candidates.list({ authorId: author.id, limit: 24 }))
        .analysisPending,
      false,
    );
    assert.deepEqual(await analysis.retryFailed(post.id), { queued: 2 });
    assert.equal(
      (await candidates.list({ authorId: author.id, limit: 24 }))
        .analysisPending,
      true,
    );
    assert.equal((await candidates.get(post.id)).canRetryAnalysis, false);
    const successAfter = await db.candidateMediaAnalysis.findUniqueOrThrow({
      where: { id: successBefore.id },
    });
    assert.deepEqual(successAfter, successBefore);
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { media: { candidatePostId: post.id } },
      }),
      4,
    );
    assert.equal(
      await db.backgroundJob.count({ where: { resourceId: post.media[0].id } }),
      0,
    );
  } finally {
    if (postId) {
      const media = await db.candidateMedia.findMany({
        where: { candidatePostId: postId },
      });
      await db.backgroundJob.deleteMany({
        where: { resourceId: { in: media.map((item) => item.id) } },
      });
      await db.candidatePost.delete({ where: { id: postId } });
    }
    await db.author.delete({ where: { id: author.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await activation.restore();
    await app.close();
  }
});
