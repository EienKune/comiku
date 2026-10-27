import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  activateImageAnalysisAdapter,
  type ImageAnalysisLabelPresentation,
} from "../src/image-analysis/image-analysis-adapter.js";
import { createBaPixaiImageAnalysisAdapter } from "../src/image-analysis/adapters/ba-pixai/ba-pixai-adapter.js";
import { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";
import { CandidatesService } from "../src/candidates/candidates.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";

function adapter() {
  return createBaPixaiImageAnalysisAdapter({
    url: "http://127.0.0.1:19123",
    token: "synthetic-classification-token",
    modelRevision: "fixture",
    decisionVersion: "fixture",
    preprocessVersion: "original-whole-v1",
  });
}
function analysis(model = activateImageAnalysisAdapter(adapter())) {
  return new ImageAnalysisService(
    {} as PrismaService,
    {} as JobsService,
    {} as FileObjectsService,
    model,
  );
}
const expected = [
  { label: "ba_art", text: "BA 漫画／插画", tone: "success" },
  { label: "ba_related", text: "BA 相关", tone: "info" },
  { label: "other", text: "非 BA 内容", tone: "neutral" },
] satisfies ImageAnalysisLabelPresentation[];

test("classification presentation is immutable and does not change inference identity", () => {
  const base = adapter();
  const presentation = expected.map((entry) => ({ ...entry }));
  const active = activateImageAnalysisAdapter({
    ...base,
    labelPresentation: presentation,
  });
  presentation[0].text = "mutated";
  assert.deepEqual(active.labelPresentation, expected);
  assert.ok(Object.isFrozen(active.labelPresentation));
  assert.ok(Object.isFrozen(active.labelPresentation![0]));
  assert.equal(active.modelKey, activateImageAnalysisAdapter(base).modelKey);
  assert.equal(
    activateImageAnalysisAdapter({ ...base, labelPresentation: [] }).modelKey,
    active.modelKey,
  );
});

test("invalid label presentation fails activation without accepting foreign classes or colors", () => {
  for (const invalid of [
    null,
    {},
    [expected[0], expected[0]],
    [{ ...expected[0], label: "foreign" }],
    [{ ...expected[0], text: " " }],
    [{ ...expected[0], tone: "arbitrary-css" }],
    new Array(1),
  ]) {
    assert.throws(() =>
      activateImageAnalysisAdapter({
        ...adapter(),
        labelPresentation: invalid,
      } as unknown as Parameters<typeof activateImageAnalysisAdapter>[0]),
    );
  }
});

test("the post displays one highest-ranking image category, independently of winning confidence", () => {
  const service = analysis();
  const predictions = [
    { label: "other", confidence: 0.9, score: 0.1 },
    { label: "ba_art", confidence: 0.485, score: 0.8 },
    { label: "ba_related", confidence: 0.7, score: 0.2 },
  ];
  assert.deepEqual(service.classificationTags(predictions), [expected[0]]);
  assert.equal(service.promotesReview([predictions[1]]), true);
  assert.deepEqual(service.classificationTags([predictions[1]]), [expected[0]]);
  assert.deepEqual(
    service.classificationTags(
      predictions.map((entry) => ({ ...entry, score: 0.5 })),
    ),
    [expected[0]],
  );
  assert.deepEqual(
    service.classificationTags([
      { label: "other", confidence: 0.9 },
      { label: "ba_art", confidence: 0.4 },
    ]),
    [],
  );
  assert.deepEqual(adapter().labelPresentation, expected);
  const mixed = [
    { label: "ba_art", confidence: 0.38, score: 0.38 },
    { label: "other", confidence: 0.55, score: 0.4 },
  ];
  assert.deepEqual(service.classificationTags(mixed), [expected[2]]);
  assert.equal(
    service.promotesReview(mixed),
    true,
    "Any BA-winning image promotes the post, independently of the representative image",
  );
});

test("generic binary adapters fall back to their own class text and neutral tone", () => {
  const binary = activateImageAnalysisAdapter({
    identity: { ...adapter().identity, labels: ["accept", "reject"] },
    async analyze() {
      throw Error("Not used by presentation");
    },
  });
  assert.deepEqual(
    analysis(binary).classificationTags([
      { label: "reject", confidence: 0.8, score: 0.2 },
    ]),
    [{ label: "reject", text: "reject", tone: "neutral" }],
  );
});

test("malformed prediction caches never create classification tags", () => {
  const service = analysis();
  for (const invalid of [
    null,
    {},
    [null],
    [{ label: "foreign", confidence: 0.9 }],
    [{ label: "ba_art", confidence: Number.NaN }],
    [{ label: "ba_art", confidence: 1.1 }],
    [
      { label: "ba_art", confidence: 0.9 },
      { label: "ba_art", confidence: 0.8 },
    ],
    new Array(1),
  ]) {
    assert.deepEqual(service.classificationTags(invalid), []);
  }
});

test("candidate tags require current complete results and do not depend on review group or manual classification", async () => {
  const model = activateImageAnalysisAdapter(adapter());
  const row = {
    id: "synthetic-candidate",
    authorId: "author",
    author: { displayName: "Synthetic", externalAccounts: [] },
    authorExternalAccount: null,
    analysisModelKey: model.modelKey,
    analysisState: "succeeded",
    analysisScore: 0.8,
    analysisPredictions: [{ label: "ba_related", confidence: 0.8, score: 0.2 }],
    classificationDecision: { label: "photo", revision: 2 },
    classificationSuggestions: [],
    sourceObservations: [],
    hashtags: [],
    tagDisposition: "blocked",
    status: "imported",
    media: [],
    work: null,
    postedAt: new Date(0),
    fetchedAt: new Date(0),
  };
  const db = {
    candidatePost: { findUnique: async () => row },
  } as unknown as PrismaService;
  const service = new CandidatesService(
    db,
    {} as FileObjectsService,
    undefined,
    analysis(model),
  );
  const dto = await service.get(row.id);
  assert.deepEqual(dto.classificationTags, [expected[1]]);
  assert.equal(dto.visualClass, "photo");
  assert.equal(dto.classificationRevision, 2);
  assert.equal(dto.tagDisposition, "blocked");
  for (const state of ["queued", "failed", "unprocessed"]) {
    row.analysisState = state;
    assert.deepEqual((await service.get(row.id)).classificationTags, []);
  }
  row.analysisState = "succeeded";
  row.analysisModelKey = "old-model";
  assert.deepEqual((await service.get(row.id)).classificationTags, []);
  const disabled = new ImageAnalysisService(
    db,
    {} as JobsService,
    {} as FileObjectsService,
    null,
  );
  assert.deepEqual(
    (
      await new CandidatesService(
        db,
        {} as FileObjectsService,
        undefined,
        disabled,
      ).get(row.id)
    ).classificationTags,
    [],
  );
});
