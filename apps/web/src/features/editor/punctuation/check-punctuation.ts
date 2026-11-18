import type { EditableTranslationImage } from "../draft-storage";

export type PunctuationRuleId =
  "halfwidth-question-exclamation" | "dot-ellipsis" | "chinese-sentence-period";

export interface PunctuationIssue {
  ruleId: PunctuationRuleId;
  severity: "format" | "confirm";
  /** Textarea selection offsets are UTF-16 code units, including emoji. */
  start: number;
  end: number;
  explanation: string;
  replacements: string[];
}

function followsChinese(text: string, offset: number) {
  return /\p{Script=Han}$/u.test(text.slice(Math.max(0, offset - 2), offset));
}

function isSentenceEnd(text: string, offset: number) {
  for (let index = offset; index < text.length; index++) {
    const char = text[index];
    if (char === "\n" || char === "\r") return true;
    if (!/[\s”’」』）)\]】]/u.test(char)) return false;
  }
  return true;
}

/** Check translatedText only. Context-dependent typography remains manual. */
export function checkPunctuation(text: string): PunctuationIssue[] {
  const issues: PunctuationIssue[] = [];
  // Advance once through whitespace-delimited tokens. Classifying the entire
  // remaining prefix for each dot run is quadratic on a long translated label.
  const tokens = text.matchAll(/\S+/gu);
  let token = tokens.next().value;
  let protectedToken = Boolean(
    token && /(?:https?:|www\.|@|[/\\])/iu.test(token[0]),
  );
  for (const match of text.matchAll(/[？！]|[.．。]+/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0] === "？" || match[0] === "！") {
      issues.push({
        ruleId: "halfwidth-question-exclamation",
        severity: "format",
        start,
        end,
        explanation: "组规要求中文译文的问号、感叹号使用半角 ? 和 !。",
        replacements: [match[0] === "？" ? "?" : "!"],
      });
      continue;
    }
    while (token && token.index + token[0].length <= start) {
      token = tokens.next().value;
      // URLs, mail addresses and paths can contain Chinese filenames too.
      protectedToken = Boolean(
        token && /(?:https?:|www\.|@|[/\\])/iu.test(token[0]),
      );
    }
    if (!followsChinese(text, start) || protectedToken) continue;
    if (match[0].length >= 2) {
      issues.push({
        ruleId: "dot-ellipsis",
        severity: "confirm",
        start,
        end,
        explanation:
          "疑似用点号模拟省略号；中文省略号允许 … 或 ……，请按语境选择。",
        replacements: match[0].length >= 4 ? ["……", "…"] : ["…", "……"],
      });
    } else if (match[0] === "." && isSentenceEnd(text, end)) {
      issues.push({
        ruleId: "chinese-sentence-period",
        severity: "confirm",
        start,
        end,
        explanation:
          "疑似中文句末 ASCII 句点；中文句号使用 。请先确认是否为保留内容。",
        replacements: ["。"],
      });
    }
  }
  return issues;
}

export interface PunctuationScope {
  workId: string;
  editorEpoch: number;
  latestVersionId: string | null;
}

export interface PunctuationResult extends PunctuationIssue, PunctuationScope {
  imageId: string;
  entryId: string;
  imageNumber: number;
  entryNumber: number;
  revision: number;
  text: string;
}

export function checkTranslationPunctuation(
  scope: PunctuationScope,
  images: EditableTranslationImage[],
): PunctuationResult[] {
  return images.flatMap((image) =>
    image.entries.flatMap((entry) =>
      checkPunctuation(entry.translatedText).map((issue) => ({
        ...scope,
        ...issue,
        imageId: image.id,
        entryId: entry.id,
        imageNumber: image.orderIndex + 1,
        entryNumber: entry.orderIndex + 1,
        revision: entry.revision,
        text: entry.translatedText,
      })),
    ),
  );
}

export function isPunctuationResultCurrent(
  result: PunctuationResult,
  scope: PunctuationScope,
  images: EditableTranslationImage[],
) {
  if (
    result.workId !== scope.workId ||
    result.editorEpoch !== scope.editorEpoch ||
    result.latestVersionId !== scope.latestVersionId
  )
    return false;
  const image = images.find((image) => image.id === result.imageId);
  if (!image || image.orderIndex + 1 !== result.imageNumber) return false;
  const entry = image.entries.find((item) => item.id === result.entryId);
  return Boolean(
    entry &&
    entry.orderIndex + 1 === result.entryNumber &&
    entry.revision === result.revision &&
    entry.translatedText === result.text,
  );
}
