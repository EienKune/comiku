import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";
import type { JobHandler, JobsService } from "../src/jobs/jobs.service.js";
import { type BackgroundJob } from "../src/generated/prisma/client.js";
import { activateImageAnalysisAdapter } from "../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../src/image-analysis/example-adapter.js";

// These fixtures isolate evidence/retirement behavior. Activation/queue behavior is
// exercised independently in analysis-scheduling and PostgreSQL integration tests.
class EvidenceService extends ImageAnalysisService {
  constructor(
    db: PrismaService,
    jobs: JobsService,
    files: FileObjectsService,
    model: ConstructorParameters<typeof ImageAnalysisService>[3],
  ) {
    super(
      db,
      Object.assign(
        {
          lockScope: async () => {},
          registerQueuePolicy: () => {},
          registerQueueAvailability: () => {},
          registerClaimGate: () => {},
        },
        jobs,
      ),
      files,
      model,
    );
  }
  override get scheduling(): ImageAnalysisService["scheduling"] {
    return {
      ensure: async () => ({}),
      assert: async () => ({}),
      migrateQueued: async () => {},
      discover: async () => {},
    } as unknown as ImageAnalysisService["scheduling"];
  }
}

test("existing current-model results rebuild bounded summaries without new inference", async () => {
  const model = activateImageAnalysisAdapter(
    createExampleImageAnalysisAdapter(),
  );
  const updates = new Map<string, Record<string, unknown>>();
  let recoveryQuery: { take?: number; where?: { OR?: unknown[] } } | undefined;
  const result = (score: number, comic: number, related: number) => ({
    score,
    predictedClass:
      comic >= related && comic >= 1 - comic - related
        ? "comic"
        : related >= 1 - comic - related
          ? "comic_related"
          : "other",
    classScores: [
      { label: "comic", value: comic },
      { label: "comic_related", value: related },
      { label: "other", value: 1 - comic - related },
    ],
    evidence: [],
  });
  const tx = {
    $queryRaw: async () => [],
    candidateMedia: {
      findMany: async ({ where }: { where: { candidatePostId?: string } }) => {
        const results =
          where.candidatePostId === "legacy"
            ? [result(0.2, 0.6, 0.3), result(0.3, 0.7, 0.2)]
            : where.candidatePostId === "all-malformed"
              ? [{ score: 0.8, fixture: true }]
              : where.candidatePostId === "malformed"
                ? [result(0.9, 0.7, 0.2), { score: 0.8, fixture: true }]
                : where.candidatePostId === "nonwinner"
                  ? [result(0.99, 0.45, 0.55)]
                  : [result(0.9, 0.7, 0.2), null];
        return results.map((resultJson) => ({
          analyses:
            resultJson === null
              ? where.candidatePostId === "failed" ||
                where.candidatePostId === "pending"
                ? [
                    {
                      status:
                        where.candidatePostId === "failed"
                          ? "failed"
                          : "queued",
                      score: null,
                      resultJson: null,
                    },
                  ]
                : []
              : [{ status: "succeeded", score: resultJson.score, resultJson }],
        }));
      },
    },
    candidatePost: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => updates.set(where.id, data),
    },
  };
  const db = {
    $transaction: async (callback: (value: typeof tx) => Promise<void>) =>
      callback(tx),
    candidatePost: {
      findMany: async (query: { take?: number }) => {
        recoveryQuery = query;
        return [
          "legacy",
          "partial",
          "malformed",
          "all-malformed",
          "nonwinner",
          "failed",
          "pending",
        ].map((id) => ({
          id,
        }));
      },
    },
    candidateMediaAnalysis: { findMany: async () => [] },
    backgroundJob: { findMany: async () => [] },
    candidateMedia: { findMany: async () => [] },
  } as unknown as PrismaService;
  const service = new EvidenceService(
    db,
    {} as JobsService,
    {} as FileObjectsService,
    model,
  );
  await service.schedulePending();
  assert.equal(recoveryQuery?.take, 20);
  assert.ok(
    recoveryQuery?.where?.OR?.some(
      (condition) =>
        (condition as { analysisSummaryVersion?: { lt?: number } })
          .analysisSummaryVersion?.lt === 1,
    ),
  );
  for (const [id, state] of [
    ["partial", "queued"],
    ["failed", "failed"],
    ["pending", "queued"],
  ]) {
    assert.equal(updates.get(id)?.analysisScore, 0.9);
    assert.equal(updates.get(id)?.analysisState, state);
    assert.deepEqual(updates.get(id)?.analysisPredictions, [
      { label: "comic", confidence: 0.7, score: 0.9 },
    ]);
  }
  assert.equal(updates.get("partial")?.analysisScore, 0.9);
  assert.equal(updates.get("malformed")?.analysisScore, 0.9);
  assert.deepEqual(updates.get("legacy"), {
    analysisModelKey: model.modelKey,
    analysisSummaryVersion: 1,
    analysisState: "succeeded",
    analysisScore: 0.3,
    analysisPredictions: [{ label: "comic", confidence: 0.7, score: 0.3 }],
  });
  assert.deepEqual(updates.get("partial"), {
    analysisModelKey: model.modelKey,
    analysisSummaryVersion: 1,
    analysisState: "queued",
    analysisScore: 0.9,
    analysisPredictions: [{ label: "comic", confidence: 0.7, score: 0.9 }],
  });
  assert.deepEqual(updates.get("malformed")?.analysisPredictions, [
    { label: "comic", confidence: 0.7, score: 0.9 },
  ]);
  assert.equal(updates.get("malformed")?.analysisSummaryVersion, 1);
  assert.equal(updates.get("all-malformed")?.analysisState, "failed");
  assert.equal(updates.get("all-malformed")?.analysisScore, null);
  assert.deepEqual(updates.get("nonwinner")?.analysisPredictions, [
    { label: "comic_related", confidence: 0.55, score: 0.99 },
  ]);
});

test("review promotion uses declared winning labels without an extra confidence threshold, rejecting malformed caches", () => {
  const example = createExampleImageAnalysisAdapter();
  const service = (
    model: ReturnType<typeof activateImageAnalysisAdapter> | null,
  ) =>
    new EvidenceService(
      {} as PrismaService,
      {} as JobsService,
      {} as FileObjectsService,
      model,
    );
  const current = service(activateImageAnalysisAdapter(example));
  for (const [predictions, expected] of [
    [[{ label: "comic", confidence: 0.5 }], true],
    [[{ label: "comic", confidence: 0.485 }], true],
    [[{ label: "comic_related", confidence: 0.99 }], false],
    [[{ label: "other", confidence: 0.99 }], false],
    [
      [
        { label: "other", confidence: 0.9 },
        { label: "comic", confidence: 0.6 },
      ],
      true,
    ],
    [[], false],
    [null, false],
    [{ label: "comic", confidence: 0.9 }, false],
    [
      [
        { label: "comic", confidence: 0.9 },
        { label: "unknown", confidence: 0.1 },
      ],
      false,
    ],
    [
      [
        { label: "comic", confidence: 0.9 },
        { label: "comic", confidence: 0.8 },
      ],
      false,
    ],
    [[{ label: "comic", confidence: Number.NaN }], false],
    [[{ label: "comic", confidence: 1.1 }], false],
    [[{ label: "comic", confidence: -0.1 }], false],
    [[{ label: "comic", confidence: "0.9" }], false],
    [[{ label: "comic", confidence: 0.9 }, null], false],
    [
      Object.assign(new Array(2), { 0: { label: "comic", confidence: 0.9 } }),
      false,
    ],
  ] as const)
    assert.equal(current.promotesReview(predictions), expected);
  assert.equal(
    service(null).promotesReview([{ label: "comic", confidence: 1 }]),
    false,
  );
  assert.equal(
    service(
      activateImageAnalysisAdapter({ ...example, reviewPolicy: undefined }),
    ).promotesReview([{ label: "comic", confidence: 1 }]),
    false,
  );
  const binary = service(
    activateImageAnalysisAdapter({
      ...example,
      identity: { ...example.identity, labels: ["accept", "reject"] },
      labelPresentation: undefined,
      reviewPolicy: { positiveLabels: ["accept"], minimumConfidence: 0.8 },
    }),
  );
  assert.equal(
    binary.promotesReview([{ label: "accept", confidence: 0.8 }]),
    true,
  );
  assert.equal(
    binary.promotesReview([{ label: "reject", confidence: 1 }]),
    false,
  );
});

test("disabled analysis still settles queued jobs without invoking inference", async () => {
  const handlers = new Map<string, JobHandler>();
  const jobUpdates: unknown[] = [],
    analysisUpdates: unknown[] = [];
  const tx = {
    candidateMedia: { findUnique: async () => null },
    backgroundJob: {
      updateMany: async (input: unknown) => {
        jobUpdates.push(input);
        return { count: 1 };
      },
    },
    candidateMediaAnalysis: {
      updateMany: async (input: unknown) => {
        analysisUpdates.push(input);
        return { count: 1 };
      },
    },
  };
  const db = {
    $transaction: async (callback: (value: typeof tx) => Promise<void>) =>
      callback(tx),
  } as unknown as PrismaService;
  const jobs = {
    register: (kind: string, handler: JobHandler) =>
      handlers.set(kind, handler),
    assertCurrentLease: async () => {},
  } as unknown as JobsService;
  const files = {
    read: async () => {
      assert.fail("Disabled adapters must not read image bytes");
    },
  } as unknown as FileObjectsService;
  new EvidenceService(db, jobs, files, null).onModuleInit();
  assert.ok(handlers.has("image_analysis"));
  const payloads = [{ modelKey: "old-key" }, null, false, ["invalid"]];
  for (const payload of payloads) {
    await handlers.get("image_analysis")!(
      {
        id: "image_analysis",
        resourceId: "missing-media",
        idempotencyKey: "image-analysis:missing-media:old-key",
        payload,
        status: "running",
        leaseId: "lease",
      } as unknown as BackgroundJob,
      new AbortController().signal,
    );
  }
  assert.equal(jobUpdates.length, payloads.length);
  assert.equal(analysisUpdates.length, payloads.length);
  for (const update of jobUpdates)
    assert.equal(
      (update as { data: { status: string } }).data.status,
      "failed",
    );
  for (const update of analysisUpdates)
    assert.equal(
      (update as { data: { status: string } }).data.status,
      "failed",
    );
});

test("retirement rechecks a concurrently claimed lease before failing media", async () => {
  let newlyClaimed = false,
    analysisWrites = 0;
  const tx = {
    $queryRaw: async () => [],
    backgroundJob: {
      count: async () => (newlyClaimed ? 1 : 0),
      updateMany: async () => {
        newlyClaimed = true;
        return { count: 0 };
      },
    },
    candidateMediaAnalysis: {
      updateMany: async () => {
        analysisWrites++;
        return { count: 0 };
      },
    },
  };
  const db = {
    $transaction: async (callback: (value: typeof tx) => Promise<void>) =>
      callback(tx),
    candidateMediaAnalysis: {
      findMany: async () => [
        {
          id: "analysis",
          mediaId: "media",
          modelKey: "old-key",
          media: { candidatePostId: "post" },
        },
      ],
    },
    backgroundJob: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaService;
  const service = new EvidenceService(
    db,
    {} as JobsService,
    {} as FileObjectsService,
    null,
  );
  await service.schedulePending();
  assert.equal(analysisWrites, 0);
});

test("disabling partial analysis leaves same-key re-enable repairable without repeating successful inference", async () => {
  const model = activateImageAnalysisAdapter({
    ...createExampleImageAnalysisAdapter(),
    async analyze() {
      assert.fail("Re-enable must reuse persisted successes");
    },
  });
  const result = {
    score: 0.75,
    predictedClass: "comic",
    classScores: [
      { label: "comic", value: 0.75 },
      { label: "comic_related", value: 0.2 },
      { label: "other", value: 0.05 },
    ],
    evidence: [],
    identity: model.identity,
    modelKey: model.modelKey,
  };
  const successful = {
    id: "success",
    mediaId: "success-media",
    modelKey: model.modelKey,
    status: "succeeded",
    score: 0.75,
    resultJson: result,
  };
  const queued = {
    id: "queued",
    mediaId: "queued-media",
    modelKey: model.modelKey,
    status: "queued",
    score: null,
    resultJson: null,
    media: { candidatePostId: "post" },
  };
  const before = structuredClone(successful);
  const summary = {
    analysisModelKey: model.modelKey,
    analysisSummaryVersion: 1,
    analysisState: "queued",
    analysisScore: 0.75 as number | null,
    analysisPredictions: [{ label: "comic", confidence: 0.75, score: 0.75 }],
    status: "discarded",
    revision: 9,
  };
  let writes = 0;
  const tx = {
    $queryRaw: async () => [],
    backgroundJob: {
      count: async () => 0,
      updateMany: async () => ({ count: 1 }),
    },
    candidateMediaAnalysis: {
      updateMany: async () => {
        queued.status = "failed";
        return { count: 1 };
      },
    },
    candidateMedia: {
      findMany: async () => [
        { analyses: [successful] },
        { analyses: [queued] },
      ],
    },
    candidatePost: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes++;
        Object.assign(summary, data);
      },
    },
  };
  const db = {
    $transaction: async (callback: (value: typeof tx) => Promise<void>) =>
      callback(tx),
    candidateMediaAnalysis: {
      findMany: async ({ where }: { where: { modelKey?: unknown } }) =>
        queued.status === "queued" &&
        (!where.modelKey || typeof where.modelKey !== "object")
          ? [queued]
          : [],
    },
    backgroundJob: { findMany: async () => [] },
    candidateMedia: { findMany: async () => [] },
    candidatePost: {
      findMany: async () =>
        summary.analysisSummaryVersion < 1 ||
        summary.analysisModelKey !== model.modelKey
          ? [{ id: "post" }]
          : [],
    },
  } as unknown as PrismaService;
  const disabled = new EvidenceService(
    db,
    {} as JobsService,
    {} as FileObjectsService,
    null,
  );
  await disabled.schedulePending("post");
  assert.equal(queued.status, "failed");
  assert.equal(
    summary.analysisSummaryVersion,
    0,
    "Unavailable taxonomy must not certify a completed repair",
  );
  const enabled = new EvidenceService(
    db,
    {} as JobsService,
    {} as FileObjectsService,
    model,
  );
  await enabled.schedulePending("post");
  assert.equal(summary.analysisSummaryVersion, 1);
  assert.equal(summary.analysisState, "failed");
  assert.equal(summary.analysisScore, 0.75);
  assert.deepEqual(summary.analysisPredictions, [
    { label: "comic", confidence: 0.75, score: 0.75 },
  ]);
  assert.equal(
    enabled.hasEvidence(summary.analysisScore, summary.analysisPredictions),
    true,
  );
  assert.equal(enabled.promotesReview(summary.analysisPredictions), true);
  assert.equal(summary.status, "discarded");
  assert.equal(summary.revision, 9);
  assert.deepEqual(successful, before);
  const afterRepair = writes;
  await enabled.schedulePending("post");
  assert.equal(
    writes,
    afterRepair,
    "Repaired terminal summaries must not loop",
  );
});
