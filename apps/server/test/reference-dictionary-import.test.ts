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
import { validateDictionaryImport } from "../src/reference-dictionary/import-validation.js";
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
const importedAt = new Date("2026-11-17T00:00:00Z");
const baseline = {
  ...validateDictionaryImport(snapshot()).source,
  id: "old",
  revision: 2,
  importedAt,
};
function memorySource(current: typeof baseline | null) {
  let deletes = 0;
  let updates = 0;
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
      update: async ({
        data: { revision, ...data },
      }: {
        data: Partial<Omit<typeof baseline, "revision">> & {
          revision: { increment: number };
        };
      }) => {
        updates++;
        current = {
          ...current!,
          ...data,
          revision: current!.revision + revision.increment,
        };
        return current;
      },
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
    source: () => current,
    stats: () => ({ deletes, inserted, locks, updates }),
  };
}
test("import validates the entire replacement and revision before any mutation", async () => {
  const state = memorySource(baseline);
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
  const state = memorySource(baseline);
  assert.deepEqual(await importReferenceDictionary(state.db, snapshot(), 2), {
    status: "unchanged",
    revision: 2,
    entries: 1,
  });
  assert.equal(state.stats().deletes, 0);
  assert.equal(state.stats().updates, 0);
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
test("metadata-only import persists name and version, keeps entries and their import time, and honors revisions", async () => {
  const state = memorySource(baseline);
  const input = snapshot();
  input.source.name = "Corrected source";
  input.source.version = "2026 edition";
  assert.deepEqual(await importReferenceDictionary(state.db, input, 2), {
    status: "imported",
    revision: 3,
    entries: 1,
  });
  assert.equal(state.source()?.name, input.source.name);
  assert.equal(state.source()?.version, input.source.version);
  assert.equal(state.source()?.importedAt, importedAt);
  assert.equal(state.stats().deletes, 0);
  assert.deepEqual(state.stats().inserted, []);
  assert.equal(state.stats().updates, 1);
  assert.equal(
    (await importReferenceDictionary(state.db, input, 3)).status,
    "unchanged",
  );
  const beforeConflict = state.source();
  input.source.name = "Stale client's version";
  await assert.rejects(
    importReferenceDictionary(state.db, input, 2),
    /revision/,
  );
  assert.equal(state.source(), beforeConflict);
  assert.equal(state.stats().updates, 1);
  assert.equal(state.stats().deletes, 0);
});

for (const [field, values] of [
  [
    "sourceUrl",
    [" https://example.com/original ", "https://example.com/corrected"],
  ],
  ["attribution", [" Original attribution ", "Corrected attribution"]],
  ["license", [" Original license ", "Corrected license"]],
] as const) {
  test(`metadata-only import sets, updates and clears normalized ${field}`, async () => {
    const state = memorySource(baseline);
    let revision = 2;
    for (const value of [...values, null]) {
      const input = snapshot();
      assert.equal(
        (
          await importReferenceDictionary(
            state.db,
            { ...input, source: { ...input.source, [field]: value } },
            revision,
          )
        ).revision,
        ++revision,
      );
      assert.equal(state.source()?.[field], value);
    }
    assert.equal(
      (await importReferenceDictionary(state.db, snapshot(), revision)).status,
      "unchanged",
    );
    assert.equal(state.stats().deletes, 0);
    assert.deepEqual(state.stats().inserted, []);
  });
}

test("a changed source SHA replaces entries even if the parser version is unchanged", async () => {
  const state = memorySource(baseline);
  const input = snapshot();
  input.source.fileSha256 = "b".repeat(64);
  await importReferenceDictionary(state.db, input, 2);
  assert.equal(state.source()?.fileSha256, input.source.fileSha256);
  assert.equal(state.stats().deletes, 1);
  assert.equal(state.stats().inserted.length, 1);
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
