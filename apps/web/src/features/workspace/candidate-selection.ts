export const CANDIDATE_SELECTION_LIMIT = 100;

export function selectCandidates(
  current: ReadonlyMap<string, number>,
  candidates: readonly { id: string; revision: number }[],
) {
  const next = new Map(current);
  for (const candidate of candidates)
    if (!next.has(candidate.id) && next.size < CANDIDATE_SELECTION_LIMIT)
      next.set(candidate.id, candidate.revision);
  return next;
}

export function toggleLoadedCandidates(
  current: ReadonlyMap<string, number>,
  candidates: readonly { id: string; revision: number }[],
) {
  if (!canCancelLoadedCandidates(current, candidates))
    return selectCandidates(current, candidates);
  const next = new Map(current);
  for (const item of candidates) next.delete(item.id);
  return next;
}

export function canCancelLoadedCandidates(
  current: ReadonlyMap<string, number>,
  candidates: readonly { id: string }[],
) {
  return (
    candidates.length > 0 &&
    candidates.some((item) => current.has(item.id)) &&
    (current.size >= CANDIDATE_SELECTION_LIMIT ||
      candidates.every((item) => current.has(item.id)))
  );
}

export function settleCandidateSelection(
  current: ReadonlyMap<string, number>,
  results: readonly { id: string; outcome: string }[],
  submitted: ReadonlyMap<string, number> = current,
) {
  const next = new Map(current);
  for (const result of results)
    if (
      (result.outcome === "succeeded" || result.outcome === "unchanged") &&
      submitted.has(result.id) &&
      current.get(result.id) === submitted.get(result.id)
    )
      next.delete(result.id);
  return next;
}
