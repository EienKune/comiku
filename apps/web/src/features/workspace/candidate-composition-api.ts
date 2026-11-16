import { z } from "zod";
import type { components } from "@comiku/api-client";
import { client, unwrap } from "../account/api";
import type { CompositionIntent } from "./candidate-composition-model";

const id = z.string().min(1);
const receiptSchema = z.object({
  idempotencyKey: id,
  mode: z.enum(["merge", "split"]),
  works: z
    .array(
      z.object({
        workId: id,
        workNumber: z.number().int().positive(),
        title: z.string().nullable(),
        imageCount: z.number().int().positive(),
        sourceCandidateIds: z.array(id).min(1),
      }),
    )
    .min(1)
    .max(20),
  candidates: z
    .array(
      z.object({
        id,
        revision: z.number().int().nonnegative(),
        status: z.literal("imported"),
        workIds: z.array(id).min(1),
      }),
    )
    .min(1)
    .max(20),
  unadoptedMediaIds: z.array(id).max(1000),
});
export type CompositionReceipt =
  components["schemas"]["CandidateCompositionResultDto"];
export class CompositionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(result: {
  data?: CompositionReceipt;
  error?: unknown;
  response: Response;
}): Promise<unknown> {
  try {
    return await unwrap(result);
  } catch (error) {
    throw new CompositionRequestError(
      result.response.status,
      error instanceof Error ? error.message : "请求失败",
    );
  }
}
export const compositionApi = {
  submit: async (intent: CompositionIntent): Promise<unknown> =>
    request(
      await client.POST("/api/candidates/compositions", { body: intent }),
    ),
  lookup: async (key: string): Promise<unknown> =>
    request(
      await client.GET("/api/candidates/compositions/{idempotencyKey}", {
        params: { path: { idempotencyKey: key } },
      }),
    ),
};

function sameMembers(a: readonly string[], b: readonly string[]) {
  return (
    a.length === b.length &&
    new Set(a).size === a.length &&
    new Set(b).size === b.length &&
    a.every((item) => b.includes(item))
  );
}
export function validateCompositionReceipt(
  data: unknown,
  intent: CompositionIntent,
  originals: ReadonlyMap<string, readonly string[]>,
): CompositionReceipt {
  const parsed = receiptSchema.safeParse(data);
  const fail = () => {
    throw new Error("入库回执不完整，尚未确认全部结果");
  };
  if (!parsed.success) return fail();
  const receipt = parsed.data;
  if (
    receipt.idempotencyKey !== intent.idempotencyKey ||
    receipt.mode !== intent.mode ||
    receipt.works.length !== intent.works.length ||
    !sameMembers(
      receipt.candidates.map((source) => source.id),
      intent.candidates.map((source) => source.id),
    ) ||
    new Set(receipt.works.map((work) => work.workId)).size !==
      receipt.works.length
  )
    return fail();
  const mediaSource = new Map(
    [...originals].flatMap(([sourceId, mediaIds]) =>
      mediaIds.map((mediaId) => [mediaId, sourceId] as const),
    ),
  );
  for (const [index, work] of receipt.works.entries()) {
    const submitted = intent.works[index];
    const sources = [
      ...new Set(
        submitted.mediaIds
          .map((mediaId) => mediaSource.get(mediaId))
          .filter((sourceId): sourceId is string => sourceId !== undefined),
      ),
    ];
    if (
      work.imageCount !== submitted.mediaIds.length ||
      work.title !== submitted.title ||
      !sameMembers(work.sourceCandidateIds, sources)
    )
      return fail();
  }
  for (const source of receipt.candidates) {
    const submitted = intent.candidates.find(
      (candidate) => candidate.id === source.id,
    )!;
    const works = receipt.works
      .filter((work) => work.sourceCandidateIds.includes(source.id))
      .map((work) => work.workId);
    if (
      source.revision !== submitted.expectedRevision + 1 ||
      !sameMembers(source.workIds, works)
    )
      return fail();
  }
  const adopted = new Set(intent.works.flatMap((work) => work.mediaIds));
  const unadopted = intent.candidates
    .flatMap((candidate) => originals.get(candidate.id) ?? [])
    .filter((mediaId) => !adopted.has(mediaId));
  if (!sameMembers(receipt.unadoptedMediaIds, unadopted)) return fail();
  return receipt;
}
