import type { components } from "@comiku/api-client";
import { CANDIDATE_SELECTION_LIMIT } from "./candidate-selection";
import {
  applyCandidateImageDraft,
  candidateImageDraft,
  candidateImageDraftConflict,
  validateCandidateImageIds,
  type CandidateImageDraft,
} from "./candidate-image-drafts";

export type ImportCandidate = components["schemas"]["CandidateDto"];
export type CandidateSelectionSnapshot = {
  candidate: ImportCandidate;
  token: string;
};
export type CandidateImportState = {
  selected: Map<string, CandidateSelectionSnapshot>;
  drafts: Record<string, CandidateImageDraft>;
};
export type CandidateImportEntry = {
  id: string;
  expectedRevision: number;
  mediaIds: string[];
  candidate: ImportCandidate;
  selectionToken: string;
  draftVersion: number;
};
export const emptyCandidateImportState = (): CandidateImportState => ({
  selected: new Map(),
  drafts: {},
});

export function selectCandidateForImport(
  state: CandidateImportState,
  candidate: ImportCandidate,
  token: string,
): CandidateImportState {
  const selected = new Map(state.selected);
  if (selected.has(candidate.id)) selected.delete(candidate.id);
  else if (selected.size < CANDIDATE_SELECTION_LIMIT)
    selected.set(candidate.id, {
      candidate: {
        ...candidate,
        media: candidate.media.map((media) => ({ ...media })),
      },
      token,
    });
  return { ...state, selected };
}

export function applyImportDraft(
  state: CandidateImportState,
  candidate: ImportCandidate,
  ids: readonly string[],
) {
  const selected = state.selected.get(candidate.id);
  if (selected && selected.candidate.revision !== candidate.revision)
    throw new Error("帖子版本已更新，请先重新审核最新图片");
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [candidate.id]: applyCandidateImageDraft(
        state.drafts[candidate.id],
        candidate,
        ids,
      ),
    },
  };
}

export function resetImportCandidate(
  state: CandidateImportState,
  candidate: ImportCandidate,
  token: string,
) {
  const selected = new Map(state.selected);
  if (selected.has(candidate.id))
    selected.set(candidate.id, { candidate, token });
  const drafts = { ...state.drafts };
  delete drafts[candidate.id];
  return { ...state, selected, drafts };
}

export function buildCandidateImportIntent(
  state: CandidateImportState,
): CandidateImportEntry[] {
  return [...state.selected].map(([id, entry]) => {
    const candidate = entry.candidate,
      draft = candidateImageDraft(state.drafts[id], candidate);
    if (candidate.status !== "pending")
      throw new Error(`${candidate.authorName}：当前状态不允许入库`);
    if (candidateImageDraftConflict(draft, candidate))
      throw new Error(
        `${candidate.authorName}：帖子图片或版本已更新，请先重新审核`,
      );
    if (!validateCandidateImageIds(draft.mediaIds, draft.sourceMediaIds))
      throw new Error(`${candidate.authorName}：至少选择一张属于本帖的图片`);
    return {
      id,
      expectedRevision: candidate.revision,
      mediaIds: [...draft.mediaIds],
      candidate,
      selectionToken: entry.token,
      draftVersion: draft.editVersion,
    };
  });
}

export function settleCandidateImport(
  state: CandidateImportState,
  entries: readonly CandidateImportEntry[],
  results: readonly { id: string; outcome: string }[],
) {
  const selected = new Map(state.selected),
    drafts = { ...state.drafts },
    byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const result of results) {
    const entry = byId.get(result.id),
      current = selected.get(result.id);
    if (
      !entry ||
      !current ||
      !["succeeded", "unchanged"].includes(result.outcome)
    )
      continue;
    if (
      current.token !== entry.selectionToken ||
      current.candidate.revision !== entry.expectedRevision ||
      (drafts[result.id]?.editVersion ?? 0) !== entry.draftVersion
    )
      continue;
    selected.delete(result.id);
    delete drafts[result.id];
  }
  return { selected, drafts };
}
