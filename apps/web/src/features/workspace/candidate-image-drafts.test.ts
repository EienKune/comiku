import { expect, test } from "vitest";
import {
  applyCandidateImageDraft,
  candidateImageDraft,
  candidateImageDraftChanged,
  candidateImageDraftConflict,
  candidateImageSelectionSummary,
  validateCandidateImageIds,
} from "./candidate-image-drafts";

const source = {
  id: "post",
  revision: 4,
  media: ["one", "two", "three"].map((id, orderIndex) => ({
    id,
    orderIndex,
    externalMediaId: id,
    width: null,
    height: null,
    mediaType: "image",
  })),
};

test("adoption defaults to every source image and preserves the original source order", () => {
  const draft = candidateImageDraft(undefined, source);
  expect(draft.mediaIds).toEqual(["one", "two", "three"]);
  expect(draft.expectedRevision).toBe(4);
  expect(candidateImageDraftChanged(draft)).toBe(false);
});
test("applying a subset and order is local, revision-pinned, and does not mutate source media", () => {
  const draft = applyCandidateImageDraft(undefined, source, ["three", "one"]);
  expect(draft.sourceMediaIds).toEqual(["one", "two", "three"]);
  expect(draft.mediaIds).toEqual(["three", "one"]);
  expect(source.media.map((i) => i.id)).toEqual(["one", "two", "three"]);
  expect(candidateImageSelectionSummary(draft)).toEqual({
    selectedCount: 2,
    totalCount: 3,
    orderChanged: true,
  });
  expect(candidateImageDraft(draft, { ...source, revision: 5 })).toBe(draft);
  expect(candidateImageDraftConflict(draft, { ...source, revision: 5 })).toBe(
    true,
  );
});
test("apply rejects empty, duplicate, unknown and oversized selections without corrupting a previous draft", () => {
  const original = applyCandidateImageDraft(undefined, source, ["two"]);
  for (const ids of [[], ["one", "one"], ["foreign"]]) {
    expect(() => applyCandidateImageDraft(original, source, ids)).toThrow();
    expect(original.mediaIds).toEqual(["two"]);
  }
  expect(
    validateCandidateImageIds(
      Array.from({ length: 1001 }, (_, i) => String(i)),
      Array.from({ length: 1001 }, (_, i) => String(i)),
    ),
  ).toBe(false);
});
test("metadata/media changes require explicit re-review while ordinary model fields do not", () => {
  const draft = applyCandidateImageDraft(undefined, source, ["one", "three"]);
  expect(candidateImageDraftConflict(draft, source)).toBe(false);
  expect(
    candidateImageDraftConflict(draft, {
      ...source,
      media: [...source.media].reverse(),
    }),
  ).toBe(true);
  expect(() =>
    applyCandidateImageDraft(draft, { ...source, revision: 5 }, ["one"]),
  ).toThrow();
  const restored = applyCandidateImageDraft(draft, source, [
    "one",
    "two",
    "three",
  ]);
  expect(candidateImageDraftChanged(restored)).toBe(false);
  expect(restored.editVersion).toBeGreaterThan(draft.editVersion);
});
