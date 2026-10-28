import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { CandidatesService } from "../src/candidates/candidates.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";
import type { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";

function fixture(activeModelKey: string | null) {
  const rows = [
    { id: "old", analysisModelKey: "model-a", analysisScore: 0.99, day: 1 },
    { id: "current", analysisModelKey: "model-b", analysisScore: 0.2, day: 2 },
    { id: "legacy", analysisModelKey: null, analysisScore: 0.95, day: 3 },
    {
      id: "incomplete",
      analysisModelKey: "model-b",
      analysisScore: 0.98,
      day: 4,
    },
  ].map(({ day, ...row }) => ({
    ...row,
    authorId: "author",
    author: { displayName: "Fixture", externalAccounts: [] },
    authorExternalAccount: null,
    tagDisposition: "neutral",
    analysisState: row.id === "incomplete" ? "queued" : "succeeded",
    analysisSummaryVersion: 1,
    analysisPredictions: [
      { label: "comic", confidence: 0.8, score: row.analysisScore },
    ],
    classificationDecision: null,
    classificationSuggestions: [],
    sourceObservations: [],
    hashtags: [],
    media: [],
    postedAt: new Date(`2026-01-0${day}T00:00:00Z`),
    fetchedAt: new Date(0),
    work: null,
  }));
  const db = {
    candidatePost: {
      findMany: async (input: { where: { id?: { in: string[] } } }) =>
        rows.filter(
          (row) => !input.where.id || input.where.id.in.includes(row.id),
        ),
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id),
    },
  } as unknown as PrismaService;
  return new CandidatesService(db, {} as FileObjectsService, undefined, {
    activeModelKey,
    promotesReview: () => false,
    classificationTags: () => [],
    hasEvidence: () => true,
  } as unknown as ImageAnalysisService);
}

test("priority and sorting only use a valid partial summary from the active model", async () => {
  const service = fixture("model-b");
  const page = await service.list({ limit: 24 });
  assert.deepEqual(
    page.items.map((row) => row.id),
    ["incomplete", "current", "legacy", "old"],
  );
  assert.equal(page.items[0].reviewPriority, "high");
  assert.equal((await service.get("old")).reviewPriority, "unprocessed");
  assert.equal((await service.get("legacy")).reviewPriority, "unprocessed");
  assert.equal((await service.get("incomplete")).reviewPriority, "high");
});

test("disabled analysis ignores cached scores but preserves the time order", async () => {
  const page = await fixture(null).list({ limit: 24 });
  assert.deepEqual(
    page.items.map((row) => row.id),
    ["incomplete", "legacy", "current", "old"],
  );
  assert.ok(page.items.every((row) => row.reviewPriority === "unprocessed"));
});

function pendingFixture(
  state: string,
  modelKey: string | null = "active",
  enabled = true,
  eligibility = { activeMedia: 1, authorDeleted: false },
  currentMediaSucceeded = false,
) {
  const base = {
    authorId: "author",
    author: { displayName: "Fixture", externalAccounts: [] },
    authorExternalAccount: null,
    classificationDecision: null,
    classificationSuggestions: [],
    sourceObservations: [],
    hashtags: [],
    media: [],
    postedAt: new Date(0),
    fetchedAt: new Date(0),
    work: null,
  };
  const rows = [
    {
      ...base,
      id: "visible-complete",
      tagDisposition: "valid",
      analysisState: "succeeded",
      analysisModelKey: "active",
      analysisScore: 0.9,
    },
    {
      ...base,
      id: "outside-page",
      tagDisposition: "neutral",
      analysisState: state,
      analysisModelKey: modelKey,
      analysisScore: null,
    },
  ];
  const db = {
    candidatePost: {
      findMany: async (input: {
        where: { id?: { in: string[] } };
        select?: {
          _count?: { select: { media: { where: unknown } } };
        };
      }) => {
        if (input.select) {
          assert.equal(Boolean(input.select._count), enabled);
          if (input.select._count)
            assert.deepEqual(input.select._count.select.media.where, {
              fileObject: { lifecycleStatus: "active", deletedAt: null },
              candidatePost: { author: { deletedAt: null } },
              OR: [
                { analyses: { none: { modelKey: "active" } } },
                {
                  analyses: {
                    some: { modelKey: "active", status: "queued" },
                  },
                },
                {
                  analyses: { some: { modelKey: "active" } },
                  candidatePost: {
                    OR: [
                      { analysisModelKey: null },
                      { analysisModelKey: { not: "active" } },
                      { analysisSummaryVersion: { lt: 1 } },
                    ],
                  },
                },
              ],
            });
        }
        return rows
          .filter(
            (row) => !input.where.id || input.where.id.in.includes(row.id),
          )
          .map((row) => ({
            ...row,
            ...(input.select?._count
              ? {
                  _count: {
                    media:
                      row.id === "outside-page"
                        ? eligibility.authorDeleted
                          ? 0
                          : currentMediaSucceeded && modelKey === "active"
                            ? 0
                            : eligibility.activeMedia
                        : 0,
                  },
                }
              : {}),
          }));
      },
    },
  } as unknown as PrismaService;
  return new CandidatesService(db, {} as FileObjectsService, undefined, {
    activeModelKey: enabled ? "active" : null,
    promotesReview: () => false,
    classificationTags: () => [],
    hasEvidence: () => true,
  } as unknown as ImageAnalysisService);
}

test("analysis pending covers unprocessed and queued candidates outside the selected group and page", async () => {
  const cases: [string, string | null][] = [
    ["unprocessed", null],
    ["queued", "active"],
    ["failed", "active"],
    ["succeeded", "retired-model"],
  ];
  for (const [state, modelKey] of cases) {
    const service = pendingFixture(state, modelKey);
    const page = await service.list({ limit: 1 });
    assert.deepEqual(
      page.items.map((row) => row.id),
      ["visible-complete"],
    );
    assert.equal(page.analysisPending, true);
    const group = await service.list({ limit: 1, triageGroup: "valid_manga" });
    assert.deepEqual(
      group.items.map((row) => row.id),
      ["visible-complete"],
    );
    assert.equal(group.analysisPending, true);
  }
});

test("disabled analysis and current-model terminal results do not keep candidate polling alive", async () => {
  for (const service of [
    pendingFixture("queued", "active", false),
    pendingFixture("unprocessed", null, false),
    pendingFixture("failed", "active", true, {
      activeMedia: 0,
      authorDeleted: false,
    }),
    pendingFixture("succeeded", "active", true, {
      activeMedia: 0,
      authorDeleted: false,
    }),
  ]) {
    assert.equal((await service.list({ limit: 1 })).analysisPending, false);
  }
});

test("deleted authors and candidates without active media cannot keep analysis polling alive", async () => {
  for (const state of ["unprocessed", "queued"]) {
    for (const eligibility of [
      { activeMedia: 1, authorDeleted: true },
      { activeMedia: 0, authorDeleted: false },
    ]) {
      const service = pendingFixture(state, "active", true, eligibility);
      const page = await service.list({ limit: 1 });
      assert.equal(page.analysisPending, false);
      assert.equal(page.total, 2, "Eligibility must not hide candidates");
    }
  }
});

test("completed active media cannot keep a mixed candidate with only unavailable work polling", async () => {
  const service = pendingFixture(
    "queued",
    "active",
    true,
    { activeMedia: 1, authorDeleted: false },
    true,
  );
  assert.equal((await service.list({ limit: 1 })).analysisPending, false);
  const switchingBack = pendingFixture(
    "succeeded",
    "retired-model",
    true,
    { activeMedia: 1, authorDeleted: false },
    true,
  );
  assert.equal((await switchingBack.list({ limit: 1 })).analysisPending, true);
});

async function groupedFixture(enabled = true, binary = false) {
  const { ImageAnalysisService } =
    await import("../src/image-analysis/image-analysis.service.js");
  const { activateImageAnalysisAdapter } =
    await import("../src/image-analysis/image-analysis-adapter.js");
  const { createExampleImageAnalysisAdapter } =
    await import("../src/image-analysis/example-adapter.js");
  const model = activateImageAnalysisAdapter({
    ...createExampleImageAnalysisAdapter(),
    labelPresentation: binary
      ? undefined
      : createExampleImageAnalysisAdapter().labelPresentation,
    identity: {
      ...createExampleImageAnalysisAdapter().identity,
      ...(binary ? { labels: ["accept", "reject"] } : {}),
    },
    reviewPolicy: {
      positiveLabels: [binary ? "accept" : "comic"],
      minimumConfidence: 0.5,
    },
  });
  const base = {
    authorId: "author",
    author: { displayName: "Fixture", externalAccounts: [] },
    authorExternalAccount: null,
    tagDisposition: "neutral",
    analysisState: "succeeded",
    analysisSummaryVersion: 1,
    analysisModelKey: model.modelKey,
    analysisScore: 0.9,
    analysisPredictions: [
      { label: binary ? "accept" : "comic", confidence: 0.8, score: 0.9 },
    ],
    classificationDecision: null,
    classificationSuggestions: [],
    sourceObservations: [],
    hashtags: [],
    media: [],
    postedAt: new Date(0),
    fetchedAt: new Date(0),
    work: null,
  };
  const rows = binary
    ? [{ ...base, id: "binary" }]
    : [
        { ...base, id: "positive" },
        {
          ...base,
          id: "threshold",
          analysisScore: 0.1,
          analysisPredictions: [
            { label: "comic", confidence: 0.5, score: 0.1 },
          ],
        },
        {
          ...base,
          id: "uncertain",
          analysisScore: 0.99,
          analysisPredictions: [
            { label: "comic", confidence: 0.485, score: 0.99 },
          ],
        },
        {
          ...base,
          id: "related",
          analysisPredictions: [
            { label: "comic_related", confidence: 0.9, score: 0.9 },
          ],
        },
        {
          ...base,
          id: "other",
          analysisPredictions: [{ label: "other", confidence: 0.8 }],
        },
        { ...base, id: "blocked", tagDisposition: "blocked" },
        { ...base, id: "photo", classificationDecision: { label: "photo" } },
        {
          ...base,
          id: "tagged",
          tagDisposition: "valid",
          analysisPredictions: [],
        },
        {
          ...base,
          id: "legacy-photo",
          classificationSuggestions: [{ label: "photo" }],
        },
        { ...base, id: "old", analysisModelKey: "retired-model" },
        { ...base, id: "queued", analysisState: "queued" },
        {
          ...base,
          id: "malformed",
          analysisPredictions: [{ label: "comic", confidence: "0.9" }],
        },
        { ...base, id: "missing", analysisPredictions: null },
        {
          ...base,
          id: "multi",
          analysisPredictions: [
            { label: "other", confidence: 0.9, score: 0.9 },
            { label: "comic", confidence: 0.7, score: 0.9 },
          ],
        },
        {
          ...base,
          id: "human-manga",
          classificationDecision: { label: "manga" },
        },
      ];
  const db = {
    candidatePost: {
      findMany: async (input: { where: { id?: { in: string[] } } }) =>
        rows.filter(
          (row) => !input.where.id || input.where.id.in.includes(row.id),
        ),
    },
  } as unknown as PrismaService;
  const analysis = new ImageAnalysisService(
    db,
    {} as never,
    {} as FileObjectsService,
    enabled ? model : null,
  );
  return new CandidatesService(
    db,
    {} as FileObjectsService,
    undefined,
    analysis,
  );
}

test("complete confident winning classes promote neutral candidates without overriding photo or blacklist", async () => {
  const service = await groupedFixture();
  const ids = async (
    triageGroup: "valid_manga" | "neutral_manga" | "blocked_manga" | "photo",
  ) =>
    (await service.list({ limit: 100, triageGroup })).items
      .map((row) => row.id)
      .sort();
  assert.deepEqual(await ids("valid_manga"), [
    "human-manga",
    "multi",
    "positive",
    "queued",
    "tagged",
    "threshold",
  ]);
  assert.deepEqual(await ids("neutral_manga"), [
    "malformed",
    "missing",
    "old",
    "other",
    "related",
    "uncertain",
  ]);
  assert.deepEqual(await ids("blocked_manga"), ["blocked"]);
  assert.deepEqual(await ids("photo"), ["legacy-photo", "photo"]);
  const promoted = (
    await service.list({ limit: 100, triageGroup: "valid_manga" })
  ).items.find((row) => row.id === "positive")!;
  assert.equal(
    promoted.tagDisposition,
    "neutral",
    "Model routing must not fabricate a hashtag match",
  );
});

test("disabled models preserve legacy groups and binary adapters can declare their own positive label", async () => {
  const disabled = await groupedFixture(false);
  assert.deepEqual(
    (await disabled.list({ limit: 100, triageGroup: "valid_manga" })).items.map(
      (row) => row.id,
    ),
    ["tagged"],
  );
  const binary = await groupedFixture(true, true);
  assert.deepEqual(
    (await binary.list({ limit: 100, triageGroup: "valid_manga" })).items.map(
      (row) => row.id,
    ),
    ["binary"],
  );
});
