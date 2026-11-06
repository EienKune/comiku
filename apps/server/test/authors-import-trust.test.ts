import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorsService } from "../src/authors/authors.service.js";
import {
  parseAuthorImportCsv,
  AUTHOR_IMPORT_TEMPLATE,
} from "../src/authors/author-import.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
test("CSV numeric X IDs cannot bypass trusted identity lookup and enable collection", async () => {
  let created = 0;
  const db = {
    authorExternalAccount: {
      findMany: async () => [],
      create: async () => {
        created++;
      },
    },
    author: { create: async () => ({ id: "author" }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const args = [
    db,
    new ContentSourceRegistry(),
    {},
    {},
    {},
  ] as unknown as ConstructorParameters<typeof AuthorsService>;
  const service = new AuthorsService(...args);
  const rows = parseAuthorImportCsv(
    Buffer.from(
      AUTHOR_IMPORT_TEMPLATE + "Artist,ja,authorized,,artist,42,,\r\n",
    ),
  );
  await assert.rejects(service.importAuthors("actor", rows));
  assert.equal(created, 0);
});
