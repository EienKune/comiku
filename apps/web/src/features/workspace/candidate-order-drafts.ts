import type { components } from "@comiku/api-client";
type Candidate = components["schemas"]["CandidateDto"];
export type CandidateOrderDraft = {
  media: Candidate["media"];
  originalMediaIds: string[];
  expectedRevision: number;
  dirty: boolean;
};
export function candidateOrderDraft(
  stored: CandidateOrderDraft | undefined,
  candidate: Candidate,
): CandidateOrderDraft {
  if (stored && (stored.dirty || stored.expectedRevision > candidate.revision))
    return stored;
  return {
    media: candidate.media,
    originalMediaIds: candidate.media.map((i) => i.id),
    expectedRevision: candidate.revision,
    dirty: false,
  };
}
export function moveCandidateOrder(
  stored: CandidateOrderDraft | undefined,
  candidate: Candidate,
  index: number,
  offset: number,
) {
  const current = candidateOrderDraft(stored, candidate),
    media = [...current.media],
    target = index + offset;
  if (target < 0 || target >= media.length) return current;
  [media[index], media[target]] = [media[target], media[index]];
  return {
    ...current,
    media,
    dirty: media.some((item, i) => item.id !== current.originalMediaIds[i]),
  };
}
export function candidateOrderConflict(
  draft: CandidateOrderDraft,
  candidate: Candidate,
) {
  if (candidate.revision < draft.expectedRevision) return false;
  return (
    candidate.revision !== draft.expectedRevision ||
    candidate.media.length !== draft.originalMediaIds.length ||
    candidate.media.some((item, i) => item.id !== draft.originalMediaIds[i])
  );
}
