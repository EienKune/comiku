import { analysisActivationFixture } from "./analysis-activation-fixture.js";
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

async function pendingMediaFixture() {
  const model = activateImageAnalysisAdapter({
    ...createExampleImageAnalysisAdapter(),
    async analyze() {
      assert.fail("Pending metadata must not repeat successful inference");
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
  const activation = await analysisActivationFixture(db, model.modelKey);
  const author = await db.author.create({
    data: { displayName: "Pending media fixture" },
  });
  const fileIds: string[] = [];
  return {
    db,
    author,
    model,
    candidates: app.get(CandidatesService),
    analysis: app.get(ImageAnalysisService),
    async file(name: string) {
      const file = await files.store({
        body: Buffer.from(name),
        contentType: "image/jpeg",
        bucketScope: "source",
        kind: "analysis-pending-media-fixture",
      });
      fileIds.push(file.id);
      return file;
    },
    async close() {
      const media = await db.candidateMedia.findMany({
        where: { candidatePost: { authorId: author.id } },
        select: { id: true },
      });
      await db.backgroundJob.deleteMany({
        where: {
          kind: "image_analysis",
          resourceId: { in: media.map((m) => m.id) },
        },
      });
      await db.candidatePost.deleteMany({ where: { authorId: author.id } });
      await db.author.delete({ where: { id: author.id } });
      for (const id of fileIds) await files.purgeUnreferenced(id);
      await activation.restore();
      await app.close();
    },
  };
}

test("mixed media stops polling when only unavailable images lack current results", async () => {
  const fixture = await pendingMediaFixture();
  const { db, author, model, candidates } = fixture;
  try {
    const active = await fixture.file("active-complete");
    const unavailable = await fixture.file("unavailable-unprocessed");
    await db.fileObject.update({
      where: { id: unavailable.id },
      data: { lifecycleStatus: "pending_deletion" },
    });
    const post = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
        analysisModelKey: model.modelKey,
        analysisSummaryVersion: 1,
        analysisState: "queued",
        media: {
          create: [active, unavailable].map((file, orderIndex) => ({
            fileObjectId: file.id,
            externalMediaId: String(orderIndex),
            orderIndex,
            mediaType: "photo",
          })),
        },
      },
      include: { media: { orderBy: { orderIndex: "asc" } } },
    });
    await db.candidateMediaAnalysis.create({
      data: {
        mediaId: post.media[0]!.id,
        modelKey: model.modelKey,
        modelRevision: model.identity.modelRevision,
        decisionVersion: model.identity.decisionVersion,
        sourceSha256: active.checksum,
        status: "succeeded",
        score: 0.75,
        resultJson: (await createExampleImageAnalysisAdapter().analyze(
          "fixture",
          Buffer.from("fixture"),
          new AbortController().signal,
        )) as unknown as Prisma.InputJsonValue,
      },
    });
    const query = { authorId: author.id, limit: 1 };
    assert.equal((await candidates.list(query)).analysisPending, false);
    await db.fileObject.update({
      where: { id: unavailable.id },
      data: { lifecycleStatus: "active" },
    });
    assert.equal((await candidates.list(query)).analysisPending, true);
    await db.fileObject.update({
      where: { id: unavailable.id },
      data: { lifecycleStatus: "pending_deletion" },
    });
    await db.candidateMediaAnalysis.update({
      where: {
        mediaId_modelKey: {
          mediaId: post.media[0]!.id,
          modelKey: model.modelKey,
        },
      },
      data: { status: "queued" },
    });
    assert.equal((await candidates.list(query)).analysisPending, true);
  } finally {
    await fixture.close();
  }
});

test("cached current-model successes keep polling until an older summary is rebuilt", async () => {
  const fixture = await pendingMediaFixture();
  const { db, author, model, candidates, analysis } = fixture;
  try {
    const file = await fixture.file("cached-success");
    const post = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
        analysisModelKey: "a".repeat(64),
        analysisState: "succeeded",
        analysisScore: 0.2,
        media: {
          create: {
            fileObjectId: file.id,
            externalMediaId: "image",
            orderIndex: 0,
            mediaType: "photo",
          },
        },
      },
      include: { media: true },
    });
    const result = await createExampleImageAnalysisAdapter().analyze(
      "fixture",
      Buffer.from("fixture"),
      new AbortController().signal,
    );
    await db.candidateMediaAnalysis.create({
      data: {
        mediaId: post.media[0]!.id,
        modelKey: model.modelKey,
        modelRevision: model.identity.modelRevision,
        decisionVersion: model.identity.decisionVersion,
        sourceSha256: file.checksum,
        status: "succeeded",
        score: result.score,
        resultJson: {
          ...result,
          identity: model.identity,
          modelKey: model.modelKey,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const query = { authorId: author.id, limit: 1 };
    assert.equal((await candidates.list(query)).analysisPending, true);
    await analysis.schedulePending(post.id);
    const page = await candidates.list(query);
    assert.equal(page.analysisPending, false);
    assert.equal(page.items[0]?.triageGroup, "priority");
    assert.equal(
      await db.backgroundJob.count({
        where: { kind: "image_analysis", resourceId: post.media[0]!.id },
      }),
      0,
    );
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { mediaId: post.media[0]!.id },
      }),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("pending scope spans groups and pages but excludes analysis that cannot progress", async () => {
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
    files = app.get(FileObjectsService),
    candidates = app.get(CandidatesService);
  const activation = await analysisActivationFixture(db, model.modelKey);
  const author = await db.author.create({
    data: { displayName: "Analysis pending fixture" },
  });
  let fileId = "";
  const postIds: string[] = [];
  try {
    const file = await files.store({
      body: Buffer.from("pending-fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "analysis-pending-fixture",
    });
    fileId = file.id;
    for (const completed of [true, false]) {
      const post = await db.candidatePost.create({
        data: {
          authorId: author.id,
          platform: "fixture",
          externalPostId: randomUUID(),
          postedAt: new Date(),
          rawJson: {},
          tagDisposition: completed ? "valid" : "neutral",
          analysisModelKey: completed ? model.modelKey : null,
          analysisState: completed ? "succeeded" : "unprocessed",
          analysisScore: completed ? 0.9 : null,
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
      postIds.push(post.id);
      if (completed) {
        const media = await db.candidateMedia.findFirstOrThrow({
          where: { candidatePostId: post.id },
        });
        await db.candidateMediaAnalysis.create({
          data: {
            mediaId: media.id,
            modelKey: model.modelKey,
            modelRevision: model.identity.modelRevision,
            decisionVersion: model.identity.decisionVersion,
            sourceSha256: file.checksum,
            status: "succeeded",
            score: 0.9,
            resultJson: {
              score: 0.9,
              predictedClass: "comic",
              classScores: [
                { label: "comic", value: 0.9 },
                { label: "comic_related", value: 0.05 },
                { label: "other", value: 0.05 },
              ],
              evidence: [],
            },
          },
        });
        await db.candidatePost.update({
          where: { id: post.id },
          data: { analysisSummaryVersion: 1 },
        });
      }
    }
    const query = { authorId: author.id, limit: 1 };
    const page = await candidates.list(query);
    assert.equal(page.analysisPending, true);
    assert.equal(page.items[0]?.id, postIds[0]);
    assert.ok(page.nextCursor);
    const group = await candidates.list({
      ...query,
      triageGroup: "priority",
    });
    assert.equal(group.total, 1);
    assert.equal(group.analysisPending, true);
    const pendingId = postIds[1]!;
    await db.candidatePost.update({
      where: { id: pendingId },
      data: { analysisModelKey: model.modelKey, analysisState: "queued" },
    });
    assert.equal((await candidates.list(query)).analysisPending, true);
    await db.candidatePost.update({
      where: { id: pendingId },
      data: { analysisState: "failed", analysisSummaryVersion: 1 },
    });
    const failedMedia = await db.candidateMedia.findFirstOrThrow({
      where: { candidatePostId: pendingId },
    });
    await db.candidateMediaAnalysis.create({
      data: {
        mediaId: failedMedia.id,
        modelKey: model.modelKey,
        modelRevision: model.identity.modelRevision,
        decisionVersion: model.identity.decisionVersion,
        sourceSha256: file.checksum,
        status: "failed",
      },
    });
    assert.equal((await candidates.list(query)).analysisPending, false);
    await db.candidatePost.update({
      where: { id: pendingId },
      data: { analysisState: "unprocessed", analysisModelKey: null },
    });
    const disabled = new CandidatesService(
      db,
      files,
      undefined,
      new ImageAnalysisService(db, app.get(JobsService), files, null),
    );
    assert.equal((await disabled.list(query)).analysisPending, false);
    await db.author.update({
      where: { id: author.id },
      data: { deletedAt: new Date() },
    });
    const deletedAuthor = await candidates.list(query);
    assert.equal(deletedAuthor.analysisPending, false);
    assert.equal(
      deletedAuthor.total,
      0,
      "Archived authors are removed from live eligibility",
    );
    await db.author.update({
      where: { id: author.id },
      data: { deletedAt: null },
    });
    await db.fileObject.update({
      where: { id: file.id },
      data: { lifecycleStatus: "pending_deletion" },
    });
    assert.equal((await candidates.list(query)).analysisPending, false);
    await db.fileObject.update({
      where: { id: file.id },
      data: { lifecycleStatus: "active", deletedAt: new Date() },
    });
    assert.equal((await candidates.list(query)).analysisPending, false);
    await db.fileObject.update({
      where: { id: file.id },
      data: { deletedAt: null },
    });
    await db.candidateMedia.deleteMany({
      where: { candidatePostId: pendingId },
    });
    assert.equal((await candidates.list(query)).analysisPending, false);
  } finally {
    await db.candidatePost.deleteMany({ where: { id: { in: postIds } } });
    await db.author.delete({ where: { id: author.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await activation.restore();
    await app.close();
  }
});

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
  const activation = await analysisActivationFixture(db, model.modelKey);
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
    assert.ok(before.items.every((post) => post.triageGroup === "uncertain"));
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
    assert.ok(after.items.every((post) => post.triageGroup === "uncertain"));
    assert.equal(after.analysisPending, false);
    assert.equal(
      await db.candidatePost.count({
        where: { authorId: author.id, analysisSummaryVersion: 1 },
      }),
      21,
    );
    const timestamps = await db.candidatePost.findMany({
      where: { authorId: author.id },
      select: { id: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    await analysis.schedulePending();
    assert.deepEqual(
      await db.candidatePost.findMany({
        where: { authorId: author.id },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
      timestamps,
    );
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
    await activation.restore();
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
  const activation = await analysisActivationFixture(db, model.modelKey);
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
        analysisPredictions: [
          { label: "comic", confidence: 0.485 },
          { label: "other", confidence: 0.8 },
        ],
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
      { label: "comic", confidence: 0.485, score: 0.99 },
      { label: "other", confidence: 0.8, score: 0.1 },
    ]);
    assert.deepEqual(service.classificationTags(rebuilt.analysisPredictions), [
      { label: "comic", text: "漫画／插画", tone: "success" },
    ]);
    assert.equal(service.promotesReview(rebuilt.analysisPredictions), true);
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
    await activation.restore();
    await app.close();
  }
});
