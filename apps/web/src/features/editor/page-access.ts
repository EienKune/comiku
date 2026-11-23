import type { components } from "@comiku/api-client";

export type PageEditor = components["schemas"]["TranslationEditorDto"];

/** Client scope checks complement the server's authoritative stage and page guards. */
export function getPageWriteAccess(editor: PageEditor, imageId: string) {
  if (
    !editor.canEdit ||
    (editor.editableImageIds && !editor.editableImageIds.includes(imageId))
  )
    throw new Error("此页分工或提交状态已变化，本地草稿保留，请核对最新状态。");
  const assignment = editor.editStages.includes("proofread")
    ? undefined
    : editor.pageAssignments?.find((page) => page.workImageId === imageId);
  return assignment
    ? { expectedAssignmentGeneration: assignment.generation }
    : {};
}
