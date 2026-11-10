import type { components } from "@comiku/api-client";

type Candidate = components["schemas"]["CandidateDto"];
export type CandidateImageSource = Pick<Candidate, "id" | "revision" | "media">;
export type CandidateImageDraft = {
  expectedRevision: number;
  sourceMediaIds: string[];
  mediaIds: string[];
  editVersion: number;
};

export function candidateImageDraft(
  stored: CandidateImageDraft | undefined,
  candidate: CandidateImageSource,
): CandidateImageDraft {
  if (stored) return stored;
  const ids = candidate.media.map((media) => media.id);
  return {
    expectedRevision: candidate.revision,
    sourceMediaIds: ids,
    mediaIds: [...ids],
    editVersion: 0,
  };
}

export function validateCandidateImageIds(
  ids: readonly string[],
  sourceIds: readonly string[],
) {
  const source = new Set(sourceIds);
  return (
    ids.length > 0 &&
    ids.length <= 1000 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => source.has(id))
  );
}

export function candidateImageDraftConflict(
  draft: CandidateImageDraft,
  candidate: CandidateImageSource,
) {
  return (
    draft.expectedRevision !== candidate.revision ||
    draft.sourceMediaIds.length !== candidate.media.length ||
    candidate.media.some(
      (media, index) => media.id !== draft.sourceMediaIds[index],
    )
  );
}

export function applyCandidateImageDraft(
  stored: CandidateImageDraft | undefined,
  candidate: CandidateImageSource,
  mediaIds: readonly string[],
) {
  const current = candidateImageDraft(stored, candidate);
  if (candidateImageDraftConflict(current, candidate))
    throw new Error("帖子图片或版本已变化，请重新审核后调整");
  if (!validateCandidateImageIds(mediaIds, current.sourceMediaIds))
    throw new Error("至少选择一张属于本帖的图片，且不能重复");
  return {
    ...current,
    mediaIds: [...mediaIds],
    editVersion: current.editVersion + 1,
  };
}

export function candidateImageDraftChanged(draft: CandidateImageDraft) {
  return (
    draft.mediaIds.length !== draft.sourceMediaIds.length ||
    draft.mediaIds.some((id, index) => id !== draft.sourceMediaIds[index])
  );
}

export function candidateImageSelectionSummary(draft: CandidateImageDraft) {
  const sourcePositions = draft.mediaIds.map((id) =>
    draft.sourceMediaIds.indexOf(id),
  );
  return {
    selectedCount: draft.mediaIds.length,
    totalCount: draft.sourceMediaIds.length,
    orderChanged: sourcePositions.some(
      (position, index) => index > 0 && position < sourcePositions[index - 1],
    ),
  };
}
