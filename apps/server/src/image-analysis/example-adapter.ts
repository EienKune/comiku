import type { ImageAnalysisAdapter } from "./image-analysis-adapter.js";

/** Synthetic contract demonstration. It does not inspect or classify the image. */
export function createExampleImageAnalysisAdapter(): ImageAnalysisAdapter {
  return {
    identity: {
      adapterId: "example-synthetic",
      adapterVersion: "1",
      modelId: "no-model-demonstration",
      modelRevision: "1",
      decisionVersion: "fixed-example-v1",
      preprocessVersion: "none-v1",
      labels: ["comic", "comic_related", "other"],
    },
    labelPresentation: [
      { label: "comic", text: "漫画／插画", tone: "success" },
      { label: "comic_related", text: "漫画相关", tone: "info" },
      { label: "other", text: "其他内容", tone: "neutral" },
    ],
    reviewPolicy: {
      positiveLabels: ["comic"],
      minimumConfidence: 0.5,
      lowPriorityLabels: ["other"],
    },
    async analyze(_itemId, _body, signal) {
      signal.throwIfAborted();
      return {
        score: 0.75,
        predictedClass: "comic",
        classScores: [
          { label: "comic", value: 0.75 },
          { label: "comic_related", value: 0.2 },
          { label: "other", value: 0.05 },
        ],
        evidence: [
          {
            synthetic: true,
            description: "Contract example: fixed values, no image inference",
          },
        ],
      };
    },
  };
}
