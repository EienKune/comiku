import { expect, test } from "vitest";
import type { EditableTranslationImage } from "../draft-storage";
import {
  checkPunctuation,
  checkTranslationPunctuation,
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
  expect(checkPunctuation("… …… 「老师」 『某书』\n地球\n得到\n的确")).toEqual(
    [],
  );
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
  "检查 https://例子.测试/老师... 和 中文.png",
  '保留原文 "Hello, world." 供参考',
  '命令 `代码 "中文", 参数:值？`',
  "价格12:30前为3,000元，版本v1.2.3。",
  "老师: 继续。\n老 师\n「老师」『老师』“老师”",
])("does not rewrite protected punctuation in %s", (text) => {
  expect(checkPunctuation(text)).toEqual([]);
});

test("reports halfwidth commas and distinguishes pauses, stutters and lists", () => {
  const issues = checkPunctuation("准备好,开始。然后､再看。老、老师，甲、乙。");
  expect(
    issues.map(({ ruleId, severity, replacements }) => ({
      ruleId,
      severity,
      replacements,
    })),
  ).toEqual([
    { ruleId: "chinese-comma", severity: "confirm", replacements: ["，"] },
    { ruleId: "chinese-comma", severity: "confirm", replacements: ["，"] },
    { ruleId: "pause-comma", severity: "confirm", replacements: ["…", "，"] },
    { ruleId: "pause-comma", severity: "confirm", replacements: ["，"] },
  ]);
});

test("groups a pair of straight double quotes without changing the inner text or offsets", () => {
  const text = '第一行\r\n😀她说"𠮷老师？"。';
  const issues = checkPunctuation(text);
  expect(issues.map(({ ruleId }) => ruleId)).toEqual([
    "ascii-double-quotes",
    "halfwidth-question-exclamation",
  ]);
  expect(text.slice(issues[0].start, issues[0].end)).toBe('"𠮷老师？"');
  expect(issues[0].replacements).toEqual(["“𠮷老师？”"]);
  expect(checkPunctuation('她说"未闭合')).toEqual([]);
});

test("keeps quote pairing local when protected data contains or touches straight quotes", () => {
  const text = '她说"老师 https://example.com"，看 `未配对的"`，然后"中文"。';
  const issues = checkPunctuation(text);
  expect(issues).toHaveLength(1);
  expect(text.slice(issues[0].start, issues[0].end)).toBe('"中文"');
  expect(issues[0].replacements).toEqual(["“中文”"]);
  expect(checkPunctuation('打开"C:\\资料\\老师.txt"')).toEqual([]);
});

test("reports ambiguous colon and spacing formats without treating the permitted formats as errors", () => {
  const issues = checkPunctuation(
    "备注:继续 保持。\n下一行: 可以这样。\n时间12:30。\n老 师",
  );
  expect(
    issues.map(({ ruleId, severity, replacements }) => ({
      ruleId,
      severity,
      replacements,
    })),
  ).toEqual([
    { ruleId: "ascii-colon", severity: "confirm", replacements: ["：", ": "] },
    { ruleId: "mixed-spacing", severity: "confirm", replacements: ["，"] },
  ]);
});

test("reports dots at clause boundaries but leaves periods in filenames and English untouched", () => {
  const text =
    "...\n…老师\n「老师」.下一句\n老师 .\n老师．\n链接：https://例子.测试/老师.。老师...\n老师abc.png " +
    "你好.png 3.14 FOXY...";
  const issues = checkPunctuation(text);
  expect(issues.map(({ start, end }) => text.slice(start, end))).toEqual([
    "...",
    ".",
    ".",
    "．",
    "...",
  ]);
  expect(issues.map(({ ruleId }) => ruleId)).toEqual([
    "dot-ellipsis",
    "chinese-sentence-period",
    "chinese-sentence-period",
    "chinese-sentence-period",
    "dot-ellipsis",
  ]);
});

test.each([
  ["老师！", "半角问号 ? 和感叹号 !"],
  ["老师...", "… 或 ……"],
  ["老师.", "全角句号（。）"],
  ["你好,老师", "全角 ，"],
  ["老、老师", "省略号 … 或逗号 ，"],
  ["老师、你好", "中文逗号 ，"],
  ['她说"老师"', "“译文”"],
  ["备注:继续", "说明：内容 或 说明: 内容"],
  ["老师 你好。", "逗号 ，"],
])("shows a clear punctuation example when checking %s", (text, example) => {
  const issues = checkPunctuation(text);
  expect(issues).toHaveLength(1);
  expect(issues[0].explanation).toContain(example);
  expect(issues[0].explanation).not.toMatch(/。$/u);
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

test("checks translated text on every page and preserves page and marker numbering", () => {
  const results = checkTranslationPunctuation(images());
  expect(results).toHaveLength(2);
  expect(results[1]).toMatchObject({
    imageNumber: 2,
    entryNumber: 1,
    start: 4,
    text: "本地草稿？",
  });
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
