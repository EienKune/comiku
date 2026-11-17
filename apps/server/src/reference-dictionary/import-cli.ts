import type { PrismaClient } from "../generated/prisma/client.js";
import {
  importReferenceDictionary,
  parseDictionaryImportArgs,
} from "./import.js";
import {
  DictionaryImportError,
  type DictionaryImport,
} from "./import-validation.js";

interface DictionaryImportCliDependencies {
  read(file: string): Promise<DictionaryImport>;
  connect(): Promise<Pick<PrismaClient, "$transaction" | "$disconnect">>;
  out(value: string): void;
  err(value: string): void;
}

export function formatDictionaryImportError(error: unknown): string {
  // COMMIT acknowledgement or cleanup can fail after a successful database commit.
  return error instanceof DictionaryImportError
    ? error.message
    : "Dictionary import outcome is unconfirmed; inspect the source revision before retrying with --expected-revision (CAS)";
}

/** Keep command output injectable and sanitized, including failures after the transaction resolves. */
export async function runDictionaryImportCli(
  args: string[],
  dependencies: DictionaryImportCliDependencies,
): Promise<0 | 1> {
  try {
    const options = parseDictionaryImportArgs(args);
    const input = await dependencies.read(options.file);
    if (!options.apply)
      dependencies.out(
        JSON.stringify({ status: "validated", entries: input.entries.length }),
      );
    else {
      const db = await dependencies.connect();
      try {
        dependencies.out(
          JSON.stringify(
            await importReferenceDictionary(
              db,
              input,
              options.expectedRevision!,
            ),
          ),
        );
      } finally {
        await db.$disconnect();
      }
    }
    return 0;
  } catch (error) {
    dependencies.err(formatDictionaryImportError(error));
    return 1;
  }
}
