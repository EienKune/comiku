import { expect, test } from "vitest";
import type { EditableTranslationImage } from "../draft-storage";
import {
  checkPunctuation,
  checkTranslationPunctuation,
  isPunctuationResultCurrent,
} from "./check-punctuation";

test("reports fullwidth questions and exclamations as separate definite fixes with UTF-16 offsets", () => {
  const issues = checkPunctuation("😀老师！真的？");
  expect(
    issues.map(({ start, end, replacements, severity }) => ({
      start,
      end,
      replacements,
      severity,
    })),
  ).toEqual([
    { start: 4, end: 5, replacements: ["!"], severity: "format" },
    { start: 7, end: 8, replacements: ["?"], severity: "format" },
  ]);
  expect(checkPunctuation("老师!真的?")).toEqual([]);
});

test("reports each Chinese dot run once, keeps both allowed ellipsis lengths, and leaves sentence context to the reviewer", () => {
  for (const dots of ["..", "...", "....", ".....", "．．．", "。。"]) {
    const issues = checkPunctuation(`等等${dots}`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: "dot-ellipsis",
      start: 2,
      end: 2 + dots.length,
      severity: "confirm",
    });
    expect(new Set(issues[0].replacements)).toEqual(new Set(["…", "……"]));
  }
  expect(
    checkPunctuation("老师.\n真的. ”").map((issue) => issue.ruleId),
  ).toEqual(["chinese-sentence-period", "chinese-sentence-period"]);
  expect(
    checkPunctuation("… …… 老、老师… 「老师」 『某书』\n地球\n得到\n的确"),
  ).toEqual([]);
});

test.each([
  "https://example.com/a.png",
  "test@example.com",
  "image.png",
  "3.14",
  "v1.2.3",
  "Wait.",
  "FOXY...",
  "don't",
  "原文保留 FOXY...",
  "https://例子.测试/老师...",
  "C:\\资料\\老师.",
  "/资料/老师...",
  "你好.png",
  "老师.下一句尚待确认",
])("does not rewrite protected punctuation in %s", (text) => {
  expect(checkPunctuation(text)).toEqual([]);
});

function images(): EditableTranslationImage[] {
  return [0, 1].map((orderIndex) => ({
    id: `image:${orderIndex}`,
    orderIndex,
    width: 100,
    height: 100,
    translationRevision: 4,
    entries: [
      {
        id: orderIndex ? "local:pending" : "saved",
        workImageId: `image:${orderIndex}`,
        orderIndex: 0,
        markerX: 0.5,
        markerY: 0.5,
        markerPositionType: "inside",
        translatedText: orderIndex ? "本地草稿？" : "老师！",
        note: "不应检查的备注！",
        revision: 2,
        createdById: "user",
        updatedById: "user",
        createdAt: "2026-11-18T00:00:00Z",
        updatedAt: "2026-11-18T00:00:00Z",
        ...(orderIndex ? { localOnly: true } : {}),
      },
    ],
  }));
}

test("scans all parsed image drafts, preserves temporary identities, and rejects changed text, revision, epoch, work or deletion", () => {
  const scope = { workId: "work", editorEpoch: 3, latestVersionId: "version" };
  const drafts = images();
  const results = checkTranslationPunctuation(scope, drafts);
  expect(results).toHaveLength(2);
  expect(results[1]).toMatchObject({
    imageId: "image:1",
    entryId: "local:pending",
    imageNumber: 2,
    entryNumber: 1,
    start: 4,
  });
  expect(isPunctuationResultCurrent(results[1], scope, drafts)).toBe(true);
  for (const changed of [
    { ...scope, workId: "other" },
    { ...scope, editorEpoch: 4 },
    { ...scope, latestVersionId: "new" },
  ])
    expect(isPunctuationResultCurrent(results[1], changed, drafts)).toBe(false);
  for (const change of [
    { translatedText: "已修改？" },
    { revision: 3 },
    { orderIndex: 2 },
  ]) {
    const changed = images();
    Object.assign(changed[1].entries[0], change);
    expect(isPunctuationResultCurrent(results[1], scope, changed)).toBe(false);
  }
  drafts[1].entries = [];
  expect(isPunctuationResultCurrent(results[1], scope, drafts)).toBe(false);
});

test("handles a maximum-length synthetic label with many adjacent dot runs and preserves result order", () => {
  const text = "汉..".repeat(30_000) + "？老师.";
  const issues = checkPunctuation(text);
  expect(issues).toHaveLength(30_002);
  expect(issues[0]).toMatchObject({ ruleId: "dot-ellipsis", start: 1, end: 3 });
  expect(issues[29_999]).toMatchObject({
    ruleId: "dot-ellipsis",
    start: 89_998,
    end: 90_000,
  });
  expect(issues[30_000]).toMatchObject({
    ruleId: "halfwidth-question-exclamation",
    start: 90_000,
  });
  expect(issues[30_001]).toMatchObject({
    ruleId: "chinese-sentence-period",
    start: 90_003,
  });
});
