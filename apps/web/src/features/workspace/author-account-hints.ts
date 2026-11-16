import type { PlatformAccount } from "../../components/PlatformLinks";

// Keep server ordering within each match tier. Pausing collection does not hide
// an active identity; stopped identities must not become search suggestions.
export function authorAccountHint(accounts: PlatformAccount[], search: string) {
  const term = search
    .normalize("NFKC")
    .trim()
    .replace(/^@/, "")
    .toLocaleLowerCase();
  const active = accounts.filter((account) => !account.deletedAt);
  const matches = (account: PlatformAccount) =>
    Boolean(term) &&
    [account.handle, account.externalUserId].some((value) =>
      value?.normalize("NFKC").toLocaleLowerCase().includes(term),
    );
  const ordered = [
    ...active.filter(matches),
    ...active.filter((account) => !matches(account)),
  ];
  const labels = ordered
    .slice(0, 2)
    .map((account) =>
      account.platform === "x"
        ? `X ${account.handle ? "@" + account.handle.replace(/^@/, "") : account.externalUserId}`
        : `Pixiv ${account.externalUserId}`,
    );
  if (ordered.length > 2) labels.push(`+${ordered.length - 2}`);
  return labels.join(" · ");
}
