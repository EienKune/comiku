import { expect, test } from "vitest";
import type { components } from "@comiku/api-client";
import {
  buildCandidateImportIntent,
  emptyCandidateImportState,
  selectCandidateForImport,
  applyImportDraft,
  settleCandidateImport,
} from "./candidate-import-state";
type Candidate = components["schemas"]["CandidateDto"];
const post = (id: string, revision = 1) =>
  ({
    id,
    revision,
    authorName: id,
    status: "pending",
    media: ["a", "b", "c"].map((name, orderIndex) => ({
      id: `${id}-${name}`,
      orderIndex,
      externalMediaId: name,
      width: null,
      height: null,
      mediaType: "image",
    })),
  }) as Candidate;
test("confirmation uses the selected revision and applied image subset even after loaded pages disappear", () => {
  let state = selectCandidateForImport(
    emptyCandidateImportState(),
    post("one"),
    "first",
  );
  state = applyImportDraft(state, post("one"), ["one-c", "one-a"]);
  const intent = buildCandidateImportIntent(state);
  expect(intent[0].mediaIds).toEqual(["one-c", "one-a"]);
  expect(intent[0].expectedRevision).toBe(1);
  expect(intent[0].candidate.media).toHaveLength(3);
});
test("unselected drafts do not join the batch or block selected posts", () => {
  let state = applyImportDraft(emptyCandidateImportState(), post("other"), [
    "other-a",
  ]);
  state = selectCandidateForImport(state, post("one"), "token");
  expect(buildCandidateImportIntent(state).map((i) => i.id)).toEqual(["one"]);
});
test("stale adoption baseline cannot silently rebase to the revision selected later", () => {
  let state = applyImportDraft(emptyCandidateImportState(), post("one", 1), [
    "one-c",
  ]);
  state = selectCandidateForImport(state, post("one", 2), "token");
  expect(() => buildCandidateImportIntent(state)).toThrow(/更新|版本/);
});
test("late success cannot clear a newer same-revision selection or a newer applied draft", () => {
  let state = selectCandidateForImport(
    emptyCandidateImportState(),
    post("one"),
    "old",
  );
  const old = buildCandidateImportIntent(state);
  state = selectCandidateForImport(state, post("one"), "toggle-off");
  state = selectCandidateForImport(state, post("one"), "new");
  expect(
    settleCandidateImport(state, old, [{ id: "one", outcome: "succeeded" }])
      .selected.size,
  ).toBe(1);
  const next = buildCandidateImportIntent(state);
  state = applyImportDraft(state, post("one"), ["one-b"]);
  expect(
    settleCandidateImport(state, next, [{ id: "one", outcome: "succeeded" }])
      .selected.size,
  ).toBe(1);
});
test("partial results clear only successful matching entries and retain failed draft and selection", () => {
  let state = selectCandidateForImport(
    emptyCandidateImportState(),
    post("one"),
    "one",
  );
  state = selectCandidateForImport(state, post("two"), "two");
  state = applyImportDraft(state, post("two"), ["two-c"]);
  const intent = buildCandidateImportIntent(state);
  state = settleCandidateImport(state, intent, [
    { id: "one", outcome: "unchanged" },
    { id: "two", outcome: "conflict" },
  ]);
  expect([...state.selected.keys()]).toEqual(["two"]);
  expect(state.drafts.two.mediaIds).toEqual(["two-c"]);
});
