import type {
  EditableTranslationImage,
  TranslationImage,
} from "./draft-storage";

/** Structural receipts never acknowledge unrelated local text changes. */
export function mergeServerImage(
  serverImage: TranslationImage,
  localImage: EditableTranslationImage | undefined,
  dirtyIds: ReadonlySet<string>,
  acknowledgedLocalEntryId?: string,
) {
  const conflictedEntryIds = new Set<string>();
  if (!localImage)
    return {
      image: serverImage as EditableTranslationImage,
      conflictedEntryIds,
    };
  const localById = new Map(
    localImage.entries.map((entry) => [entry.id, entry]),
  );
  const serverIds = new Set(serverImage.entries.map((entry) => entry.id));
  const entries = serverImage.entries.map((serverEntry) => {
    const local = localById.get(serverEntry.id);
    if (!local || !dirtyIds.has(local.id)) return serverEntry;
    if (local.revision !== serverEntry.revision)
      conflictedEntryIds.add(local.id);
    // Keep the exact content baseline on which this local edit was made.
    return { ...local, orderIndex: serverEntry.orderIndex };
  });
  for (const local of localImage.entries) {
    if (serverIds.has(local.id) || local.id === acknowledgedLocalEntryId)
      continue;
    if (!local.localOnly && !dirtyIds.has(local.id)) continue;
    if (!local.localOnly) conflictedEntryIds.add(local.id);
    // Unacknowledged creations and remotely deleted dirty text must stay recoverable.
    entries.push({ ...local, orderIndex: entries.length });
  }
  return { image: { ...serverImage, entries }, conflictedEntryIds };
}
