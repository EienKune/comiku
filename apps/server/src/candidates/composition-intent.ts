import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { isUUID } from "class-validator";
import type { ComposeCandidatesDto } from "./composition.dto.js";

export function normalizeCandidateComposition(input: ComposeCandidatesDto) {
  const invalid = () => {
    throw new BadRequestException(
      "拆合入库请求无效，请检查来源、作品名称和图片分组",
    );
  };
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["idempotencyKey", "mode", "candidates", "works"].includes(key),
    ) ||
    !isUUID(input.idempotencyKey) ||
    !["merge", "split"].includes(input.mode)
  )
    invalid();
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length < 1 ||
    input.candidates.length > 20 ||
    !Array.isArray(input.works) ||
    input.works.length < 1 ||
    input.works.length > 20
  )
    invalid();
  const candidates = input.candidates
    .map((item) => {
      if (
        !item ||
        Object.keys(item).some(
          (key) => !["id", "expectedRevision"].includes(key),
        ) ||
        !isUUID(item.id) ||
        !Number.isSafeInteger(item.expectedRevision) ||
        item.expectedRevision < 0
      )
        invalid();
      return {
        id: item.id.toLowerCase(),
        expectedRevision: item.expectedRevision,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(candidates.map((item) => item.id)).size !== candidates.length)
    invalid();
  const seen = new Set<string>();
  const works = input.works.map((work) => {
    if (
      !work ||
      Object.keys(work).some((key) => !["title", "mediaIds"].includes(key)) ||
      (work.title !== null && typeof work.title !== "string") ||
      !Array.isArray(work.mediaIds) ||
      !work.mediaIds.length ||
      work.mediaIds.length > 1000
    )
      invalid();
    const title = work.title?.trim() || null;
    if (title && title.length > 200) invalid();
    const mediaIds = work.mediaIds.map((id) => {
      if (!isUUID(id) || seen.has(id.toLowerCase())) invalid();
      const normalized = id.toLowerCase();
      seen.add(normalized);
      return normalized;
    });
    return { title, mediaIds };
  });
  if (
    seen.size > 1000 ||
    (input.mode === "merge" && (candidates.length < 2 || works.length !== 1)) ||
    (input.mode === "split" &&
      (candidates.length !== 1 ||
        works.length < 2 ||
        works.some((work) => !work.title)))
  )
    invalid();
  const intent = { mode: input.mode, candidates, works };
  return {
    ...intent,
    idempotencyKey: input.idempotencyKey.toLowerCase(),
    payloadHash: createHash("sha256")
      .update(JSON.stringify(intent))
      .digest("hex"),
  };
}
