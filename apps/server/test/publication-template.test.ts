import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeAuthorCredit,
  renderPublicationText,
} from "../src/publishing/publication-template.js";

const template = `**{{title}}**
{{body}}作者：{{author}}

翻译：{{translation_credits}}
校对：{{proofread_credits}}
嵌字：{{typeset_credits}}
点赞加关注可以看到更多汉化作品
转载请注明原作者`;

test("explicit exemption removes only the template credit row and preserves body text", () => {
  const text = renderPublicationText(template, {
    title: "免校",
    body: "校对：这行是正文，应保留",
    author: "作者",
    translationCredits: ["翻译"],
    proofreadCredits: [],
    typesetCredits: ["嵌字"],
    proofreadingSkipped: true,
  });
  assert.match(text, /校对：这行是正文，应保留/);
  assert.match(text, /翻译：翻译\n嵌字：嵌字/);
  assert.doesNotMatch(text, /\n校对：\n/);
  const normal = renderPublicationText(template, {
    title: "正常",
    body: null,
    author: "作者",
    translationCredits: ["翻译"],
    proofreadCredits: [],
    typesetCredits: ["嵌字"],
  });
  assert.match(normal, /\n校对：\n/);
});

test("renders the confirmed default copy without an empty body artifact", () => {
  const text = renderPublicationText(template, {
    title: "示例作品标题",
    body: null,
    author: normalizeAuthorCredit("@_demo_artist_", "示例作者"),
    translationCredits: ["示例翻译"],
    proofreadCredits: ["示例校对"],
    typesetCredits: ["示例嵌字"],
  });
  assert.equal(
    text,
    `**示例作品标题**
作者：@_demo_artist_

翻译：示例翻译
校对：示例校对
嵌字：示例嵌字
点赞加关注可以看到更多汉化作品
转载请注明原作者`,
  );
});

test("includes body text and joins collaborative credits in submission order", () => {
  const text = renderPublicationText(template, {
    title: "标题",
    body: "第一行\n第二行",
    author: normalizeAuthorCredit("artist", "作者"),
    translationCredits: ["A", "B"],
    proofreadCredits: ["C"],
    typesetCredits: ["D", "E"],
  });
  assert.match(text, /^\*\*标题\*\*\n第一行\n第二行\n作者：@artist/);
  assert.match(text, /翻译：A、B/);
  assert.match(text, /嵌字：D、E/);
  assert.equal(normalizeAuthorCredit(null, "作者名"), "作者名");
});
