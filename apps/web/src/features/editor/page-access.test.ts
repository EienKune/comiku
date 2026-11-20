import { expect, test } from "vitest";
import { getPageWriteAccess, type PageEditor } from "./page-access";
const editor = {
  canEdit: true,
  editStages: ["translate"],
  editableImageIds: ["mine"],
  pageAssignments: [{ workImageId: "mine", generation: 3 }],
} as unknown as PageEditor;
test("translation sends the exact ownership generation", () => {
  expect(getPageWriteAccess(editor, "mine")).toEqual({
    expectedAssignmentGeneration: 3,
  });
});
test("unowned pages never gain writes from membership alone", () => {
  expect(() => getPageWriteAccess(editor, "other")).toThrow("此页分工");
});
test("submitted or withdrawn members cannot write", () => {
  expect(() =>
    getPageWriteAccess({ ...editor, canEdit: false }, "mine"),
  ).toThrow();
});
test("proofreading uses ordinary revision guards without a lease or translation generation", () => {
  expect(
    getPageWriteAccess({ ...editor, editStages: ["proofread"] }, "mine"),
  ).toEqual({});
});
test("a dual-role proofreader does not inherit the old translation assignment", () => {
  expect(
    getPageWriteAccess(
      { ...editor, editStages: ["translate", "proofread"] },
      "mine",
    ),
  ).toEqual({});
});
test("proofreading still enforces the explicit server page scope", () => {
  expect(() =>
    getPageWriteAccess({ ...editor, editStages: ["proofread"] }, "other"),
  ).toThrow();
});
test("an empty write scope is read only even with stage permission", () => {
  expect(() =>
    getPageWriteAccess({ ...editor, editableImageIds: [] }, "mine"),
  ).toThrow();
});
