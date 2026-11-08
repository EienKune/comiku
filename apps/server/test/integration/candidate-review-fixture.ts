import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../src/database/prisma.service.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { CandidatesService } from "../../src/candidates/candidates.service.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import { activateImageAnalysisAdapter } from "../../src/image-analysis/image-analysis-adapter.js";
import { CandidateReviewSessions } from "../../src/candidates/candidate-review-sessions.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

/** No AppModule, worker bootstrap, filesystem images, model calls or global activation writes. */
export async function candidateReviewFixture() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Isolated TEST_DATABASE_URL required");
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  await db.$connect();
  const actor = await db.user.create({
    data: {
      username: `review_${randomUUID().slice(0, 18)}`,
      displayName: "Synthetic review",
      passwordHash: "disabled",
      mustChangePassword: false,
      roles: { create: { role: "source" } },
    },
  });
  const author = await db.author.create({
    data: {
      displayName: "Synthetic review author",
      authorizationStatus: "authorized",
    },
  });
  const fileIds: string[] = [];
  const model = activateImageAnalysisAdapter({
    identity: {
      adapterId: "review-fixture",
      adapterVersion: "1",
      modelId: "fixture",
      modelRevision: "1",
      decisionVersion: "1",
      preprocessVersion: "1",
      labels: ["positive", "related", "other"],
    },
    reviewPolicy: {
      positiveLabels: ["positive"],
      lowPriorityLabels: ["other"],
    },
    async analyze() {
      throw Error("No inference");
    },
  });
  const analysis = new ImageAnalysisService(
    db,
    {} as never,
    {} as never,
    model,
  );
  const service = new CandidatesService(db, {} as never, undefined, analysis);
  const filter = { authorId: author.id, limit: 24 };
  return {
    db,
    actor,
    author,
    model,
    analysis,
    service,
    filter,
    sessions: new CandidateReviewSessions(db),
    async post(
      data: Partial<Prisma.CandidatePostUncheckedCreateInput> = {},
      labels: readonly string[] = model.identity.labels,
    ) {
      const post = await db.candidatePost.create({
        data: {
          authorId: author.id,
          platform: "synthetic-review",
          externalPostId: randomUUID(),
          postedAt: new Date(),
          rawJson: {},
          analysisModelKey: model.modelKey,
          analysisSummaryVersion: 1,
          analysisState: "succeeded",
          analysisScore: 0.8,
          analysisPredictions: [
            {
              label: "positive",
              confidence: 0.8,
              score: data.analysisScore ?? 0.8,
            },
          ],
          ...data,
        },
      });
      const predictions = Array.isArray(post.analysisPredictions)
        ? post.analysisPredictions
        : [];
      for (const [index, raw] of predictions.entries()) {
        const entry = raw as {
          label?: string;
          confidence?: number;
          score?: number;
        } | null;
        const file = await db.fileObject.create({
          data: {
            objectKey: `review-${randomUUID()}`,
            bucketScope: "source",
            kind: "fixture",
            contentType: "image/jpeg",
            size: 1,
            checksum: "a".repeat(64),
          },
        });
        fileIds.push(file.id);
        const media = await db.candidateMedia.create({
          data: {
            candidatePostId: post.id,
            fileObjectId: file.id,
            externalMediaId: randomUUID(),
            orderIndex: index,
            mediaType: "photo",
          },
        });
        const confidence = entry?.confidence;
        const result =
          entry &&
          typeof confidence === "number" &&
          typeof entry.score === "number" &&
          labels.includes(entry.label ?? "")
            ? {
                score: entry.score,
                predictedClass: entry.label,
                classScores: labels.map((label) => ({
                  label,
                  value:
                    label === entry.label
                      ? confidence
                      : (1 - confidence) / (labels.length - 1),
                })),
                evidence: [],
              }
            : raw;
        await db.candidateMediaAnalysis.create({
          data: {
            mediaId: media.id,
            modelKey: post.analysisModelKey ?? "legacy",
            modelRevision: "1",
            decisionVersion: "1",
            sourceSha256: file.checksum,
            status: "succeeded",
            score: typeof entry?.score === "number" ? entry.score : null,
            resultJson: result as Prisma.InputJsonValue,
          },
        });
      }
      return post;
    },
    async create(replaceSessionId?: string, idempotencyKey = randomUUID()) {
      return service.createReviewSession(actor.id, {
        ...filter,
        idempotencyKey,
        replaceSessionId,
      });
    },
    async close() {
      await db.candidateReviewSessionEntry.deleteMany({
        where: { session: { actorId: actor.id } },
      });
      await db.candidateReviewSession.deleteMany({
        where: { actorId: actor.id },
      });
      await db.candidatePost.deleteMany({ where: { authorId: author.id } });
      await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
      await db.author.delete({ where: { id: author.id } });
      await db.userRole.deleteMany({ where: { userId: actor.id } });
      await db.user.delete({ where: { id: actor.id } });
      await db.$disconnect();
    },
  };
}
