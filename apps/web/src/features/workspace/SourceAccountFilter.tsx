import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { SelectField, Button } from "../../components/ui";
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
  const historical = data.filter((a) => a.deletedAt);
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
        {(["x", "pixiv"] as const).map((platform) => {
          const active = data.filter(
            (a) => a.platform === platform && !a.deletedAt,
          );
          return (
            <optgroup key={platform} label={platform === "x" ? "X" : "Pixiv"}>
              <option value={`platform:${platform}`}>
                {platform === "x" ? "全部 X 账号" : "全部 Pixiv 账号"}
              </option>
              {active.map((account) => (
                <option key={account.id} value={`account:${account.id}`}>
                  {identity(account)}
                </option>
              ))}
            </optgroup>
          );
        })}
        {historical.length > 0 && (
          <optgroup label="历史账号">
            {historical.map((account) => (
              <option
                key={account.id}
                value={`account:${account.id}`}
              >{`${account.platform === "x" ? "X" : "Pixiv"} · ${identity(account)}（已停用）`}</option>
            ))}
          </optgroup>
        )}
        <option value="manual">手动上传</option>
        <option value="unbound">来源账号未知</option>
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
