import { expect, test } from "vitest";
import {
  canHandleStage,
  readingTabs,
  workingTabs,
  workViewState,
} from "./work-views";
type Member = Parameters<typeof workingTabs>[0];
const member = (
  roles: Member["roles"],
  languageCapabilities: Member["languageCapabilities"] = [],
): Member => ({ roles, languageCapabilities });
test("work tabs follow actual roles regardless of task counts", () => {
  expect(
    workingTabs(member(["admin"], ["ja"])).map((tab) => tab.value),
  ).toEqual(["todo", "pending_publish"]);
  expect(workingTabs(member(["typesetter"])).map((tab) => tab.value)).toEqual([
    "todo",
    "translate",
    "typeset",
  ]);
  expect(
    workingTabs(
      member(
        ["translator", "proofreader", "typesetter", "operator"],
        ["ja", "ko"],
      ),
    ),
  ).toHaveLength(5);
  expect(workingTabs(member(["source"]))).toEqual([
    { value: "todo", label: "我的待办" },
  ]);
  expect(readingTabs).toHaveLength(6);
});
test("manual language filtering cannot create qualification", () => {
  expect(
    canHandleStage(member(["translator"], ["ja"]), "translate", "ko"),
  ).toBe(false);
  expect(canHandleStage(member(["typesetter"]), "translate", "en")).toBe(true);
  expect(canHandleStage(member(["typesetter"]), "translate", "ja")).toBe(false);
  expect(canHandleStage(member(["typesetter"]), "typeset", "ko")).toBe(true);
});
test("URLs default to work while explicit reading and legacy phase links retain their meaning", () => {
  expect(
    workViewState(new URLSearchParams(), member(["translator"])),
  ).toMatchObject({ view: "work", tab: "todo" });
  expect(
    workViewState(
      new URLSearchParams("view=read&tab=typeset"),
      member(["source"]),
    ),
  ).toMatchObject({ view: "read", tab: "typeset" });
  expect(
    workViewState(
      new URLSearchParams("view=work&tab=proofread"),
      member(["typesetter"]),
    ),
  ).toMatchObject({ view: "work", tab: "todo" });
  expect(
    workViewState(new URLSearchParams("view=todo"), member(["typesetter"])),
  ).toMatchObject({ view: "work", tab: "todo" });
  expect(
    workViewState(new URLSearchParams("phase=translation"), member(["source"])),
  ).toMatchObject({ view: "read", tab: "translation" });
});
