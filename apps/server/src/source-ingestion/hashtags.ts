export interface NormalizedHashtag {
  displayValue: string;
  normalizedValue: string;
}

export function normalizeHashtag(value: string): NormalizedHashtag | null {
  const displayValue = value.normalize("NFKC").trim().replace(/^#+/, "");
  if (!displayValue || displayValue.length > 100 || /\s/u.test(displayValue)) {
    return null;
  }
  return { displayValue, normalizedValue: displayValue.toLocaleLowerCase() };
}

export function collectHashtags(
  structured: readonly string[],
  text?: string,
): NormalizedHashtag[] {
  const values = [...structured];
  for (const match of text?.matchAll(/#([\p{L}\p{N}_]{1,100})/gu) ?? []) {
    values.push(match[1]);
  }
  const unique = new Map<string, NormalizedHashtag>();
  for (const value of values) {
    const normalized = normalizeHashtag(value);
    if (normalized && !unique.has(normalized.normalizedValue)) {
      unique.set(normalized.normalizedValue, normalized);
    }
  }
  return [...unique.values()];
}
