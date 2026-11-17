import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReferenceQuery,
  normalizeSearchKey,
  escapeLike,
} from "../src/reference-dictionary/normalization.js";
import { validateDictionaryImport } from "../src/reference-dictionary/import-validation.js";
import {
  ReferenceDictionaryService,
  referenceSearchQuery,
} from "../src/reference-dictionary/reference-dictionary.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import { ACCESS } from "../src/common/access.js";
import { ReferenceDictionaryController } from "../src/reference-dictionary/reference-dictionary.controller.js";

export function syntheticDictionary() {
  return {
    formatVersion: 1,
    source: {
      key: "synthetic",
      name: "Synthetic",
      version: "1",
      fileSha256: "a".repeat(64),
      importerVersion: "synthetic-v1",
    },
    entries: [
      {
        sourceRef: "Sheet1:B2",
        original: "カクッ",
        explanationJa: "第一行\n第二行",
        explanationZh: null,
      },
      { sourceRef: "Sheet1:B3", original: "カクッ", explanationJa: null },
    ],
  };
}
test("reference normalization keeps voiced marks, small kana, long vowels and repetitions", () => {
  assert.equal(normalizeSearchKey(" ｶﾞｸｯｰ "), "がくっー");
  assert.equal(normalizeSearchKey("カクッ"), "かくっ");
  for (const word of ["かく", "がくっ", "かくっー", "かくっかくっ"])
    assert.notEqual(normalizeSearchKey(word), normalizeSearchKey("カクッ"));
});
test("query validates Unicode point and pagination bounds and treats LIKE characters literally", () => {
  assert.deepEqual(normalizeReferenceQuery(undefined, undefined), {
    q: "",
    offset: 0,
  });
  assert.deepEqual(normalizeReferenceQuery("\t \n", 0), { q: "", offset: 0 });
  assert.equal(normalizeReferenceQuery("😀".repeat(80), "10000").offset, 10000);
  for (const q of ["😀".repeat(81), ["q"], "a\u0000"])
    assert.throws(() => normalizeReferenceQuery(q, "0"));
  for (const offset of ["-1", "10001", "1.1", "1e2", ["1"], ""])
    assert.throws(() => normalizeReferenceQuery("q", offset));
  assert.equal(escapeLike("a%_\\"), "a\\%\\_\\\\");
});
test("import preserves independent same-word records and null/multiline meanings", () => {
  const data = validateDictionaryImport(syntheticDictionary());
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0]?.explanationJa, "第一行\n第二行");
  assert.equal(data.entries[1]?.explanationJa, null);
  assert.equal(data.entries[0]?.translationZh, null);
});
test("import rejects malformed snapshots instead of dropping entries", () => {
  const fixtures: unknown[] = [];
  const duplicate = syntheticDictionary();
  duplicate.entries[1]!.sourceRef = duplicate.entries[0]!.sourceRef;
  fixtures.push(duplicate);
  for (const field of ["original", "sourceRef"]) {
    const data = syntheticDictionary();
    Object.assign(data.entries[0]!, { [field]: "bad\u0000" });
    fixtures.push(data);
  }
  for (const sourceUrl of [
    "file:///private/path",
    "javascript:alert(1)",
    "C:/private",
  ]) {
    const data = syntheticDictionary();
    Object.assign(data.source, { sourceUrl });
    fixtures.push(data);
  }
  for (const change of [
    { fileSha256: "A".repeat(64) },
    { key: "../private" },
    { importerVersion: "" },
    { privatePath: "secret" },
  ]) {
    const data = syntheticDictionary();
    Object.assign(data.source, change);
    fixtures.push(data);
  }
  const oversized = syntheticDictionary();
  oversized.entries[0]!.original = "あ".repeat(257);
  fixtures.push(oversized);
  fixtures.push({ ...syntheticDictionary(), entries: [] });
  fixtures.push({ ...syntheticDictionary(), privatePath: "secret" });
  for (const data of fixtures)
    assert.throws(() => validateDictionaryImport(data));
});
test("empty queries do not scan and pages only return twenty independent records", async () => {
  let reads = 0;
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: String(index),
    original: "カクッ",
    explanationZh: null,
    explanationJa: null,
    translationZh: null,
    notes: null,
    sourceRef: `line:${index}`,
    sourceKey: "synthetic",
    sourceName: "Synthetic",
    sourceVersion: "1",
    sourceUrl: null,
    attribution: null,
    license: null,
  }));
  const service = new ReferenceDictionaryService({
    $queryRaw: async () => {
      reads++;
      return rows;
    },
  } as unknown as PrismaService);
  assert.deepEqual(await service.search("  ", 0), {
    entries: [],
    nextOffset: null,
  });
  assert.equal(reads, 0);
  const page = await service.search("カクッ", 20);
  assert.equal(page.entries.length, 20);
  assert.equal(page.nextOffset, 40);
  assert.deepEqual(page.entries[0]?.source, {
    key: "synthetic",
    name: "Synthetic",
    version: "1",
    sourceUrl: null,
    attribution: null,
    license: null,
  });
  assert.equal("sourceKey" in page.entries[0]!, false);
});
test("search SQL parameterizes literal patterns and ranks exact original before normalized/substring", () => {
  const sql = referenceSearchQuery("カ%_", 20);
  assert.match(sql.text, /CASE/);
  assert.match(sql.text, /ESCAPE/);
  assert.equal(sql.text.includes("カ%_"), false);
  assert.ok(sql.values.includes("%か\\%\\_%"));
  assert.ok(sql.values.includes(21));
  assert.ok(sql.values.includes(20));
});
test("lookup uses the existing works read authorization boundary", () => {
  assert.deepEqual(
    Reflect.getMetadata(ACCESS, ReferenceDictionaryController.prototype.search),
    { permission: "works:read" },
  );
});
