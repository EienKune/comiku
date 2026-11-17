import type { SourceAccountSummaryDto } from "./authors.dto.js";

/** Explicit public allowlist: never spread managed account/provider data. */
export function toSourceAccountSummary(account: {
  id: string;
  platform: string;
  externalUserId: string;
  handle: string | null;
  profileUrl: string | null;
  displayNameSnapshot: string | null;
  avatarFileObjectId: string | null;
  fetchEnabled: boolean;
  deletedAt: Date | null;
}): SourceAccountSummaryDto {
  return {
    id: account.id,
    platform: account.platform,
    externalUserId: account.externalUserId,
    handle: account.handle,
    profileUrl: account.profileUrl,
    displayNameSnapshot: account.displayNameSnapshot,
    avatarAvailable: Boolean(account.avatarFileObjectId),
    fetchEnabled: account.fetchEnabled,
    deletedAt: account.deletedAt?.toISOString() ?? null,
  };
}
