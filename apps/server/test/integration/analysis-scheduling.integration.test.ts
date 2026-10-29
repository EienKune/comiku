import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { ImageAnalysisService } from "../../src/image-analysis/image-analysis.service.js";
import {
  AnalysisConfigurationMismatch,
  AnalysisScheduling,
} from "../../src/image-analysis/analysis-scheduling.js";
import { activateImageAnalysisAdapter } from "../../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../../src/image-analysis/example-adapter.js";
import { analysisActivationFixture } from "./analysis-activation-fixture.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated TEST_DATABASE_URL required");

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          30000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("persistent analysis intents recover a media commit; two workers share one slot and heavy remains independent", async () => {
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
  const model = activateImageAnalysisAdapter(
    createExampleImageAnalysisAdapter(),
  );
  const activation = await analysisActivationFixture(db, model.modelKey);
  const jobs1 = new JobsService(db),
    jobs2 = new JobsService(db);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve)),
    blocked = new Promise<void>((resolve) => (release = resolve));
  let active = 0,
    maxActive = 0,
    busy = 0,
    calls = 0;
  const order: string[] = [];
  const synthetic = {
    ...model,
    analyze: async (id: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (active > 1) busy++;
      calls++;
      order.push(id);
      try {
        if (calls === 1) {
          entered();
          await blocked;
        }
        return {
          score: 0.75,
          predictedClass: "comic",
          classScores: [
            { label: "comic", value: 0.75 },
            { label: "comic_related", value: 0.2 },
            { label: "other", value: 0.05 },
          ],
          evidence: [],
        };
      } finally {
        active--;
      }
    },
  };
  const first = new ImageAnalysisService(db, jobs1, files, synthetic),
    second = new ImageAnalysisService(db, jobs2, files, synthetic);
  first.onModuleInit();
  second.onModuleInit();
  const author = await db.author.create({
    data: { displayName: "Queue synthetic fixture" },
  });
  let fileId = "",
    postId = "",
    exportId = "";
  let running: Promise<unknown> | undefined;
  const wall = performance.now(),
    cpu = process.cpuUsage(),
    rss = process.memoryUsage().rss;
  try {
    const file = await files.store({
      body: Buffer.from("queue-fixture"),
      contentType: "image/jpeg",
      bucketScope: "source",
      kind: "analysis-queue-fixture",
    });
    fileId = file.id;
    const state = await first.scheduling.status();
    assert.ok(state);
    const post = await db.candidatePost.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    postId = post.id;
    await db.candidateMedia.createMany({
      data: Array.from({ length: 1040 }, (_, i) => ({
        candidatePostId: post.id,
        fileObjectId: file.id,
        externalMediaId: `m-${i}`,
        orderIndex: i,
        mediaType: "photo",
        createdAt: new Date(
          state.activatedAt.getTime() + (i < 1000 ? -1000 : 1000),
        ),
      })),
    });
    // Media committed with no job/intent, as after an ingestion process crash.
    await first.schedulePending(post.id);
    const intents = await db.imageAnalysisWorkIntent.findMany({
      where: { media: { candidatePostId: post.id } },
    });
    assert.equal(intents.filter((i) => i.purpose === "incremental").length, 20);
    assert.equal(intents.filter((i) => i.purpose === "historical").length, 20);
    await second.scheduling.ensure(model.modelKey);
    assert.equal(
      (await second.scheduling.status())!.activatedAt.getTime(),
      state.activatedAt.getTime(),
    );
    running = jobs1.runNext("analysis");
    await bounded(
      Promise.race([
        started,
        running.then(() => {
          throw new Error("No inference was entered");
        }),
      ]),
      "first inference entry",
    );
    assert.equal(await jobs2.runNext("analysis"), false);
    await assert.rejects(
      first.scheduling.activate(null, state.generation),
      /Drain/,
    );
    let exported = false;
    jobs2.register("analysis_test_export", async () => {
      exported = true;
    });
    const exportJob = await jobs2.enqueue({
      kind: "analysis_test_export",
      resourceId: post.id,
      idempotencyKey: `analysis-test-export:${post.id}`,
      lane: "heavy",
    });
    exportId = exportJob.id;
    const exportStart = performance.now();
    await jobs2.runNext("heavy");
    const exportMs = performance.now() - exportStart;
    assert.equal(exported, true);
    assert.equal(active, 1, "export did not wait for inference");
    release();
    await bounded(running, "first inference completion");
    running = undefined;
    for (let i = 0; i < 3; i++) await jobs2.runNext("analysis");
    const purpose = new Map(intents.map((i) => [i.mediaId, i.purpose]));
    assert.deepEqual(
      order.map((id) => purpose.get(id)),
      ["incremental", "incremental", "incremental", "historical"],
    );
    assert.equal(maxActive, 1);
    assert.equal(busy, 0);
    // Persistent purpose and idempotency survive a new service instance and retry.
    const historical = intents.find(
      (i) => i.purpose === "historical" && !order.includes(i.mediaId),
    )!;
    const key = `image-analysis:${historical.mediaId}:${model.modelKey}`;
    await db.backgroundJob.update({
      where: { idempotencyKey: key },
      data: { status: "failed", attempts: 3 },
    });
    await db.candidateMediaAnalysis.update({
      where: {
        mediaId_modelKey: {
          mediaId: historical.mediaId,
          modelKey: model.modelKey,
        },
      },
      data: { status: "failed" },
    });
    await second.retryFailed(post.id);
    const retried = await db.backgroundJob.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    assert.equal(retried.queueName, "historical");
    assert.equal(retried.attempts, 0);
    assert.deepEqual(
      await db.imageAnalysisWorkIntent.findUnique({
        where: {
          mediaId_modelKey: {
            mediaId: historical.mediaId,
            modelKey: model.modelKey,
          },
        },
      }),
      historical,
    );
    await first.schedulePending(post.id);
    await first.schedulePending(post.id);
    assert.ok(
      (await db.backgroundJob.count({
        where: {
          kind: "image_analysis",
          resourceId: {
            in: (
              await db.candidateMedia.findMany({
                where: { candidatePostId: post.id },
                select: { id: true },
              })
            ).map((m) => m.id),
          },
          queueName: "historical",
          status: "queued",
        },
      })) > 60,
    );
    await db.jobQueueState.update({
      where: { lane_scope: { lane: "analysis", scope: "global" } },
      data: { lastQueue: "incremental", consecutive: 3 },
    });
    await activation.activate(model.modelKey, true);
    assert.equal(await jobs2.runNext("analysis"), true);
    assert.equal(
      (
        await db.imageAnalysisWorkIntent.findUniqueOrThrow({
          where: {
            mediaId_modelKey: {
              mediaId: order.at(-1)!,
              modelKey: model.modelKey,
            },
          },
        })
      ).purpose,
      "incremental",
    );
    await assert.rejects(
      new AnalysisScheduling(db, jobs2).ensure("b".repeat(64)),
      AnalysisConfigurationMismatch,
    );
    assert.equal(
      (await first.scheduling.status())!.activeModelKey,
      model.modelKey,
    );
    console.info(
      JSON.stringify({
        measurement: "analysis-queue-synthetic",
        elapsedMs: performance.now() - wall,
        exportMs,
        nodeRssStart: rss,
        nodeRssEnd: process.memoryUsage().rss,
        nodeCpuMicroseconds: process.cpuUsage(cpu),
        maxInferenceConcurrency: maxActive,
        modelBusy: busy,
        modelRuntime: "synthetic-handler-no-weights",
      }),
    );
  } finally {
    release?.();
    await bounded(running ?? Promise.resolve(), "final inference drain").catch(
      () => {},
    );
    const media = await db.candidateMedia.findMany({
      where: { candidatePostId: postId },
      select: { id: true },
    });
    await db.backgroundJob.deleteMany({
      where: {
        OR: [
          {
            kind: "image_analysis",
            resourceId: { in: media.map((m) => m.id) },
          },
          { id: exportId || randomUUID() },
        ],
      },
    });
    if (postId) await db.candidatePost.delete({ where: { id: postId } });
    await db.author.delete({ where: { id: author.id } });
    if (fileId) await files.purgeUnreferenced(fileId);
    await activation.restore();
    await app.close();
  }
});
