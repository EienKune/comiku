export type AuthorTagChoice =
  { name: string; id: string; revision: number } | { name: string };
export function authorTagInput(value: AuthorTagChoice[]) {
  return {
    existingTags: value.flatMap((tag) =>
      "id" in tag ? [{ id: tag.id, expectedRevision: tag.revision }] : [],
    ),
    newTagNames: value.filter((tag) => !("id" in tag)).map((tag) => tag.name),
  };
}
