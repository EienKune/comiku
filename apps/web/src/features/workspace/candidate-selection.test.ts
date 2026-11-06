import { expect, test } from "vitest";
import {
  selectCandidates,
  settleCandidateSelection,
  toggleLoadedCandidates,
} from "./candidate-selection";

test("selection retains first revision across pages and session replacements", () => {
  const first = selectCandidates(new Map(), [{ id: "a", revision: 2 }]);
  const next = selectCandidates(first, [
    { id: "a", revision: 9 },
    { id: "b", revision: 3 },
  ]);
  expect([...next]).toEqual([
    ["a", 2],
    ["b", 3],
  ]);
  expect([...first]).toEqual([["a", 2]]);
});
test("batch only clears succeeded/unchanged and preserves conflicts and missing results", () => {
  const selected = new Map([
    ["a", 2],
    ["b", 3],
    ["c", 4],
    ["d", 5],
  ]);
  expect([
    ...settleCandidateSelection(selected, [
      { id: "a", outcome: "succeeded" },
      { id: "b", outcome: "conflict" },
      { id: "c", outcome: "unchanged" },
    ]),
  ]).toEqual([
    ["b", 3],
    ["d", 5],
  ]);
});

test("loaded selection stops at the API's 100 item limit and preserves existing revisions", () => {
  const result = selectCandidates(new Map([["existing", 7]]), [
    { id: "existing", revision: 99 },
    ...Array.from({ length: 110 }, (_, i) => ({
      id: `post-${i}`,
      revision: i,
    })),
  ]);
  expect(result.size).toBe(100);
  expect(result.get("existing")).toBe(7);
});

test("late batch completion does not clear a newly selected revision of the same post", () => {
  const submitted = new Map([["a", 2]]);
  const current = new Map([
    ["a", 9],
    ["b", 1],
  ]);
  expect([
    ...settleCandidateSelection(
      current,
      [{ id: "a", outcome: "succeeded" }],
      submitted,
    ),
  ]).toEqual([
    ["a", 9],
    ["b", 1],
  ]);
});

test("loaded cancellation is scoped and new pages do not join the existing selection", () => {
  const selected = new Map([
    ["a", 2],
    ["hidden-other-section", 5],
  ]);
  expect([
    ...toggleLoadedCandidates(selected, [{ id: "a", revision: 9 }]),
  ]).toEqual([["hidden-other-section", 5]]);
  expect([
    ...toggleLoadedCandidates(selected, [
      { id: "a", revision: 9 },
      { id: "b", revision: 3 },
    ]),
  ]).toEqual([
    ["a", 2],
    ["hidden-other-section", 5],
    ["b", 3],
  ]);
});

test("a loaded scope larger than the limit can cancel its capped selection", () => {
  const loaded = Array.from({ length: 120 }, (_, i) => ({
    id: `post-${i}`,
    revision: i,
  }));
  const selected = toggleLoadedCandidates(new Map(), loaded);
  expect(selected.size).toBe(100);
  expect(toggleLoadedCandidates(selected, loaded).size).toBe(0);
});
