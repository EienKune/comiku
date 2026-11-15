export const ARCHIVE_TARGET_BYTES = 2n * 1024n ** 3n;
export const ARCHIVE_MAX_ENTRIES = 20_000;

export interface ArchiveEntry {
  path: string;
  size: bigint;
  sha256: string;
  sourceKey?: string;
  content?: string | Buffer;
  openContent?: (signal: AbortSignal) => Promise<Readable>;
}

/** Reject ambiguous names instead of silently changing LabelPlus references. */
export function validateArchivePath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path, "utf8") > 1024 ||
    path !== path.normalize("NFC") ||
    /[\uD800-\uDFFF]/u.test(path) ||
    /[\\<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(path) ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    }) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Invalid archive path");
  return path;
}

export function archiveEntryPath(
  year: number,
  month: number,
  workNumber: string | number,
  kind: "raw" | "rendered" | "manifest",
  fileName: string,
): string {
  if (
    !Number.isInteger(year) ||
    year < 1 ||
    year > 9999 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !/^[a-zA-Z0-9_-]+$/.test(String(workNumber)) ||
    fileName.includes("/")
  ) {
    throw new Error("Invalid archive location");
  }
  const directory =
    kind === "raw" ? "生肉" : kind === "rendered" ? "熟肉" : "manifest";
  return validateArchivePath(
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}/${workNumber}/${directory}/${fileName}`,
  );
}

/** Keep adjacent works intact when they fit, split oversized works only at files. */
export function planArchivePackages<T extends ArchiveEntry>(
  entries: readonly T[],
  targetBytes = ARCHIVE_TARGET_BYTES,
  maxEntries = ARCHIVE_MAX_ENTRIES,
): T[][] {
  if (
    targetBytes < 1n ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > ARCHIVE_MAX_ENTRIES
  ) {
    throw new Error("Invalid archive package limits");
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    validateArchivePath(entry.path);
    const canonical = entry.path.normalize("NFC").toLowerCase();
    if (
      seen.has(canonical) ||
      entry.size < 0n ||
      entry.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Invalid or duplicate archive entry");
    }
    seen.add(canonical);
  }
  const groups: T[][] = [];
  for (const entry of entries) {
    const work = entry.path.split("/").slice(0, 2).join("/");
    const last = groups.at(-1);
    if (last && last[0].path.split("/").slice(0, 2).join("/") === work)
      last.push(entry);
    else groups.push([entry]);
  }
  const packages: T[][] = [];
  let current: T[] = [];
  let bytes = 0n;
  const flush = () => {
    if (current.length) packages.push(current);
    current = [];
    bytes = 0n;
  };
  // Reserve conservative ZIP64 central/local/data-descriptor overhead per entry.
  const weight = (entry: T) =>
    entry.size + BigInt(256 + 2 * Buffer.byteLength(entry.path));
  for (const group of groups) {
    const groupBytes = group.reduce((sum, entry) => sum + weight(entry), 0n);
    if (
      current.length &&
      (bytes + groupBytes > targetBytes ||
        current.length + group.length > maxEntries)
    )
      flush();
    for (const entry of group) {
      if (
        current.length &&
        (bytes + weight(entry) > targetBytes || current.length >= maxEntries)
      )
        flush();
      current.push(entry);
      bytes += weight(entry);
    }
  }
  flush();
  return packages;
}
import type { Readable } from "node:stream";
