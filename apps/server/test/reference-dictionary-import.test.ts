import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importReferenceDictionary,
  parseDictionaryImportArgs,
  readDictionaryImport,
} from "../src/reference-dictionary/import.js";
import type { PrismaService } from "../src/database/prisma.service.js";

function snapshot(importerVersion = "test-v1") {
  return {
    formatVersion: 1,
    source: {
      key: "synthetic",
      name: "Synthetic",
      version: "1",
      fileSha256: "a".repeat(64),
      importerVersion,
    },
    entries: [
      {
        sourceRef: "line:1",
        original: "ガクッ",
        explanationZh: "合成释义\n第二行",
      },
    ],
  };
}
function memorySource(
  current: {
    id: string;
    revision: number;
    fileSha256: string;
    importerVersion: string;
  } | null,
) {
  let deletes = 0;
  const inserted: unknown[] = [];
  let locks = 0;
  const tx = {
    $queryRaw: async () => {
      locks++;
      return [{ value: 1 }];
    },
    onomatopoeiaSource: {
      findUnique: async () => current,
      create: async () => ({ id: "new", revision: 1 }),
      update: async () => ({
        id: current!.id,
        revision: current!.revision + 1,
      }),
    },
    onomatopoeiaEntry: {
      deleteMany: async () => {
        deletes++;
      },
      createMany: async ({ data }: { data: unknown[] }) => {
        inserted.push(...data);
      },
    },
  };
  return {
    db: {
      $transaction: async (operation: (tx: unknown) => unknown) =>
        operation(tx),
    } as unknown as PrismaService,
    stats: () => ({ deletes, inserted, locks }),
  };
}
test("import validates the entire replacement and revision before any mutation", async () => {
  const state = memorySource({
    id: "old",
    revision: 2,
    fileSha256: "a".repeat(64),
    importerVersion: "test-v1",
  });
  const malformed = snapshot();
  malformed.entries.push({
    sourceRef: "line:1",
    original: "duplicate",
    explanationZh: "bad",
  });
  await assert.rejects(
    importReferenceDictionary(state.db, malformed, 2),
    /Duplicate/,
  );
  assert.equal(state.stats().locks, 0);
  await assert.rejects(
    importReferenceDictionary(state.db, snapshot(), 1),
    /revision/i,
  );
  assert.equal(state.stats().deletes, 0);
});
test("same SHA and parser is unchanged but parser upgrades replace with a new revision", async () => {
  const state = memorySource({
    id: "old",
    revision: 2,
    fileSha256: "a".repeat(64),
    importerVersion: "test-v1",
  });
  assert.deepEqual(await importReferenceDictionary(state.db, snapshot(), 2), {
    status: "unchanged",
    revision: 2,
    entries: 1,
  });
  assert.equal(state.stats().deletes, 0);
  assert.deepEqual(
    await importReferenceDictionary(state.db, snapshot("test-v2"), 2),
    { status: "imported", revision: 3, entries: 1 },
  );
  assert.equal(state.stats().deletes, 1);
  assert.equal(
    (state.stats().inserted[0] as { searchKey: string }).searchKey,
    "がくっ",
  );
});
test("a new source only accepts expected revision zero", async () => {
  const state = memorySource(null);
  await assert.rejects(
    importReferenceDictionary(state.db, snapshot(), 1),
    /revision/i,
  );
  assert.deepEqual(await importReferenceDictionary(state.db, snapshot(), 0), {
    status: "imported",
    revision: 1,
    entries: 1,
  });
  assert.equal(state.stats().deletes, 0);
});
test("CLI defaults to validation only and apply requires an explicit bounded expected revision", () => {
  assert.deepEqual(parseDictionaryImportArgs(["synthetic.json"]), {
    file: "synthetic.json",
    apply: false,
    expectedRevision: undefined,
  });
  assert.deepEqual(
    parseDictionaryImportArgs([
      "synthetic.json",
      "--apply",
      "--expected-revision",
      "0",
    ]),
    { file: "synthetic.json", apply: true, expectedRevision: 0 },
  );
  for (const args of [
    [],
    ["a", "--apply"],
    ["a", "--unknown"],
    ["a", "b"],
    ["a", "--expected-revision", "-1"],
    ["a", "--expected-revision", "1.5"],
    ["a", "--apply", "--apply"],
  ])
    assert.throws(() => parseDictionaryImportArgs(args));
});
test("import reader accepts optional BOM and rejects oversize input and malformed UTF8", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comiku-reference-"));
  const path = join(dir, "synthetic.json");
  try {
    await writeFile(path, `\ufeff${JSON.stringify(snapshot())}`);
    assert.equal((await readDictionaryImport(path)).entries.length, 1);
    await writeFile(path, Buffer.alloc(32 * 1024 * 1024 + 1, 32));
    await assert.rejects(readDictionaryImport(path), /32 MiB/);
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(readDictionaryImport(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
