export type ProfileAvatarSnapshot = {
  externalUserId: string;
  handle: string | null;
  displayName: string;
  avatarFileObjectId: string | null;
  syncedAt: string;
};

export function hasFreshProfileAvatar(
  profile: Pick<
    ProfileAvatarSnapshot,
    "avatarFileObjectId" | "syncedAt"
  > | null,
) {
  if (!profile?.avatarFileObjectId) return false;
  const age = Date.now() - Date.parse(profile.syncedAt);
  return age >= 0 && age < 600_000;
}

export function canPreserveProfileAvatar(
  current: ProfileAvatarSnapshot | null,
  next: ProfileAvatarSnapshot,
) {
  return Boolean(
    current &&
    !next.avatarFileObjectId &&
    hasFreshProfileAvatar(current) &&
    current.externalUserId === next.externalUserId &&
    current.handle === next.handle,
  );
}

export function preserveProfileAvatar<T extends ProfileAvatarSnapshot>(
  current: T | null,
  next: T,
): T {
  return current && canPreserveProfileAvatar(current, next)
    ? { ...current, displayName: next.displayName }
    : next;
}
