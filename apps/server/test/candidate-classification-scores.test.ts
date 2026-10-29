import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";
import { activateImageAnalysisAdapter } from "../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../src/image-analysis/example-adapter.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";

const model = activateImageAnalysisAdapter({
  ...createExampleImageAnalysisAdapter(),
  identity: {
    ...createExampleImageAnalysisAdapter().identity,
    labels: ["accept", "reject"],
  },
  labelPresentation: [{ label: "accept", text: "接受", tone: "success" }],
  reviewPolicy: undefined,
});
const good = {
  score: 0.3,
  predictedClass: "reject",
  classScores: [
    { label: "accept", value: 0.2 },
    { label: "reject", value: 0.8 },
  ],
  evidence: [],
};
function fixture(
  rows: Record<string, unknown>[],
  enabled = true,
  visible = true,
) {
  let query: { strings: readonly string[]; values: unknown[] } | undefined;
  const db = {
    candidatePost: { findFirst: async () => (visible ? { id: "post" } : null) },
    $queryRaw: async (strings: readonly string[], ...values: unknown[]) => {
      query = { strings, values };
      return rows;
    },
  } as unknown as PrismaService;
  const service = new ImageAnalysisService(
    db,
    {} as JobsService,
    {} as FileObjectsService,
    enabled ? model : null,
  );
  return { service, query: () => query };
}
test("scores return every ordered image, binary dynamic columns, and only valid independent vectors", async () => {
  const f = fixture([
    { mediaId: "one", status: "succeeded", result: good },
    { mediaId: "two", status: "queued", result: null },
    { mediaId: "three", status: "failed", result: null },
    { mediaId: "four", status: null, result: null },
    {
      mediaId: "five",
      status: "succeeded",
      result: { ...good, predictedClass: "accept" },
    },
  ]);
  assert.deepEqual(await f.service.classificationScores("post"), {
    modelKey: model.modelKey,
    columns: [
      { label: "accept", text: "接受", tone: "success" },
      { label: "reject", text: "reject", tone: "neutral" },
    ],
    images: [
      {
        mediaId: "one",
        index: 1,
        state: "succeeded",
        scores: [0.2, 0.8],
        winner: 1,
      },
      {
        mediaId: "two",
        index: 2,
        state: "pending",
        scores: null,
        winner: null,
      },
      {
        mediaId: "three",
        index: 3,
        state: "failed",
        scores: null,
        winner: null,
      },
      {
        mediaId: "four",
        index: 4,
        state: "unavailable",
        scores: null,
        winner: null,
      },
      {
        mediaId: "five",
        index: 5,
        state: "unavailable",
        scores: null,
        winner: null,
      },
    ],
  });
  const query = f.query()!;
  const sql = query.strings.join("?");
  assert.ok(query.values.includes(model.modelKey));
  assert.ok(query.values.includes("post"));
  assert.match(sql, /source_sha256\s*=\s*f.checksum/);
  assert.match(sql, /lifecycle_status/);
  assert.match(sql, /ORDER BY m.order_index/);
  assert.doesNotMatch(sql, /SELECT\s+\*|a.result_json\s+AS/i);
  assert.match(sql, /classScores/);
});
test("malformed, incomplete, foreign and non-finite vectors never become zero scores", async () => {
  for (const result of [
    null,
    { ...good, classScores: [] },
    {
      ...good,
      classScores: [
        { label: "accept", value: NaN },
        { label: "reject", value: 0.8 },
      ],
    },
    { ...good, score: 2 },
    {
      ...good,
      classScores: [
        { label: "foreign", value: 0.2 },
        { label: "reject", value: 0.8 },
      ],
    },
  ]) {
    const f = fixture([{ mediaId: "one", status: "succeeded", result }]);
    const value = await f.service.classificationScores("post");
    assert.equal(value.images[0].state, "unavailable");
    assert.equal(value.images[0].scores, null);
  }
});
test("disabled models retain image order without a fabricated taxonomy; missing/deleted author is 404", async () => {
  const f = fixture([{ mediaId: "one", status: null, result: null }], false);
  assert.deepEqual(await f.service.classificationScores("post"), {
    modelKey: null,
    columns: [],
    images: [
      {
        mediaId: "one",
        index: 1,
        state: "unavailable",
        scores: null,
        winner: null,
      },
    ],
  });
  const missing = fixture([], true, false);
  await assert.rejects(missing.service.classificationScores("missing"), {
    status: 404,
  });
  assert.equal(missing.query(), undefined);
});
