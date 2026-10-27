import { createHash } from "node:crypto";

export const IMAGE_ANALYSIS_ADAPTER = Symbol("IMAGE_ANALYSIS_ADAPTER");

/** Every change that can affect an output must change one of these identities. */
export interface ImageAnalysisIdentity {
  adapterId: string;
  adapterVersion: string;
  modelId: string;
  modelRevision: string;
  decisionVersion: string;
  preprocessVersion: string;
  /** Ordered, unique taxonomy for this adapter; classScores uses the same order. */
  labels: readonly string[];
}

export interface ImageAnalysisResult {
  /** Independent review-priority score in [0, 1], defined by the adapter. */
  score: number;
  predictedClass: string;
  classScores: { label: string; value: number }[];
  evidence: Record<string, unknown>[];
}

export interface ImageAnalysisAdapter {
  readonly identity: ImageAnalysisIdentity;
  /** Review routing reads cached class confidence; changing this does not change inference identity. */
  readonly reviewPolicy?: {
    readonly positiveLabels: readonly string[];
    readonly minimumConfidence: number;
  };
  analyze(
    itemId: string,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<ImageAnalysisResult>;
}

export interface ActiveImageAnalysisAdapter extends ImageAnalysisAdapter {
  readonly modelKey: string;
}

const identityFields = [
  "adapterId",
  "adapterVersion",
  "modelId",
  "modelRevision",
  "decisionVersion",
  "preprocessVersion",
] as const;

export function imageAnalysisModelKey(identity: ImageAnalysisIdentity): string {
  const values = identityFields.map((field) => identity?.[field]);
  if (
    values.some(
      (value) =>
        typeof value !== "string" || !value.trim() || value.length > 256,
    )
  )
    throw new Error("Invalid image analysis identity");
  validateLabels(identity?.labels);
  return createHash("sha256")
    .update(JSON.stringify(["image-analysis-v2", ...values, identity.labels]))
    .digest("hex");
}

function validateLabels(labels: readonly string[]): void {
  if (
    !Array.isArray(labels) ||
    labels.length < 2 ||
    labels.length > 100 ||
    Array.from(labels).some(
      (label) =>
        typeof label !== "string" || !label.trim() || label.length > 256,
    ) ||
    new Set(labels).size !== labels.length
  )
    throw new Error("Invalid image analysis taxonomy");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function validateImageAnalysisResult(
  value: unknown,
  labels: readonly string[],
): ImageAnalysisResult {
  validateLabels(labels);
  const result = object(value);
  const scores = Array.isArray(result?.classScores)
    ? result.classScores.map(object)
    : [];
  if (
    !result ||
    scores.length !== labels.length ||
    scores.some(
      (score, i) =>
        !score ||
        score.label !== labels[i] ||
        typeof score.value !== "number" ||
        !Number.isFinite(score.value) ||
        score.value < 0 ||
        score.value > 1,
    )
  )
    throw new Error("Invalid image analysis result");
  const probabilities = scores.map((score) => score!.value as number);
  if (
    Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.00001 ||
    result.predictedClass !==
      labels[probabilities.indexOf(Math.max(...probabilities))] ||
    typeof result.score !== "number" ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 1 ||
    !Array.isArray(result.evidence) ||
    result.evidence.length > 32 ||
    result.evidence.some((entry) => !object(entry))
  )
    throw new Error("Invalid image analysis result");
  // Reject cyclic/non-JSON evidence, non-finite numbers and oversized responses before persistence.
  const serialized = JSON.stringify(result, (_key, item: unknown) => {
    if (
      (typeof item === "number" && !Number.isFinite(item)) ||
      typeof item === "bigint" ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      item === undefined
    )
      throw new Error("Invalid image analysis evidence");
    return item;
  });
  if (Buffer.byteLength(serialized) > 1024 * 1024)
    throw new Error("Image analysis result is too large");
  const clean = JSON.parse(serialized) as ImageAnalysisResult;
  return {
    score: clean.score,
    predictedClass: clean.predictedClass,
    classScores: clean.classScores,
    evidence: clean.evidence,
  };
}

/** Freeze identities and validate outputs at the application boundary, including external modules. */
export function activateImageAnalysisAdapter(
  adapter: ImageAnalysisAdapter,
): ActiveImageAnalysisAdapter {
  const modelKey = imageAnalysisModelKey(adapter?.identity);
  if (typeof adapter.analyze !== "function")
    throw new Error("Invalid image analysis adapter");
  const identity = Object.freeze({
    ...Object.fromEntries(
      identityFields.map((field) => [field, adapter.identity[field]]),
    ),
    labels: Object.freeze([...adapter.identity.labels]),
  }) as unknown as ImageAnalysisIdentity;
  const policy = adapter.reviewPolicy;
  if (
    policy !== undefined &&
    (!object(policy) ||
      !Array.isArray(policy.positiveLabels) ||
      Array.from(policy.positiveLabels).some(
        (label) => !identity.labels.includes(label),
      ) ||
      new Set(policy.positiveLabels).size !== policy.positiveLabels.length ||
      typeof policy.minimumConfidence !== "number" ||
      !Number.isFinite(policy.minimumConfidence) ||
      policy.minimumConfidence < 0 ||
      policy.minimumConfidence > 1)
  )
    throw new Error("Invalid image analysis review policy");
  const reviewPolicy =
    policy === undefined
      ? undefined
      : Object.freeze({
          positiveLabels: Object.freeze([...policy.positiveLabels]),
          minimumConfidence: policy.minimumConfidence,
        });
  return Object.freeze({
    identity,
    modelKey,
    ...(reviewPolicy ? { reviewPolicy } : {}),
    async analyze(itemId: string, body: Uint8Array, signal: AbortSignal) {
      try {
        signal.throwIfAborted();
        if (!body.byteLength || body.byteLength > 32 * 1024 * 1024)
          throw new Error();
        const result = validateImageAnalysisResult(
          await adapter.analyze(itemId, body, signal),
          identity.labels,
        );
        signal.throwIfAborted();
        return result;
      } catch {
        throw new Error(
          "Image analysis failed or returned an incompatible result",
        );
      }
    },
  });
}
