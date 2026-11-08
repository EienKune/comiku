import { expect, test } from "vitest";
import {
  selectCandidates,
  settleCandidateSelection,
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
