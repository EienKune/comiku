import type { EditableTranslationImage } from "../draft-storage";

export type PunctuationRuleId =
  | "halfwidth-question-exclamation"
  | "dot-ellipsis"
  | "chinese-sentence-period"
  | "chinese-comma"
  | "pause-comma"
  | "ascii-double-quotes"
  | "ascii-colon"
  | "mixed-spacing";

export interface PunctuationIssue {
  ruleId: PunctuationRuleId;
  severity: "format" | "confirm";
  /** Textarea selection offsets are UTF-16 code units, including emoji. */
  start: number;
  end: number;
  explanation: string;
  replacements: string[];
}

const han = /\p{Script=Han}/u;
const beforeSentenceMark = /[\s”’」』）)\]】》〉"]/u;
const afterSentenceMark = /[\s“‘「『（([【《〈"]/u;
const protectedText = /(?:https?:|www\.|@|[/\\]|^`)/iu;

function hanBefore(line: string, offset: number) {
  return /\p{Script=Han}$/u.test(line.slice(Math.max(0, offset - 2), offset));
}

function hanAfter(line: string, offset: number) {
  return /^\p{Script=Han}/u.test(line.slice(offset, offset + 2));
}

function checkLine(line: string, offset: number, issues: PunctuationIssue[]) {
  const hasHan = han.test(line);
  const hasPhrasePunctuation = /[，,、。…;；?!？！]/u.test(line);
  const standaloneDots = /^\s*[.．。]{2,}\s*$/u.test(line);
  // Chinese punctuation can delimit a link or path from the surrounding prose.
  // Walk the tokens once so long labels do not repeatedly scan the same prefix.
  const tokens = line.matchAll(
    /`[^`]*`|[^\s，。！？、､；：【】《》“”‘’「」『』"`]+/gu,
  );
  let token = tokens.next().value;
  let protectedToken = Boolean(token && protectedText.test(token[0]));
  let openingQuote: number | undefined;
  function add(
    ruleId: PunctuationRuleId,
    start: number,
    end: number,
    explanation: string,
    replacements: string[],
    severity: PunctuationIssue["severity"] = "confirm",
  ) {
    issues.push({
      ruleId,
      start: offset + start,
      end: offset + end,
      explanation,
      replacements,
      severity,
    });
  }

  for (const match of line.matchAll(/[？！,､、:"]|[.．。]+| +/gu)) {
    const start = match.index;
    const mark = match[0];
    const end = start + mark.length;
    while (token && token.index + token[0].length <= start) {
      token = tokens.next().value;
      protectedToken = Boolean(token && protectedText.test(token[0]));
    }
    if (token && token.index <= start && protectedToken) continue;
    if (mark === "？" || mark === "！") {
      add(
        "halfwidth-question-exclamation",
        start,
        end,
        "组规要求中文译文的问号、感叹号使用半角 ? 和 !。",
        [mark === "？" ? "?" : "!"],
        "format",
      );
      continue;
    }
    if (!hasHan && !standaloneDots) continue;

    if (mark === '"') {
      if (line[start - 1] === "\\") continue;
      if (openingQuote === undefined) {
        openingQuote = start;
      } else {
        const quoted = line.slice(openingQuote + 1, start);
        if (han.test(quoted) && !protectedText.test(quoted)) {
          add(
            "ascii-double-quotes",
            openingQuote,
            end,
            "中文引文可使用成对的全角引号。请保留需要照录的原文格式。",
            [`“${quoted}”`],
          );
        }
        openingQuote = undefined;
      }
      continue;
    }

    const left = hanBefore(line, start);
    const right = hanAfter(line, end);
    if (mark === "," || mark === "､") {
      if (left || right)
        add("chinese-comma", start, end, "中文句子中的逗号通常使用全角 ，。", [
          "，",
        ]);
    } else if (mark === "、") {
      if (left && right) {
        const repeated =
          line.codePointAt(
            start - (/[\uDC00-\uDFFF]/u.test(line[start - 1]) ? 2 : 1),
          ) === line.codePointAt(end);
        add(
          "pause-comma",
          start,
          end,
          repeated
            ? "重复字之间的顿号可表示结巴。按语气选择省略号、逗号或保留顿号。"
            : "若是从日文保留的逗号，可改为中文逗号。并列或有意停顿可以保留顿号。",
          repeated ? ["…", "，"] : ["，"],
        );
      }
    } else if (mark === ":") {
      if ((left || right) && line[end] && !/\s/u.test(line[end]))
        add(
          "ascii-colon",
          start,
          end,
          "竖排可以使用半角冒号。横排请使用全角冒号或半角冒号加空格。",
          ["：", ": "],
        );
    } else if (mark[0] === " ") {
      if (left && right && hasPhrasePunctuation)
        add(
          "mixed-spacing",
          start,
          end,
          "同一行同时用了空格和标点断句。若此处需要统一，可使用逗号；有意留白可以保留。",
          ["，"],
        );
    } else if (mark !== "。") {
      let preceding = start;
      let following = end;
      while (preceding > 0 && beforeSentenceMark.test(line[preceding - 1]))
        preceding--;
      while (following < line.length && afterSentenceMark.test(line[following]))
        following++;
      const afterHan =
        hanBefore(line, preceding) && !/^[a-z0-9]/iu.test(line[end] ?? "");
      if (
        mark.length >= 2 &&
        (standaloneDots ||
          afterHan ||
          (!preceding && hanAfter(line, following)))
      ) {
        add(
          "dot-ellipsis",
          start,
          end,
          "疑似用点号模拟省略号。中文省略号可用 … 或 ……，请按语气选择。",
          mark.length >= 4 ? ["……", "…"] : ["…", "……"],
        );
      } else if (
        mark.length === 1 &&
        afterHan &&
        (following === line.length ||
          hanAfter(line, following) ||
          beforeSentenceMark.test(line[end]))
      ) {
        add(
          "chinese-sentence-period",
          start,
          end,
          "疑似用点号代替中文句号。请先确认是否为保留内容。",
          ["。"],
        );
      }
    }
  }
}

/** Check translatedText only. Context-dependent typography remains manual. */
export function checkPunctuation(text: string): PunctuationIssue[] {
  const issues: PunctuationIssue[] = [];
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    checkLine(line[0], line.index, issues);
  }
  // Paired quotes are reported when their closing character is seen.
  issues.sort((left, right) => left.start - right.start);
  return issues;
}

export interface PunctuationResult extends PunctuationIssue {
  imageNumber: number;
  entryNumber: number;
  text: string;
}

export function checkTranslationPunctuation(
  images: readonly EditableTranslationImage[],
): PunctuationResult[] {
  return images.flatMap((image) =>
    image.entries.flatMap((entry) =>
      checkPunctuation(entry.translatedText).map((issue) => ({
        ...issue,
        imageNumber: image.orderIndex + 1,
        entryNumber: entry.orderIndex + 1,
        text: entry.translatedText,
      })),
    ),
  );
}
