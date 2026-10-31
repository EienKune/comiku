import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnvironment } from "../src/config/environment.js";

const database = {
  DATABASE_URL: "postgresql://test:test@127.0.0.1/comiku_test",
};

test("image analysis is disabled unless an adapter is explicitly selected", () => {
  assert.equal(parseEnvironment(database).imageAnalysis, undefined);
  assert.equal(
    parseEnvironment({ ...database, IMAGE_ANALYSIS_ADAPTER: "disabled" })
      .imageAnalysis,
    undefined,
  );
  assert.deepEqual(
    parseEnvironment({ ...database, IMAGE_ANALYSIS_ADAPTER: "example" })
      .imageAnalysis,
    { adapter: "example" },
  );
  assert.deepEqual(
    parseEnvironment({
      ...database,
      IMAGE_ANALYSIS_ADAPTER: "ba-pixai",
      IMAGE_ANALYSIS_CONFIG_FILE: "/private/config.json",
    }).imageAnalysis,
    { adapter: "ba-pixai", configFile: "/private/config.json" },
  );
  for (const fields of [
    { IMAGE_ANALYSIS_ADAPTER: "unknown" },
    { IMAGE_ANALYSIS_ADAPTER: "external" },
    { IMAGE_ANALYSIS_ADAPTER: "ba-pixai" },
    {
      IMAGE_ANALYSIS_ADAPTER: "ba-pixai",
      IMAGE_ANALYSIS_CONFIG_FILE: "relative.json",
    },
    {
      IMAGE_ANALYSIS_ADAPTER: "ba-pixai",
      IMAGE_ANALYSIS_CONFIG_FILE: "/private/config.json",
      IMAGE_ANALYSIS_MODULE: "/private/adapter.mjs",
    },
    { IMAGE_ANALYSIS_MODULE: "/private/adapter.mjs" },
    {
      IMAGE_ANALYSIS_ADAPTER: "external",
      IMAGE_ANALYSIS_MODULE: "relative.mjs",
      IMAGE_ANALYSIS_CONFIG_FILE: "/private/config.json",
    },
  ])
    assert.throws(
      () => parseEnvironment({ ...database, ...fields }),
      /IMAGE_ANALYSIS/,
    );
});

test("adapter identity includes provider, model, decision and preprocessing versions", async () => {
  const { imageAnalysisModelKey } =
    await import("../src/image-analysis/image-analysis-adapter.js");
  const identity = {
    adapterId: "fixture",
    adapterVersion: "1",
    modelId: "classifier",
    modelRevision: "frozen-model",
    decisionVersion: "head-1",
    preprocessVersion: "original-v1",
    labels: ["accept", "reject"],
  };
  const key = imageAnalysisModelKey(identity);
  assert.match(key, /^[a-f0-9]{64}$/);
  for (const field of Object.keys(identity).filter(
    (field) => field !== "labels",
  )) {
    assert.notEqual(
      imageAnalysisModelKey({ ...identity, [field]: "different" }),
      key,
    );
  }
  assert.notEqual(
    imageAnalysisModelKey({ ...identity, labels: ["comic", "other"] }),
    key,
  );
  assert.notEqual(
    imageAnalysisModelKey({ ...identity, labels: ["reject", "accept"] }),
    key,
  );
  for (const labels of [
    [],
    ["one"],
    ["same", "same"],
    ["", "other"],
    ["  ", "other"],
    Object.assign(new Array<string>(3), { 0: "accept", 2: "reject" }),
    ["a".repeat(257), "other"],
    Array.from({ length: 101 }, (_, i) => String(i)),
  ]) {
    assert.throws(() =>
      imageAnalysisModelKey({ ...identity, labels: labels as string[] }),
    );
  }
  assert.equal(imageAnalysisModelKey({ ...identity }), key);
});

test("disabled loading has no classifier while example explicitly returns synthetic generic evidence", async () => {
  const { loadImageAnalysisAdapter } =
    await import("../src/image-analysis/adapter-loader.js");
  assert.equal(await loadImageAnalysisAdapter(undefined), null);
  const model = await loadImageAnalysisAdapter({ adapter: "example" });
  assert.ok(model);
  const result = await model.analyze(
    "image",
    Buffer.from("bytes"),
    new AbortController().signal,
  );
  assert.equal(result.predictedClass, "comic");
  assert.equal(result.evidence[0].synthetic, true);
  assert.equal(model.identity.adapterId, "example-synthetic");
  assert.deepEqual(model.identity.labels, ["comic", "comic_related", "other"]);
});

test("external modules load through an absolute trusted path and invalid results never become scores", async () => {
  const { loadImageAnalysisAdapter } =
    await import("../src/image-analysis/adapter-loader.js");
  const folder = await mkdtemp(join(tmpdir(), "comiku-adapter-"));
  const modulePath = join(folder, "fixture.mjs");
  const configFile = join(folder, "config.json");
  try {
    await writeFile(configFile, JSON.stringify({ marker: "configured" }));
    await writeFile(
      modulePath,
      `export function createImageAnalysisAdapter(config) {
      return {
        identity: { adapterId: "external-fixture", adapterVersion: "1", modelId: "fixture", modelRevision: "1", decisionVersion: "1", preprocessVersion: "1", labels: ["accept", "reject"] },
        async analyze() {
          return { score: 0.91, predictedClass: "reject", classScores: [{label:"accept",value:0.2},{label:"reject",value:0.8}], evidence: [{marker:config.marker}] };
        }
      };
    }`,
    );
    const model = await loadImageAnalysisAdapter({
      adapter: "external",
      modulePath,
      configFile,
    });
    assert.ok(model);
    assert.equal(
      (
        await model.analyze(
          "image",
          Buffer.from("original"),
          new AbortController().signal,
        )
      ).evidence[0].marker,
      "configured",
    );
    const { validateImageAnalysisResult } =
      await import("../src/image-analysis/image-analysis-adapter.js");
    const result = await model.analyze(
      "image",
      Buffer.from("original"),
      new AbortController().signal,
    );
    assert.equal(result.predictedClass, "reject");
    assert.equal(result.score, 0.91);
    assert.deepEqual(model.identity.labels, ["accept", "reject"]);
    for (const invalid of [
      { ...result, score: Number.NaN },
      { ...result, score: -0.2 },
      { ...result, score: 1.2 },
      { ...result, predictedClass: "other" },
      { ...result, classScores: [{ label: "comic", value: 1 }] },
      {
        ...result,
        classScores: [
          { label: "accept", value: 0.2 },
          { label: "other", value: 0.8 },
        ],
      },
      {
        ...result,
        classScores: [
          { label: "accept", value: 0.3 },
          { label: "reject", value: 0.8 },
        ],
      },
      { ...result, evidence: ["unstructured"] },
    ])
      assert.throws(() =>
        validateImageAnalysisResult(invalid, model.identity.labels),
      );
    await writeFile(configFile, "private-token invalid-json");
    await assert.rejects(
      loadImageAnalysisAdapter({ adapter: "external", modulePath, configFile }),
      (error) =>
        error instanceof Error && !error.message.includes("private-token"),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("activated adapters preserve a frozen taxonomy snapshot", async () => {
  const { activateImageAnalysisAdapter } =
    await import("../src/image-analysis/image-analysis-adapter.js");
  const labels = ["accept", "reject"];
  const model = activateImageAnalysisAdapter({
    identity: {
      adapterId: "snapshot",
      adapterVersion: "1",
      modelId: "fixture",
      modelRevision: "1",
      decisionVersion: "1",
      preprocessVersion: "1",
      labels,
    },
    async analyze() {
      return {
        score: 0.1,
        predictedClass: "accept",
        classScores: [
          { label: "accept", value: 0.7 },
          { label: "reject", value: 0.3 },
        ],
        evidence: [],
      };
    },
  });
  labels[0] = "changed";
  assert.deepEqual(model.identity.labels, ["accept", "reject"]);
  assert.ok(Object.isFrozen(model.identity.labels));
  assert.equal(
    (
      await model.analyze(
        "image",
        Buffer.from("fixture"),
        new AbortController().signal,
      )
    ).score,
    0.1,
  );
});

test("review policies are validated and frozen without changing inference identity", async () => {
  const { activateImageAnalysisAdapter } =
    await import("../src/image-analysis/image-analysis-adapter.js");
  const { createExampleImageAnalysisAdapter } =
    await import("../src/image-analysis/example-adapter.js");
  const example = createExampleImageAnalysisAdapter();
  const positiveLabels = ["comic"];
  const reviewPolicy = { positiveLabels, minimumConfidence: 0.5 };
  const active = activateImageAnalysisAdapter({ ...example, reviewPolicy });
  positiveLabels[0] = "other";
  reviewPolicy.minimumConfidence = 0.1;
  assert.deepEqual(active.reviewPolicy, {
    positiveLabels: ["comic"],
    minimumConfidence: 0.5,
    lowPriorityLabels: [],
  });
  assert.ok(Object.isFrozen(active.reviewPolicy));
  assert.ok(Object.isFrozen(active.reviewPolicy!.positiveLabels));
  assert.equal(
    activateImageAnalysisAdapter({
      ...example,
      reviewPolicy: { positiveLabels: ["other"], minimumConfidence: 0.9 },
    }).modelKey,
    active.modelKey,
  );
  for (const invalid of [
    null,
    { positiveLabels: "comic", minimumConfidence: 0.5 },
    { positiveLabels: ["unknown"], minimumConfidence: 0.5 },
    { positiveLabels: ["comic", "comic"], minimumConfidence: 0.5 },
    { positiveLabels: new Array<string>(1), minimumConfidence: 0.5 },
    ...[Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1, "0.5"].map(
      (minimumConfidence) => ({ positiveLabels: ["comic"], minimumConfidence }),
    ),
  ])
    assert.throws(() =>
      activateImageAnalysisAdapter({
        ...example,
        reviewPolicy: invalid,
      } as unknown as Parameters<typeof activateImageAnalysisAdapter>[0]),
    );
});
