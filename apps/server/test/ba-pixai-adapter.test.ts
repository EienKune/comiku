import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";
import type { JobsService } from "../src/jobs/jobs.service.js";

const config = {
  url: "http://127.0.0.1:19123",
  token: "synthetic-fixture-token",
  modelRevision: "frozen-model",
  decisionVersion: "frozen-head",
  preprocessVersion: "original-whole-v1",
};
function response(requestId: string, itemId: string) {
  return {
    schemaVersion: 2,
    requestId,
    modelId: "pixai-int8-three-class",
    modelRevision: config.modelRevision,
    decisionVersion: config.decisionVersion,
    items: [
      {
        itemId,
        status: "succeeded",
        result: {
          predictedClass: "ba_art",
          classScores: [
            { label: "ba_art", value: 0.8 },
            { label: "ba_related", value: 0.15 },
            { label: "other", value: 0.05 },
          ],
          evidence: [{ label: "synthetic-character", score: 0.6 }],
          score: { value: 0.8 },
        },
      },
    ],
  };
}

test("public BA adapter retains native BA labels and original evidence", async () => {
  const { createBaPixaiImageAnalysisAdapter } =
    await import("../src/image-analysis/adapters/ba-pixai/ba-pixai-adapter.js");
  const adapter = createBaPixaiImageAnalysisAdapter(
    config,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.items[0].preprocessVersion, "original-whole-v1");
      assert.equal(
        body.items[0].views[0].jpegBase64,
        Buffer.from("original").toString("base64"),
      );
      assert.equal(
        body.items[0].sourceSha256,
        "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5",
      );
      return Response.json(response(body.requestId, body.items[0].itemId));
    },
  );
  const result = await adapter.analyze(
    "image",
    Buffer.from("original"),
    new AbortController().signal,
  );
  assert.equal(result.predictedClass, "ba_art");
  assert.deepEqual(adapter.identity.labels, ["ba_art", "ba_related", "other"]);
  assert.deepEqual(
    result.classScores.map((score) => score.label),
    ["ba_art", "ba_related", "other"],
  );
  assert.equal(result.score, 0.8);
  const original = result.evidence[0].originalResult as ReturnType<
    typeof response
  >["items"][0]["result"];
  assert.equal(original.predictedClass, "ba_art");
  assert.equal(original.evidence[0].label, "synthetic-character");
});

test("native BA winner confidence controls promotion and uses a distinct adapter identity", async () => {
  const { createBaPixaiImageAnalysisAdapter } =
    await import("../src/image-analysis/adapters/ba-pixai/ba-pixai-adapter.js");
  const { activateImageAnalysisAdapter, imageAnalysisModelKey } =
    await import("../src/image-analysis/image-analysis-adapter.js");
  const { ImageAnalysisService } =
    await import("../src/image-analysis/image-analysis.service.js");
  for (const { winner, probabilities, expected } of [
    { winner: "ba_art", probabilities: [0.8, 0.15, 0.05], expected: true },
    { winner: "ba_art", probabilities: [0.485, 0.3, 0.215], expected: false },
    { winner: "ba_related", probabilities: [0.2, 0.7, 0.1], expected: false },
    { winner: "other", probabilities: [0.1, 0.2, 0.7], expected: false },
  ]) {
    const model = activateImageAnalysisAdapter(
      createBaPixaiImageAnalysisAdapter(config, async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const raw = response(body.requestId, body.items[0].itemId);
        raw.items[0].result.predictedClass = winner;
        raw.items[0].result.classScores.forEach((score, index) => {
          score.value = probabilities[index];
        });
        raw.items[0].result.score.value = probabilities[0];
        return Response.json(raw);
      }),
    );
    const result = await model.analyze(
      "image",
      Buffer.from("original"),
      new AbortController().signal,
    );
    assert.equal(result.predictedClass, winner);
    const confidence = result.classScores.find(
      (score) => score.label === winner,
    )!.value;
    const service = new ImageAnalysisService(
      {} as PrismaService,
      {} as JobsService,
      {} as FileObjectsService,
      model,
    );
    assert.equal(
      service.promotesReview([{ label: result.predictedClass, confidence }]),
      expected,
    );
    assert.equal(model.identity.adapterVersion, "2");
    assert.equal(model.identity.modelRevision, config.modelRevision);
    assert.notEqual(
      model.modelKey,
      imageAnalysisModelKey({
        ...model.identity,
        adapterVersion: "1",
        labels: ["comic", "comic_related", "other"],
      }),
    );
  }
});

test("BA transport rejects unsafe endpoints and incompatible frozen model responses", async () => {
  const { createBaPixaiImageAnalysisAdapter } =
    await import("../src/image-analysis/adapters/ba-pixai/ba-pixai-adapter.js");
  for (const url of [
    "https://127.0.0.1:19123",
    "http://localhost:19123",
    "http://127.0.0.1:19123/path",
    "http://remote.test:19123",
  ])
    assert.throws(() => createBaPixaiImageAnalysisAdapter({ ...config, url }));
  for (const variant of [
    "request",
    "model",
    "decision",
    "item",
    "failed",
    "probabilities",
    "score",
    "wrong-score",
    "network",
    "too-large",
  ]) {
    const adapter = createBaPixaiImageAnalysisAdapter(
      config,
      async (_url, init) => {
        if (variant === "network") throw Error("secret-token upstream");
        if (variant === "too-large")
          return new Response("a".repeat(1024 * 1024 + 1));
        const body = JSON.parse(String(init?.body)),
          raw = response(body.requestId, body.items[0].itemId);
        if (variant === "request") raw.requestId = "different";
        if (variant === "model") raw.modelRevision = "different";
        if (variant === "decision") raw.decisionVersion = "different";
        if (variant === "item") raw.items[0].itemId = "different";
        if (variant === "failed") raw.items[0].status = "failed";
        if (variant === "probabilities")
          raw.items[0].result.classScores[0].value = 2;
        if (variant === "score")
          Reflect.deleteProperty(raw.items[0].result, "score");
        if (variant === "wrong-score") raw.items[0].result.score.value = 0.2;
        return Response.json(raw);
      },
    );
    await assert.rejects(
      adapter.analyze(
        "image",
        Buffer.from("original"),
        new AbortController().signal,
      ),
      (error) =>
        error instanceof Error && !error.message.includes("secret-token"),
    );
  }
});

test("built-in BA selection loads a private absolute config file without loading model weights", async () => {
  const { loadImageAnalysisAdapter } =
    await import("../src/image-analysis/adapter-loader.js");
  const folder = await mkdtemp(join(tmpdir(), "comiku-ba-adapter-"));
  const configFile = join(folder, "config.json");
  try {
    await writeFile(configFile, JSON.stringify(config));
    const adapter = await loadImageAnalysisAdapter({
      adapter: "ba-pixai",
      configFile,
    });
    assert.ok(adapter);
    assert.equal(adapter.identity.adapterId, "ba-pixai-http");
    assert.deepEqual(adapter.identity.labels, [
      "ba_art",
      "ba_related",
      "other",
    ]);
    await writeFile(
      configFile,
      JSON.stringify({ ...config, token: "", modelRevision: "invalid-secret" }),
    );
    await assert.rejects(
      loadImageAnalysisAdapter({ adapter: "ba-pixai", configFile }),
      (error) =>
        error instanceof Error && !error.message.includes("invalid-secret"),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
