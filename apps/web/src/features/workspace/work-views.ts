import type { components } from "@comiku/api-client";
type Member = Pick<
  components["schemas"]["MemberDto"],
  "roles" | "languageCapabilities"
>;
type Language = components["schemas"]["SourceLanguage"];
export type ClaimStage = "translate" | "proofread" | "typeset";
export type WorkTab =
  | "all"
  | "translation"
  | "proofread"
  | "typeset"
  | "pending_publish"
  | "published"
  | "todo"
  | "translate";
export const readingTabs: { value: WorkTab; label: string }[] = [
  { value: "all", label: "全部作品" },
  { value: "translation", label: "翻译中" },
  { value: "proofread", label: "校对中" },
  { value: "typeset", label: "嵌字中" },
  { value: "pending_publish", label: "待发布" },
  { value: "published", label: "已发布" },
];
export function canHandleStage(
  member: Member,
  stage: ClaimStage,
  language: Language,
) {
  const roles = new Set(member.roles.filter((role) => role !== "admin"));
  const base =
    stage === "translate"
      ? language === "en"
        ? roles.has("translator") || roles.has("typesetter")
        : roles.has("translator")
      : stage === "proofread"
        ? roles.has("proofreader")
        : roles.has("typesetter");
  return (
    base &&
    (stage === "typeset" ||
      language === "en" ||
      member.languageCapabilities.includes(language))
  );
}
export function workingTabs(
  member: Member,
): { value: WorkTab; label: string }[] {
  const tabs: { value: WorkTab; label: string }[] = [
    { value: "todo", label: "我的待办" },
  ];
  for (const [stage, label] of [
    ["translate", "可接翻译"],
    ["proofread", "可接校对"],
    ["typeset", "可接嵌字"],
  ] as const) {
    if (
      (["ja", "ko", "en"] as const).some((language) =>
        canHandleStage(member, stage, language),
      )
    )
      tabs.push({ value: stage, label });
  }
  if (member.roles.some((role) => role === "operator" || role === "admin"))
    tabs.push({ value: "pending_publish", label: "待发布" });
  return tabs;
}
export function workViewState(params: URLSearchParams, member: Member) {
  const requestedView = params.get("view");
  const view =
    requestedView === "read" || (!requestedView && params.has("phase"))
      ? "read"
      : "work";
  const tabs = view === "work" ? workingTabs(member) : readingTabs;
  const requested =
    params.get("tab") ??
    (requestedView === "todo"
      ? "todo"
      : requestedView === "recommended"
        ? tabs.find((tab) =>
            ["translate", "proofread", "typeset"].includes(tab.value),
          )?.value
        : params.get("phase"));
  const tab =
    tabs.find((tab) => tab.value === requested)?.value ??
    (view === "work" ? "todo" : "all");
  return { view, tab, tabs } as const;
}
