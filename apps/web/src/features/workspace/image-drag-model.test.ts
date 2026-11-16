import { expect, test } from "vitest";
import { imageDragSnapshot, moveImage } from "./image-drag-model";

const groups = [
  { id: "first", mediaIds: ["a", "b", "c"] },
  { id: "empty", mediaIds: [] },
  { id: "last", mediaIds: ["d"] },
];
const valid = ["a", "b", "c", "d", "source"];
test("moves across groups atomically and inserts among remaining rows", () => {
  const next = moveImage(
    groups,
    "b",
    "last",
    0,
    imageDragSnapshot(groups, valid),
    valid,
  );
  expect(next.map((group) => group.mediaIds)).toEqual([
    ["a", "c"],
    [],
    ["b", "d"],
  ]);
  expect(groups[0].mediaIds).toEqual(["a", "b", "c"]);
});
test("adds an unassigned original to an empty group and clamps append", () => {
  expect(
    moveImage(
      groups,
      "source",
      "empty",
      50,
      imageDragSnapshot(groups, valid),
      valid,
    )[1].mediaIds,
  ).toEqual(["source"]);
});
test("same-group slot counts only remaining rows and no-op preserves identity", () => {
  expect(
    moveImage(
      groups,
      "a",
      "first",
      2,
      imageDragSnapshot(groups, valid),
      valid,
    )[0].mediaIds,
  ).toEqual(["b", "c", "a"]);
  expect(
    moveImage(groups, "b", "first", 1, imageDragSnapshot(groups, valid), valid),
  ).toBe(groups);
});
test("rejects stale ownership, eligibility, version and invalid target without mutation", () => {
  const snapshot = imageDragSnapshot(groups, valid, "revision-1");
  expect(moveImage(groups, "b", "last", 0, snapshot, valid, "revision-2")).toBe(
    groups,
  );
  expect(
    moveImage(
      groups,
      "b",
      "missing",
      0,
      imageDragSnapshot(groups, valid),
      valid,
    ),
  ).toBe(groups);
  expect(
    moveImage(
      groups,
      "foreign",
      "last",
      0,
      imageDragSnapshot(groups, valid),
      valid,
    ),
  ).toBe(groups);
  expect(
    moveImage(
      groups,
      "b",
      "last",
      0,
      snapshot,
      valid.filter((id) => id !== "b"),
      "revision-1",
    ),
  ).toBe(groups);
});
test("a move removes every previous assignment instead of duplicating media", () => {
  const duplicate = [
    { id: "one", mediaIds: ["a"] },
    { id: "two", mediaIds: ["a", "b"] },
  ];
  const next = moveImage(
    duplicate,
    "a",
    "two",
    1,
    imageDragSnapshot(duplicate, valid),
    valid,
  );
  expect(next.map((group) => group.mediaIds)).toEqual([[], ["b", "a"]]);
});
