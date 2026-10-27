import { createHash, randomUUID } from "node:crypto";

export interface BaPixaiConfig {
  url: string;
  token: string;
  modelRevision: string;
  decisionVersion: string;
  preprocessVersion: "original-whole-v1";
}

const labels = ["ba_art", "ba_related", "other"] as const;
export type BaPixaiLabel = (typeof labels)[number];
export interface BaPixaiResult {
  score: number;
  predictedClass: BaPixaiLabel;
  classScores: { label: BaPixaiLabel; value: number }[];
  originalResult: Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseConfig(input: unknown): BaPixaiConfig {
  try {
    const config = object(input);
    if (!config || typeof config.url !== "string") throw new Error();
    const endpoint = new URL(config.url);
    if (
      endpoint.origin !== config.url ||
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      ![config.token, config.modelRevision, config.decisionVersion].every(
        (value) => typeof value === "string" && value.trim(),
      ) ||
      config.preprocessVersion !== "original-whole-v1"
    )
      throw new Error();
    return Object.freeze({
      url: config.url,
      token: config.token as string,
      modelRevision: config.modelRevision as string,
      decisionVersion: config.decisionVersion as string,
      preprocessVersion: "original-whole-v1",
    });
  } catch {
    throw new Error("Invalid BA PixAI configuration");
  }
}

/** HTTP v2 client only: model artifacts and the resident inference runtime are provided separately. */
export class PixaiClient {
  readonly config: BaPixaiConfig;
  constructor(
    config: unknown,
    private readonly request: typeof fetch = fetch,
  ) {
    this.config = parseConfig(config);
  }

  async analyze(
    itemId: string,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<BaPixaiResult> {
    try {
      signal.throwIfAborted();
      if (!body.byteLength || body.byteLength > 32 * 1024 * 1024)
        throw new Error();
      const requestId = randomUUID();
      const response = await this.request(`${this.config.url}/v2/analyze`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
        body: JSON.stringify({
          schemaVersion: 2,
          requestId,
          expectedModelRevision: this.config.modelRevision,
          expectedDecisionVersion: this.config.decisionVersion,
          items: [
            {
              itemId,
              sourceSha256: createHash("sha256").update(body).digest("hex"),
              preprocessVersion: this.config.preprocessVersion,
              views: [
                {
                  viewId: "whole",
                  jpegBase64: Buffer.from(body).toString("base64"),
                },
              ],
            },
          ],
        }),
      });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const raw = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (
        !raw ||
        raw.schemaVersion !== 2 ||
        raw.requestId !== requestId ||
        raw.modelId !== "pixai-int8-three-class" ||
        raw.modelRevision !== this.config.modelRevision ||
        raw.decisionVersion !== this.config.decisionVersion ||
        !Array.isArray(raw.items) ||
        raw.items.length !== 1
      )
        throw new Error();
      const item = object(raw.items[0]),
        result = object(item?.result);
      if (
        item?.itemId !== itemId ||
        item.status !== "succeeded" ||
        !result ||
        !Array.isArray(result.classScores) ||
        result.classScores.length !== labels.length ||
        !Array.isArray(result.evidence) ||
        result.evidence.length > 5
      )
        throw new Error();
      const scores = result.classScores.map(object);
      if (
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
        throw new Error();
      const probabilities = scores.map((score) => score!.value as number),
        reportedScore = object(result.score)?.value;
      const predictedClass =
        labels[probabilities.indexOf(Math.max(...probabilities))];
      if (
        Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 0.00001 ||
        result.predictedClass !== predictedClass ||
        typeof reportedScore !== "number" ||
        !Number.isFinite(reportedScore) ||
        Math.abs(reportedScore - probabilities[0]) > 0.00001
      )
        throw new Error();
      const evidence = result.evidence.map(object);
      if (
        evidence.some(
          (entry) =>
            !entry ||
            typeof entry.label !== "string" ||
            entry.label.length > 256 ||
            typeof entry.score !== "number" ||
            !Number.isFinite(entry.score) ||
            entry.score < 0 ||
            entry.score > 1,
        )
      )
        throw new Error();
      signal.throwIfAborted();
      return {
        score: probabilities[0],
        predictedClass,
        classScores: labels.map((label, i) => ({
          label,
          value: probabilities[i],
        })),
        originalResult: result,
      };
    } catch {
      throw new Error(
        "BA PixAI inference failed or returned an incompatible result",
      );
    }
  }
}
