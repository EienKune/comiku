export const DICTIONARY_INPUT_MAX_BYTES = 32 * 1024 * 1024;
export class DictionaryImportError extends Error {}

export interface DictionaryImportSource {
  key: string;
  name: string;
  version: string;
  fileSha256: string;
  importerVersion: string;
  sourceUrl: string | null;
  attribution: string | null;
  license: string | null;
}
export interface DictionaryImportEntry {
  sourceRef: string;
  original: string;
  explanationZh: string | null;
  explanationJa: string | null;
  translationZh: string | null;
  notes: string | null;
}
export interface DictionaryImport {
  formatVersion: 1;
  source: DictionaryImportSource;
  entries: DictionaryImportEntry[];
}

function record(
  value: unknown,
  fields: string[],
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.includes(field))
  )
    throw new DictionaryImportError(`Invalid ${label} object`);
  return value as Record<string, unknown>;
}
function text(
  value: unknown,
  label: string,
  max: number,
  multiline = false,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value).length > max ||
    hasInvalidTextCharacters(value, multiline)
  )
    throw new DictionaryImportError(`Invalid ${label}`);
  return value;
}
function nullable(
  value: unknown,
  label: string,
  max = 16000,
  multiline = true,
): string | null {
  return value === undefined || value === null
    ? null
    : text(value, label, max, multiline);
}

/** Validate the complete snapshot before opening a database transaction. Never drops records. */
export function validateDictionaryImport(value: unknown): DictionaryImport {
  const input = record(value, ["formatVersion", "source", "entries"], "import");
  if (input.formatVersion !== 1)
    throw new DictionaryImportError("Unsupported dictionary formatVersion");
  const rawSource = record(
    input.source,
    [
      "key",
      "name",
      "version",
      "fileSha256",
      "importerVersion",
      "sourceUrl",
      "attribution",
      "license",
    ],
    "source",
  );
  const source: DictionaryImportSource = {
    key: text(rawSource.key, "source key", 64),
    name: text(rawSource.name, "source name", 160),
    version: text(rawSource.version, "source version", 160),
    fileSha256: text(rawSource.fileSha256, "source SHA256", 64),
    importerVersion: text(rawSource.importerVersion, "importer version", 160),
    sourceUrl: nullable(rawSource.sourceUrl, "source URL", 2048, false),
    attribution: nullable(rawSource.attribution, "source attribution"),
    license: nullable(rawSource.license, "source license"),
  };
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.key))
    throw new DictionaryImportError("Invalid source key");
  if (!/^[a-f0-9]{64}$/.test(source.fileSha256))
    throw new DictionaryImportError("Invalid source SHA256");
  if (source.sourceUrl) {
    let url: URL;
    try {
      url = new URL(source.sourceUrl);
    } catch {
      throw new DictionaryImportError("Invalid source URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new DictionaryImportError("Invalid source URL");
  }
  if (
    !Array.isArray(input.entries) ||
    input.entries.length < 1 ||
    input.entries.length > 50000
  )
    throw new DictionaryImportError("Dictionary must contain 1..50000 entries");
  const refs = new Set<string>();
  const entries = input.entries.map((value, index): DictionaryImportEntry => {
    const raw = record(
      value,
      [
        "sourceRef",
        "original",
        "explanationZh",
        "explanationJa",
        "translationZh",
        "notes",
      ],
      `entry ${index + 1}`,
    );
    const entry = {
      sourceRef: text(raw.sourceRef, `entry ${index + 1} sourceRef`, 160),
      original: text(raw.original, `entry ${index + 1} original`, 256),
      explanationZh: nullable(
        raw.explanationZh,
        `entry ${index + 1} explanationZh`,
      ),
      explanationJa: nullable(
        raw.explanationJa,
        `entry ${index + 1} explanationJa`,
      ),
      translationZh: nullable(
        raw.translationZh,
        `entry ${index + 1} translationZh`,
      ),
      notes: nullable(raw.notes, `entry ${index + 1} notes`),
    };
    if (refs.has(entry.sourceRef))
      throw new DictionaryImportError(
        `Duplicate sourceRef at entry ${index + 1}`,
      );
    refs.add(entry.sourceRef);
    return entry;
  });
  return { formatVersion: 1, source, entries };
}
import { hasInvalidTextCharacters } from "./text-validation.js";
