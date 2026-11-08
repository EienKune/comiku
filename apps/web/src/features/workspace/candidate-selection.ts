export function selectCandidates(
  current: ReadonlyMap<string, number>,
  candidates: readonly { id: string; revision: number }[],
) {
  const next = new Map(current);
  for (const candidate of candidates)
    if (!next.has(candidate.id)) next.set(candidate.id, candidate.revision);
  return next;
}

export function settleCandidateSelection(
  current: ReadonlyMap<string, number>,
  results: readonly { id: string; outcome: string }[],
) {
  const next = new Map(current);
  for (const result of results)
    if (result.outcome === "succeeded" || result.outcome === "unchanged")
      next.delete(result.id);
  return next;
}
