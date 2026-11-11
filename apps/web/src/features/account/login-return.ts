const returnOrigin = "https://comiku.invalid";
const applicationPath =
  /^\/(?:works(?:\/[^/?#]+(?:\/editor)?)?|authors(?:\/[^/?#]+)?|reviews(?:\/[^/?#]+)?|candidates|members|audit|settings(?:\/(?:password|users|system))?)?$/;
const unsafeCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return character === "\\" || code <= 0x20 || code === 0x7f;
  });

/** Router history is untrusted input; only application paths may survive login. */
export function loginReturnTarget(state: unknown): string {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "/";
  const value = (state as { returnTo?: unknown }).returnTo;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    unsafeCharacters(value)
  )
    return "/";
  try {
    const url = new URL(value, returnOrigin);
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      url.origin !== returnOrigin ||
      unsafeCharacters(decodedPath) ||
      !applicationPath.test(decodedPath)
    )
      return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

export function loginReturnState(location: {
  pathname: string;
  search: string;
  hash: string;
}): { returnTo: string } {
  return {
    returnTo: loginReturnTarget({
      returnTo: location.pathname + location.search + location.hash,
    }),
  };
}
