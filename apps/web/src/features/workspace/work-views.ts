import type { components } from "@comiku/api-client";
type Member = Pick<
  components["schemas"]["MemberDto"],
  "roles" | "languageCapabilities"
>;
type Language = components["schemas"]["SourceLanguage"];
type WorkDetail = components["schemas"]["WorkDetailDto"];
export type ClaimStage = "translate" | "proofread" | "typeset";
export function currentWorkStage(
  status: components["schemas"]["WorkflowStatus"],
): components["schemas"]["WorkStage"] | null {
  if (status === "pending_translate" || status === "translating")
    return "translate";
  if (status === "pending_proofread" || status === "proofreading")
    return "proofread";
  if (status === "pending_typeset" || status === "typesetting")
    return "typeset";
  return status === "pending_publish" ? "publish" : null;
}

export function stageClaimAccess(
  member: Member & { id: string },
  work: WorkDetail,
  stage: ClaimStage,
) {
  const stages: components["schemas"]["WorkStage"][] = [
    "translate",
    "proofread",
    "typeset",
    "publish",
  ];
  const current = currentWorkStage(work.workflowStatus);
  const inWindow =
    !work.collaborationMigrationIssue &&
    work.reviewStatus === "normal" &&
    current !== null &&
    stages.indexOf(current) <= stages.indexOf(stage) &&
    !(stage === "proofread" && work.proofreadingSkipped);
  const retained = work.participants.filter((person) => !person.leftAt);
  const participants = retained.filter((person) => person.stage === stage);
  const qualified = canHandleStage(member, stage, work.sourceLanguage);
  const opposite =
    stage === "translate"
      ? "proofread"
      : stage === "proofread"
        ? "translate"
        : null;
  const singleConflict =
    work.collaborationMode === "single" &&
    opposite &&
    retained.some(
      (person) => person.userId === member.id && person.stage === opposite,
    );
  const canClaim =
    inWindow &&
    qualified &&
    !singleConflict &&
    (stage === "proofread"
      ? !participants.some((person) => person.userId === member.id) &&
        (work.collaborationMode === "multi" || participants.length === 0)
      : work.collaborationMode === "multi" ||
        participants.length === 0 ||
        (current === stage &&
          participants.every(
            (person) => person.userId === member.id && person.submittedAt,
          )));
  const canAddProofreader =
    stage === "proofread" &&
    inWindow &&
    work.collaborationMode === "multi" &&
    (member.roles.includes("admin") ||
      (qualified &&
        participants.some((person) => person.userId === member.id)));
  return { inWindow, canClaim: Boolean(canClaim), canAddProofreader };
}
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
  if (member.roles.includes("operator"))
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
