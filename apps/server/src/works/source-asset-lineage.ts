/** A legacy pointer is insufficient; each replacement must extend the audited file chain. */
export function matchesSourceAssetLineage(
  sourceFileId: string,
  currentFileId: string,
  replacements: readonly {
    oldFileObjectId: string;
    newFileObjectId: string;
  }[] = [],
): boolean {
  let fileId = sourceFileId;
  for (const replacement of replacements)
    if (replacement.oldFileObjectId === fileId)
      fileId = replacement.newFileObjectId;
  return fileId === currentFileId;
}
