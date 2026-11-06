import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import {
  IMAGE_ANALYSIS_ADAPTER,
  activateImageAnalysisAdapter,
} from "../../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../../src/image-analysis/example-adapter.js";
import { analysisActivationFixture } from "./analysis-activation-fixture.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL required");

test("paused historical analyses cannot starve terminal incremental recovery", async () => {
  let calls = 0;
  const model = activateImageAnalysisAdapter({
    ...createExampleImageAnalysisAdapter(),
    async analyze() {
      calls++;
      throw new Error("Maintenance must not invoke inference");
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
  const db = app.get(PrismaService);
  const files = app.get(FileObjectsService);
  const service = app.get(ImageAnalysisService);
  const activation = await analysisActivationFixture(db, model.modelKey);
  const current = await activation.activate(model.modelKey, true);
  const author = await db.author.create({
    data: { displayName: "Recovery fixture" },
  });
  const postIds: string[] = [];
  const mediaIds: string[] = [];
  let fileId = "";
  try {
    const file = await files.store({
      body: Buffer.from("recovery fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "analysis-recovery-fixture",
    });
    fileId = file.id;
    for (const purpose of ["historical", "incremental"] as const) {
      const post = await db.candidatePost.create({
        data: {
          authorId: author.id,
          platform: "fixture",
          externalPostId: randomUUID(),
          postedAt: new Date(),
          rawJson: {},
          media: {
            create: Array.from(
              { length: purpose === "historical" ? 100 : 1 },
              (_, index) => ({
                fileObjectId: file.id,
                externalMediaId: String(index),
                orderIndex: index,
                mediaType: "photo",
                createdAt: purpose === "historical" ? new Date(0) : new Date(),
              }),
            ),
          },
        },
        include: { media: true },
      });
      postIds.push(post.id);
      mediaIds.push(...post.media.map((media) => media.id));
      for (const media of post.media) {
        await db.candidateMediaAnalysis.create({
          data: {
            mediaId: media.id,
            modelKey: model.modelKey,
            modelRevision: model.identity.modelRevision,
            decisionVersion: model.identity.decisionVersion,
            sourceSha256: file.checksum,
            createdAt: media.createdAt,
          },
        });
        await db.imageAnalysisWorkIntent.create({
          data: {
            mediaId: media.id,
            modelKey: model.modelKey,
            purpose,
            activationGeneration: current.generation,
          },
        });
        await db.backgroundJob.create({
          data: {
            kind: "image_analysis",
            resourceId: media.id,
            idempotencyKey: `image-analysis:${media.id}:${model.modelKey}`,
            lane: "analysis",
            executionScope: "global",
            queueName: purpose,
            status: purpose === "historical" ? "queued" : "failed",
            attempts: purpose === "historical" ? 0 : 3,
            payload: { modelKey: model.modelKey },
          },
        });
      }
    }
    // A scoped maintenance pass must not settle a different candidate.
    await service.schedulePending(postIds[0]);
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { status: "failed", mediaId: { in: mediaIds } },
      }),
      0,
    );
    await service.schedulePending();
    const recovered = await db.candidateMediaAnalysis.findUniqueOrThrow({
      where: {
        mediaId_modelKey: { mediaId: mediaIds[100], modelKey: model.modelKey },
      },
    });
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.lastError, "worker_attempts_exhausted");
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { status: "queued", mediaId: { in: mediaIds } },
      }),
      100,
    );
    assert.equal(calls, 0);
    assert.deepEqual(await service.retryFailed(postIds[1]), { queued: 1 });
    assert.equal((await service.scheduling.status())?.historicalPaused, true);
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
