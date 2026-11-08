import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";
import {
  AnalysisScheduling,
  AnalysisConfigurationMismatch,
} from "../src/image-analysis/analysis-scheduling.js";
import { activateImageAnalysisAdapter } from "../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../src/image-analysis/example-adapter.js";
import { JobsService, JobDeferred } from "../src/jobs/jobs.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";
import type {
  Prisma,
  BackgroundJob,
  ImageAnalysisActivation,
} from "../src/generated/prisma/client.js";
type Enqueue = Parameters<JobsService["enqueue"]>[0];
const model = activateImageAnalysisAdapter(createExampleImageAnalysisAdapter());
const activation: ImageAnalysisActivation = {
  id: "global",
  activeModelKey: model.modelKey,
  generation: 1,
  activatedAt: new Date("2026-01-01"),
  historicalPaused: false,
};

test("a new image is registered in the same pass as a thousand older images", async () => {
  const media = Array.from({ length: 1001 }, (_, i) => ({
    id: `media-${i}`,
    candidatePostId: `post-${i}`,
    createdAt: new Date(i === 1000 ? "2026-01-02" : "2025-01-01"),
    fileObject: { checksum: "a".repeat(64) },
  }));
  const queued: Enqueue[] = [],
    intents = new Map<
      string,
      Prisma.ImageAnalysisWorkIntentUncheckedCreateInput
    >();
  type DiscoveryQuery = {
    take?: number;
    AND?: unknown;
    where: { AND?: { OR: { createdAt?: { gte?: Date; lt?: Date } }[] }[] };
  };
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    imageAnalysisActivation: { findUnique: async () => activation },
    imageAnalysisWorkIntent: {
      upsert: async ({
        create,
      }: {
        create: Prisma.ImageAnalysisWorkIntentUncheckedCreateInput;
      }) => {
        if (!intents.has(create.mediaId)) intents.set(create.mediaId, create);
        return intents.get(create.mediaId);
      },
    },
    backgroundJob: { findMany: async () => [], count: async () => 0 },
    candidatePost: { findMany: async () => [], update: async () => {} },
    candidateMediaAnalysis: {
      findMany: async () => [],
      createMany: async () => {},
    },
    candidateMedia: {
      findMany: async ({ where, take }: DiscoveryQuery) => {
        if (!take) return [];
        const range = where.AND?.[0]?.OR[1]?.createdAt;
        return media
          .filter(
            (m) =>
              !range ||
              (range.gte ? m.createdAt >= range.gte : m.createdAt < range.lt!),
          )
          .slice(0, take);
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const jobs = {
    lockScope: async () => {},
    enqueue: async (input: Enqueue) => queued.push(input),
  } as unknown as JobsService;
  await new ImageAnalysisService(
    db,
    jobs,
    {} as FileObjectsService,
    model,
  ).schedulePending();
  assert.ok(
    queued.some((j) => j.resourceId === "media-1000"),
    "new image starved behind history",
  );
  assert.equal(queued.filter((j) => j.queueName === "historical").length, 20);
  assert.equal(queued.filter((j) => j.queueName === "incremental").length, 1);
  assert.ok(
    queued.every((j) => j.lane === "analysis" && j.executionScope === "global"),
  );
  assert.equal(
    queued.at(-1)!.idempotencyKey,
    `image-analysis:${queued.at(-1)!.resourceId}:${model.modelKey}`,
  );
});

test("activation cannot be overwritten by stale workers and switches require drain plus generation CAS", async () => {
  let row: ImageAnalysisActivation | null = null,
    running = 0;
  const tx = {
    backgroundJob: { count: async () => running },
    imageAnalysisActivation: {
      findUnique: async () => row,
      create: async ({ data }: { data: { activeModelKey: string | null } }) =>
        (row = { ...activation, ...data }),
      update: async ({
        data,
      }: {
        data: {
          activeModelKey: string | null;
          activatedAt: Date;
          historicalPaused: boolean;
        };
      }) => (row = { ...row!, ...data, generation: row!.generation + 1 }),
    },
  };
  const db = {
    ...tx,
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const scheduling = new AnalysisScheduling(db, {
    lockScope: async () => {},
  } as unknown as JobsService);
  const a = "a".repeat(64),
    b = "b".repeat(64);
  assert.equal((await scheduling.ensure(a)).generation, 1);
  await assert.rejects(scheduling.ensure(b), AnalysisConfigurationMismatch);
  assert.equal((await scheduling.status())!.activeModelKey, a);
  await assert.rejects(scheduling.activate(b, 0), /generation/);
  running = 1;
  await assert.rejects(scheduling.activate(b, 1), /Drain/);
  running = 0;
  await scheduling.activate(b, 1);
  assert.equal((await scheduling.status())!.activeModelKey, b);
  assert.equal((await scheduling.status())!.generation, 2);
  await assert.rejects(scheduling.ensure(a), AnalysisConfigurationMismatch);
});

test("intent purpose survives restart and switching back to a previously used key", async () => {
  let intent: Prisma.ImageAnalysisWorkIntentUncheckedCreateInput | undefined;
  const tx = {
    imageAnalysisWorkIntent: {
      upsert: async ({
        create,
      }: {
        create: Prisma.ImageAnalysisWorkIntentUncheckedCreateInput;
      }) => (intent ??= create),
    },
  } as unknown as Prisma.TransactionClient;
  const scheduling = new AnalysisScheduling(
    {} as PrismaService,
    {} as JobsService,
  );
  const media = { id: "media", createdAt: new Date("2026-01-02") };
  const first = await scheduling.intent(tx, media, "key", activation);
  const again = await new AnalysisScheduling(
    {} as PrismaService,
    {} as JobsService,
  ).intent(tx, media, "key", {
    ...activation,
    generation: 3,
    activatedAt: new Date("2026-02-01"),
  });
  assert.equal(first.purpose, "incremental");
  assert.deepEqual(again, first);
  assert.equal(again.activationGeneration, 1);
});

test("legacy claims wait without acquiring an inverse scope; mismatched workers roll back and paused history defers", async () => {
  const row = { ...activation, historicalPaused: true };
  const tx = {
    imageAnalysisActivation: { findUnique: async () => row },
    backgroundJob: { count: async () => 0 },
  } as unknown as Prisma.TransactionClient;
  const scheduling = new AnalysisScheduling(
    {} as PrismaService,
    {
      lockScope: () => assert.fail("gate must not acquire a second scope"),
    } as unknown as JobsService,
  );
  const now = new Date(),
    job = {
      id: "job",
      lane: "analysis",
      executionScope: "global",
    } as BackgroundJob;
  assert.ok(
    (await scheduling.gate(
      { ...job, lane: "heavy" },
      tx,
      now,
      model.modelKey,
    )) instanceof JobDeferred,
  );
  await assert.rejects(
    scheduling.gate(job, tx, now, "stale"),
    AnalysisConfigurationMismatch,
  );
  assert.ok(
    (await scheduling.gate(
      { ...job, queueName: "historical" },
      tx,
      now,
      model.modelKey,
    )) instanceof JobDeferred,
  );
  assert.equal(
    await scheduling.gate(
      { ...job, queueName: "incremental" },
      tx,
      now,
      model.modelKey,
    ),
    undefined,
  );
});

test("bounded legacy migration terminalizes invalid and orphaned jobs so later valid work progresses", async () => {
  const rows = [
    ...[
      null,
      false,
      7,
      "primitive",
      [],
      [{ modelKey: model.modelKey }],
      {},
    ].map((payload, index) => ({
      id: `bad-${index}`,
      status: "queued",
      payload,
    })),
    { id: "orphan", status: "queued", payload: { modelKey: model.modelKey } },
    { id: "valid", status: "queued", payload: { modelKey: model.modelKey } },
  ].map((row) => ({
    ...row,
    resourceId: row.id,
    lane: "heavy",
    executionScope: "global",
    queueName: "default",
  }));
  const registered: string[] = [];
  const tx = {
    $queryRaw: async () => [],
    imageAnalysisActivation: { findUnique: async () => activation },
    backgroundJob: {
      findMany: async () =>
        rows.filter((r) => r.status === "queued" && r.lane === "heavy"),
      count: async () => 0,
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) =>
        Object.assign(
          rows.find((r) => r.id === where.id)!,
          data,
        ),
    },
    candidateMedia: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "orphan"
          ? null
          : { id: where.id, createdAt: new Date("2025-01-01") },
    },
    imageAnalysisWorkIntent: {
      upsert: async ({
        create,
      }: {
        create: Prisma.ImageAnalysisWorkIntentUncheckedCreateInput;
      }) => {
        registered.push(create.mediaId);
        return create;
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const scheduling = new AnalysisScheduling(db, {
    lockScope: async () => {},
  } as unknown as JobsService);
  await scheduling.migrateQueued(model.modelKey);
  await scheduling.migrateQueued(model.modelKey);
  assert.deepEqual(
    rows.map((r) => r.status),
    [...Array.from({ length: 8 }, () => "failed"), "queued"],
  );
  assert.deepEqual(registered, ["valid"]);
  assert.equal(rows.at(-1)!.lane, "analysis");
  assert.equal(rows.at(-1)!.queueName, "historical");
});
