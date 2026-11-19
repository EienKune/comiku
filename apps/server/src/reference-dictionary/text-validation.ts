/** Reject control characters and unpaired surrogates; retain real Unicode characters. */
export function hasInvalidTextCharacters(
  value: string,
  multiline = false,
): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      (code < 32 &&
        !(multiline && (code === 9 || code === 10 || code === 13))) ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return true;
  }
  return false;
}
