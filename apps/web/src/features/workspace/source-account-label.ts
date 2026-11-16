import type { components } from "@comiku/api-client";
type Identity = Pick<
  components["schemas"]["SourceAccountSummaryDto"],
  "handle" | "externalUserId"
>;
export function sourceAccountLabel(
  platform: string,
  account: Identity | null | undefined,
): string {
  if (platform === "manual") return "手动上传";
  if (!account) return "来源账号未知";
  return platform === "x" && account.handle
    ? `@${account.handle}`
    : account.externalUserId;
}
