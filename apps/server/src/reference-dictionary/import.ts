import { createReadStream } from "node:fs";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  DictionaryImportError,
  DICTIONARY_INPUT_MAX_BYTES,
  validateDictionaryImport,
  type DictionaryImport,
} from "./import-validation.js";
import { normalizeSearchKey } from "./normalization.js";

export interface DictionaryImportResult {
  status: "imported" | "unchanged";
  revision: number;
  entries: number;
}

/** A zero revision means the source must not yet exist. No business tables are touched. */
export async function importReferenceDictionary(
  db: Pick<PrismaClient, "$transaction">,
  input: unknown,
  expectedRevision: number,
): Promise<DictionaryImportResult> {
  const data = validateDictionaryImport(input);
  if (
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= 2147483647
  )
    throw new DictionaryImportError("Invalid expected revision");
  return db.$transaction(
    async (tx) => {
      // Key-derived locks also serialize the first import, when no row exists to lock.
      // A hash collision only serializes independent imports; it cannot lose data.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`reference-dictionary:${data.source.key}`}, 0))`;
      const current = await tx.onomatopoeiaSource.findUnique({
        where: { key: data.source.key },
      });
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new DictionaryImportError(
          "Dictionary source revision conflict; inspect current source revision before retrying",
        );
      if (
        current &&
        current.fileSha256 === data.source.fileSha256 &&
        current.importerVersion === data.source.importerVersion
      )
        return {
          status: "unchanged",
          revision: current.revision,
          entries: data.entries.length,
        };
      const source = current
        ? await tx.onomatopoeiaSource.update({
            where: { id: current.id },
            data: {
              ...data.source,
              revision: { increment: 1 },
              importedAt: new Date(),
            },
          })
        : await tx.onomatopoeiaSource.create({ data: data.source });
      if (current)
        await tx.onomatopoeiaEntry.deleteMany({
          where: { sourceId: source.id },
        });
      for (let index = 0; index < data.entries.length; index += 500) {
        await tx.onomatopoeiaEntry.createMany({
          data: data.entries.slice(index, index + 500).map((entry) => ({
            ...entry,
            sourceId: source.id,
            searchKey: normalizeSearchKey(entry.original),
          })),
        });
      }
      return {
        status: "imported",
        revision: source.revision,
        entries: data.entries.length,
      };
    },
    { timeout: 30000, maxWait: 5000 },
  );
}

export async function readDictionaryImport(
  file: string,
): Promise<DictionaryImport> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > DICTIONARY_INPUT_MAX_BYTES)
      throw new DictionaryImportError("Dictionary input exceeds 32 MiB");
    chunks.push(buffer);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, bytes),
  );
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new DictionaryImportError(
      "Dictionary input must be valid UTF-8 JSON",
    );
  }
  return validateDictionaryImport(value);
}

export function parseDictionaryImportArgs(args: string[]): {
  file: string;
  apply: boolean;
  expectedRevision: number | undefined;
} {
  let file: string | undefined,
    apply = false,
    expectedRevision: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--apply" && !apply) apply = true;
    else if (arg === "--expected-revision" && expectedRevision === undefined) {
      const value = args[++index];
      if (
        !value ||
        !/^\d+$/.test(value) ||
        !Number.isInteger(Number(value)) ||
        Number(value) >= 2147483647
      )
        throw new DictionaryImportError("Invalid expected revision");
      expectedRevision = Number(value);
    } else if (!arg.startsWith("-") && !file) file = arg;
    else
      throw new DictionaryImportError(
        "Usage: import-reference-dictionary <input.json> [--apply --expected-revision N]",
      );
  }
  if (!file || (apply && expectedRevision === undefined))
    throw new DictionaryImportError(
      "Usage: import-reference-dictionary <input.json> [--apply --expected-revision N]; use revision 0 for a new source",
    );
  return { file, apply, expectedRevision };
}
