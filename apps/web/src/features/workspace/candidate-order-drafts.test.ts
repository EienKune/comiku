import { expect, test } from "vitest";
import type { components } from "@comiku/api-client";
import {
  candidateOrderDraft,
  moveCandidateOrder,
  candidateOrderConflict,
} from "./candidate-order-drafts";
const candidate = {
  id: "post",
  revision: 2,
  media: [{ id: "a" }, { id: "b" }],
} as components["schemas"]["CandidateDto"];
test("dirty order retains its original revision across refresh and detects real media changes", () => {
  const dirty = moveCandidateOrder(undefined, candidate, 0, 1);
  expect(dirty.media.map((i) => i.id)).toEqual(["b", "a"]);
  expect(dirty.dirty).toBe(true);
  expect(candidateOrderDraft(dirty, { ...candidate, revision: 3 })).toBe(dirty);
  expect(
    candidateOrderConflict(dirty, {
      ...candidate,
      media: [...candidate.media],
    }),
  ).toBe(false);
  expect(candidateOrderConflict(dirty, { ...candidate, revision: 3 })).toBe(
    true,
  );
  expect(
    candidateOrderConflict(dirty, {
      ...candidate,
      media: candidate.media.slice(0, 1),
    }),
  ).toBe(true);
  expect(dirty.expectedRevision).toBe(2);
});
test("returning to original order is clean and a confirmed save establishes the next baseline", () => {
  const dirty = moveCandidateOrder(undefined, candidate, 0, 1);
  expect(moveCandidateOrder(dirty, candidate, 0, 1).dirty).toBe(false);
  const saved = {
    ...candidate,
    revision: 3,
    media: [...candidate.media].reverse(),
  };
  const baseline = candidateOrderDraft(undefined, saved);
  const next = moveCandidateOrder(baseline, candidate, 0, 1);
  expect(next.expectedRevision).toBe(3);
  expect(next.originalMediaIds).toEqual(["b", "a"]);
});
