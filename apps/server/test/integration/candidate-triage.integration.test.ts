import { analysisActivationFixture } from "./analysis-activation-fixture.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import {
  IMAGE_ANALYSIS_ADAPTER,
  activateImageAnalysisAdapter,
} from "../../src/image-analysis/image-analysis-adapter.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated TEST_DATABASE_URL required");

test("current BA winning classes rebuild into five promoted and two neutral posts while preserving manual and tag decisions", async () => {
  const model = activateImageAnalysisAdapter({
    identity: {
      adapterId: "triage-fixture",
      adapterVersion: "1",
      modelId: "fixture",
      modelRevision: "1",
      decisionVersion: "1",
      preprocessVersion: "fixture",
      labels: ["ba_art", "ba_related", "other"],
    },
    reviewPolicy: { positiveLabels: ["ba_art"], minimumConfidence: 0 },
    analyze: async () => {
      throw Error("Existing results must not repeat inference");
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
    data: { displayName: "Synthetic triage author" },
  });
  const actor = await db.user.create({
    data: {
      username: `triage_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      displayName: "Synthetic reviewer",
      passwordHash: "disabled-fixture",
    },
  });
  const postIds = Array.from({ length: 7 }, () => randomUUID()),
    mediaIds = postIds.map(() => randomUUID());
  let fileId = "";
  try {
    const file = await files.store({
      body: Buffer.from("triage-fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "triage-fixture",
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
        analysisModelKey: model.modelKey,
        analysisState: "succeeded",
        analysisScore: 0.99,
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
    const predictions = [
      { label: "ba_art", confidence: 0.48 },
      { label: "other", confidence: 0.8 },
      { label: "other", confidence: 0.7 },
      ...[0.8, 0.7, 0.9, 0.6].map((confidence) => ({
        label: "ba_art",
        confidence,
      })),
    ];
    await db.candidateMediaAnalysis.createMany({
      data: mediaIds.map((mediaId, index) => {
        const { label, confidence } = predictions[index];
        const values =
          label === "other"
            ? [(1 - confidence) / 2, (1 - confidence) / 2, confidence]
            : [confidence, (1 - confidence) / 2, (1 - confidence) / 2];
        const result = {
          score: index === 0 ? 0.99 : confidence,
          predictedClass: label,
          classScores: model.identity.labels.map((label, i) => ({
            label,
            value: values[i],
          })),
          evidence: [],
          identity: model.identity,
          modelKey: model.modelKey,
        };
        return {
          mediaId,
          modelKey: model.modelKey,
          modelRevision: "1",
          decisionVersion: "1",
          sourceSha256: file.checksum,
          status: "succeeded",
          score: result.score,
          resultJson: result as unknown as Prisma.InputJsonValue,
        };
      }),
    });
    const human = await db.candidateClassificationDecision.create({
      data: {
        candidatePostId: postIds[0],
        label: "manga",
        decidedById: actor.id,
      },
    });
    await app.get(ImageAnalysisService).schedulePending();
    const candidates = app.get(CandidatesService);
    const valid = await candidates.list({
      limit: 100,
      authorId: author.id,
      triageGroup: "priority",
    });
    const neutral = await candidates.list({
      limit: 100,
      authorId: author.id,
      triageGroup: "uncertain",
    });
    assert.deepEqual(
      valid.items.map((row) => row.id).sort(),
      [postIds[0], ...postIds.slice(3)].sort(),
    );
    assert.deepEqual(
      neutral.items.map((row) => row.id).sort(),
      postIds.slice(1, 3).sort(),
    );
    assert.ok(
      [...valid.items, ...neutral.items].every(
        (row) =>
          row.tagRuleMatches.length === 0 &&
          row.status === "pending" &&
          row.revision === 0,
      ),
    );
    assert.equal(
      await db.candidateMediaAnalysis.count({
        where: { mediaId: { in: mediaIds } },
      }),
      7,
    );
    assert.equal(
      await db.backgroundJob.count({
        where: { kind: "image_analysis", resourceId: { in: mediaIds } },
      }),
      0,
    );
    assert.deepEqual(
      await db.candidateClassificationDecision.findUniqueOrThrow({
        where: { candidatePostId: postIds[0] },
      }),
      human,
    );
    await db.candidateClassificationDecision.create({
      data: {
        candidatePostId: postIds[3],
        label: "photo",
        decidedById: actor.id,
      },
    });
    await db.candidatePost.update({
      where: { id: postIds[4] },
      data: { tagDisposition: "blocked" },
    });
    assert.equal(
      (
        await candidates.list({
          limit: 100,
          authorId: author.id,
          triageGroup: "priority",
        })
      ).total,
      5,
    );
    assert.deepEqual(
      (
        await candidates.list({
          limit: 100,
          authorId: author.id,
          triageGroup: "priority",
        })
      ).items
        .map((row) => row.id)
        .sort(),
      [postIds[0], ...postIds.slice(3)].sort(),
    );
  } finally {
    await db.backgroundJob.deleteMany({
      where: { kind: "image_analysis", resourceId: { in: mediaIds } },
    });
    await db.candidatePost.deleteMany({ where: { id: { in: postIds } } });
    await db.author.delete({ where: { id: author.id } });
    await db.user.delete({ where: { id: actor.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await activation.restore();
    await app.close();
  }
});
