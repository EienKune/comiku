export type ImageDragGroup = { id: string; mediaIds: readonly string[] };

export function imageDragSnapshot(
  groups: readonly ImageDragGroup[],
  validIds: readonly string[],
  epoch = "",
) {
  return JSON.stringify([
    epoch,
    validIds,
    groups.map((group) => [group.id, group.mediaIds]),
  ]);
}

export function moveImage<T extends ImageDragGroup>(
  groups: readonly T[],
  id: string,
  targetGroupId: string,
  slot: number,
  expectedSnapshot: string,
  validIds: readonly string[],
  epoch = "",
): readonly T[] {
  if (
    imageDragSnapshot(groups, validIds, epoch) !== expectedSnapshot ||
    !validIds.includes(id) ||
    !groups.some((group) => group.id === targetGroupId) ||
    !Number.isFinite(slot)
  )
    return groups;
  const next = groups.map((group) => ({
    ...group,
    mediaIds: group.mediaIds.filter((mediaId) => mediaId !== id),
  }));
  const target = next.find((group) => group.id === targetGroupId)!;
  target.mediaIds.splice(
    Math.max(0, Math.min(Math.trunc(slot), target.mediaIds.length)),
    0,
    id,
  );
  return next.every(
    (group, index) =>
      group.mediaIds.length === groups[index].mediaIds.length &&
      group.mediaIds.every(
        (mediaId, mediaIndex) => mediaId === groups[index].mediaIds[mediaIndex],
      ),
  )
    ? groups
    : next;
}
