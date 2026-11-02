import type { ImageAnalysisAdapter } from "../../image-analysis-adapter.js";
import { PixaiClient } from "./pixai-client.js";

/** Public protocol and taxonomy adapter. No model weights or credentials are bundled. */
export function createBaPixaiImageAnalysisAdapter(
  config: unknown,
  request: typeof fetch = fetch,
): ImageAnalysisAdapter {
  const client = new PixaiClient(config, request);
  return {
    identity: Object.freeze({
      adapterId: "ba-pixai-http",
      adapterVersion: "2",
      modelId: "pixai-int8-three-class",
      modelRevision: client.config.modelRevision,
      decisionVersion: client.config.decisionVersion,
      preprocessVersion: client.config.preprocessVersion,
      labels: Object.freeze(["ba_art", "ba_related", "other"]),
    }),
    labelPresentation: [
      { label: "ba_art", text: "BA 漫画／插画", tone: "success" },
      { label: "ba_related", text: "BA 相关", tone: "info" },
      { label: "other", text: "非 BA 内容", tone: "neutral" },
    ],
    reviewPolicy: {
      positiveLabels: ["ba_art"],
      lowPriorityLabels: ["other"],
    },
    async analyze(itemId, body, signal) {
      const result = await client.analyze(itemId, body, signal);
      return {
        score: result.score,
        predictedClass: result.predictedClass,
        classScores: result.classScores,
        evidence: [
          {
            sourceModelId: "pixai-int8-three-class",
            originalResult: result.originalResult,
          },
        ],
      };
    },
  };
}
