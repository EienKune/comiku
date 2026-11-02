import { CandidatesService } from "../src/candidates/candidates.service.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { activateImageAnalysisAdapter } from "../src/image-analysis/image-analysis-adapter.js";
import { createExampleImageAnalysisAdapter } from "../src/image-analysis/example-adapter.js";
import { ImageAnalysisService } from "../src/image-analysis/image-analysis.service.js";

test("all valid priority winners promote without an extra confidence threshold", () => {
  const model = activateImageAnalysisAdapter(
    createExampleImageAnalysisAdapter(),
  );
  const service = new ImageAnalysisService(
    {} as never,
    {} as never,
    {} as never,
    model,
  );
  assert.equal(
    service.promotesReview([{ label: "comic", confidence: 0.4, score: 0.7 }]),
    true,
  );
});
test("low-priority policy is frozen, validated and independent from inference identity", () => {
  const adapter = createExampleImageAnalysisAdapter();
  const labels = ["other"];
  const model = activateImageAnalysisAdapter({
    ...adapter,
    reviewPolicy: { ...adapter.reviewPolicy!, lowPriorityLabels: labels },
  });
  labels[0] = "comic";
  assert.deepEqual(model.reviewPolicy?.lowPriorityLabels, ["other"]);
  assert.ok(Object.isFrozen(model.reviewPolicy?.lowPriorityLabels));
  assert.equal(model.modelKey, activateImageAnalysisAdapter(adapter).modelKey);
  for (const lowPriorityLabels of [
    ["foreign"],
    ["comic"],
    ["other", "other"],
    null,
  ])
    assert.throws(() =>
      activateImageAnalysisAdapter({
        ...adapter,
        reviewPolicy: { ...adapter.reviewPolicy!, lowPriorityLabels },
      } as never),
    );
});

test("review policy metadata exposes adapter names and routing without invoking inference", () => {
  const model = activateImageAnalysisAdapter(
    createExampleImageAnalysisAdapter(),
  );
  const analysis = new ImageAnalysisService(
    {} as never,
    {} as never,
    {} as never,
    model,
  );
  const service = new CandidatesService(
    {} as never,
    {} as never,
    undefined,
    analysis,
  );
  const policy = service.reviewPolicy();
  assert.equal(policy.modelKey, model.modelKey);
  assert.deepEqual(
    policy.classes.map(({ label, triageGroup }) => ({ label, triageGroup })),
    [
      { label: "comic", triageGroup: "priority" },
      { label: "comic_related", triageGroup: "uncertain" },
      { label: "other", triageGroup: "low_priority" },
    ],
  );
  const disabled = new CandidatesService(
    {} as never,
    {} as never,
  ).reviewPolicy();
  assert.equal(disabled.modelKey, null);
  assert.deepEqual(disabled.classes, []);
});
