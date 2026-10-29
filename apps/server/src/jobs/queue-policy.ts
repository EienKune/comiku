export type QueuePolicy = Readonly<{
  primary: string;
  secondary: string;
  primaryWeight: number;
}>;

/** The caller persists state only after a successful claim, under its scope lock. */
export function selectQueue(
  available: readonly string[],
  state: { lastQueue: string; consecutive: number } | null,
  policy: QueuePolicy,
): string | null {
  if (available.includes(policy.primary)) {
    if (
      available.includes(policy.secondary) &&
      state?.lastQueue === policy.primary &&
      state.consecutive >= policy.primaryWeight
    )
      return policy.secondary;
    return policy.primary;
  }
  if (available.includes(policy.secondary)) return policy.secondary;
  return available[0] ?? null;
}
