import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { SelectField, Button } from "../../components/ui";
import { PlatformIcon, type Platform } from "../../components/PlatformIcon";
import { client, unwrap } from "../account/api";
import type { SourceSelection } from "./source-filter-state";
import "./source-account-filter.css";
type Account = components["schemas"]["SourceAccountSummaryDto"];
const identity = (account: Account) =>
  account.platform === "x" && account.handle
    ? `@${account.handle}`
    : account.externalUserId;
export function SourceAccountFilter({
  authorId,
  value,
  onChange,
  disabled = false,
}: {
  authorId?: string;
  value: SourceSelection;
  onChange: (value: SourceSelection) => void;
  disabled?: boolean;
}) {
  const [requestedAuthor, setRequestedAuthor] = useState<string>();
  const accounts = useQuery({
    queryKey: ["author-source-accounts", authorId],
    enabled: Boolean(authorId && requestedAuthor === authorId),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/authors/{id}/source-accounts", {
          params: { path: { id: authorId! } },
          signal,
        }),
      ),
  });
  const data = accounts.data ?? [];
  const accountId = value.startsWith("account:") ? value.slice(8) : null;
  const unknownSelection = accountId && !data.some((a) => a.id === accountId);
  function request() {
    if (!disabled && authorId) setRequestedAuthor(authorId);
  }
  return (
    <div
      className="source-account-filter"
      onClickCapture={request}
      onKeyDownCapture={(event) => {
        if (
          ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(
            event.key,
          )
        )
          request();
      }}
    >
      <SelectField
        aria-label="来源账号"
        value={value}
        disabled={disabled || !authorId}
        onValueChange={(v) => onChange(v as SourceSelection)}
      >
        <option value="all">{authorId ? "全部来源账号" : "先选择作者"}</option>
        {unknownSelection && (
          <option value={value} disabled>
            {accounts.isSuccess ? "账号已变更，请重新选择" : "指定账号"}
          </option>
        )}
        {data
          .filter(
            (account) =>
              account.platform === "x" || account.platform === "pixiv",
          )
          .map((account) => (
            <option key={account.id} value={`account:${account.id}`}>
              <span className="source-account-option">
                <span
                  className={`source-account-option__icon is-${account.platform}`}
                  role="img"
                  aria-label={account.platform === "x" ? "X" : "Pixiv"}
                >
                  <PlatformIcon
                    platform={account.platform as Platform}
                    size={16}
                  />
                </span>
                <span className="source-account-option__identity">
                  {identity(account)}
                  {account.deletedAt ? "（已停用）" : ""}
                </span>
              </span>
            </option>
          ))}
        {requestedAuthor === authorId && accounts.isPending && (
          <option value="loading" disabled>
            读取账号中…
          </option>
        )}
      </SelectField>
      {accounts.isError && (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-label="重试读取来源账号"
          onClick={() => void accounts.refetch()}
        >
          重试读取
        </Button>
      )}
    </div>
  );
}
