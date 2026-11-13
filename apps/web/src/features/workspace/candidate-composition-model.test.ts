import { expect, test } from "vitest";
import {
  applyImportDraft,
  emptyCandidateImportState,
  selectCandidateForImport,
  type ImportCandidate,
} from "./candidate-import-state";
import {
  compositionEligibility,
  createCompositionDraft,
  compositionProblem,
  compositionIntent,
  assignCompositionImages,
  excludeCompositionSource,
  removeCompositionGroup,
  settleCompositionSources,
} from "./candidate-composition-model";

function post(id: string, postedAt = "2026-01-01", authorId = "author") {
  return {
    id,
    authorId,
    authorName: id,
    postedAt,
    revision: 2,
    status: "pending",
    media: ["1", "2", "3"].map((n) => ({ id: `${id}-${n}` })),
  } as ImportCandidate;
}
function selected(...posts: ImportCandidate[]) {
  return posts.reduce(
    (state, candidate) =>
      selectCandidateForImport(state, candidate, candidate.id),
    emptyCandidateImportState(),
  );
}
test("eligibility rejects cross-author/nonpending sources and bounds the full original set", () => {
  expect(compositionEligibility(selected(post("a")), "merge")).toMatch(/至少/);
  expect(
    compositionEligibility(
      selected(post("a"), post("b", undefined, "other")),
      "merge",
    ),
  ).toMatch(/作者/);
  expect(
    compositionEligibility(
      selected({ ...post("a"), status: "discarded" }),
      "split",
    ),
  ).toMatch(/待处理/);
  expect(
    compositionEligibility(
      selected(...Array.from({ length: 21 }, (_, i) => post(String(i)))),
      "merge",
    ),
  ).toMatch(/20/);
});
test("merge follows chronological source order and each existing image draft order across loaded pages", () => {
  let state = selected(post("later", "2026-02-01"), post("earlier"));
  state = applyImportDraft(state, post("earlier"), ["earlier-3", "earlier-1"]);
  const draft = createCompositionDraft(state, "merge");
  expect(draft.sources.map((source) => source.id)).toEqual([
    "earlier",
    "later",
  ]);
  expect(draft.groups[0].mediaIds).toEqual([
    "earlier-3",
    "earlier-1",
    "later-1",
    "later-2",
    "later-3",
  ]);
  expect(compositionIntent(draft, "key").works[0].title).toBeNull();
});
test("zero-adoption merge sources require explicit exclusion and stay pending until rejoined", () => {
  const original = createCompositionDraft(
    selected(post("a"), post("b"), post("c")),
    "merge",
  );
  const empty = assignCompositionImages(original, ["c-1", "c-2", "c-3"], null);
  expect(compositionProblem(empty)).toMatch(/移出/);
  const excluded = excludeCompositionSource(empty, "c", true);
  expect(compositionProblem(excluded)).toBe("");
  expect(
    compositionIntent(excluded, "key").candidates.map((source) => source.id),
  ).toEqual(["a", "b"]);
  expect(assignCompositionImages(excluded, ["c-1"], "work-1")).toBe(excluded);
  const rejoined = excludeCompositionSource(excluded, "c", false);
  expect(rejoined.groups[0].mediaIds.slice(-3)).toEqual(["c-1", "c-2", "c-3"]);
});
test("split starts with one current draft group, atomically moves images, and group deletion unassigns them", () => {
  const draft = createCompositionDraft(selected(post("a")), "split");
  const next = {
    ...draft,
    groups: [...draft.groups, { id: "work-2", title: "第二作", mediaIds: [] }],
  };
  const moved = assignCompositionImages(next, ["a-1", "a-2"], "work-2");
  expect(moved.groups.map((group) => group.mediaIds)).toEqual([
    ["a-3"],
    ["a-1", "a-2"],
  ]);
  expect(compositionProblem(moved)).toMatch(/名称/);
  const named = {
    ...moved,
    groups: moved.groups.map((group) => ({
      ...group,
      title: group.title || "第一作",
    })),
  };
  expect(compositionProblem(named)).toBe("");
  expect(
    removeCompositionGroup(named, "work-2").groups.flatMap(
      (group) => group.mediaIds,
    ),
  ).toEqual(["a-3"]);
  expect(
    compositionProblem({
      ...named,
      groups: [...named.groups, { id: "empty", title: "", mediaIds: [] }],
    }),
  ).toMatch(/空作品/);
});
test("settlement clears only submitted matching source generations and preserves excluded/unrelated selections and drafts", () => {
  let state = selected(post("a"), post("b"), post("c"));
  const draft = createCompositionDraft(selected(post("a"), post("b")), "merge");
  state = applyImportDraft(state, post("b"), ["b-3"]);
  const settled = settleCompositionSources(state, draft.sources);
  expect([...settled.selected.keys()]).toEqual(["b", "c"]);
  expect(settled.drafts.b.mediaIds).toEqual(["b-3"]);
});
