import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import {
  Button,
  Badge,
  Surface,
  SelectField,
  TextField,
} from "../../components/ui";
import { OptionalSection } from "../../components/OptionalSection";
import { PlatformLinks } from "../../components/PlatformLinks";
import { useAccount } from "../account/account-context";
import { client, queryClient, unwrap } from "../account/api";
import { Feedback } from "../account/forms";
import { useAction } from "../account/use-action";
import {
  sourceAdapterLabels,
  sourceAdapterHealthLabels,
} from "./source-labels";

type Account = components["schemas"]["ExternalAccountDto"];
type Summary = components["schemas"]["ExternalAccountSummaryDto"];
type Profile = components["schemas"]["ResolvedXProfileDto"];
type Capability = components["schemas"]["SourceCapabilityDto"];
const firstSyncModeLabels: Record<Account["firstSyncMode"], string> = {
  none: "仅后续内容",
  last_24_hours: "最近 24 小时",
  last_7_days: "最近 7 天",
};

export function AuthorAccountsPanel({
  authorId,
  initialAccounts,
}: {
  authorId: string;
  initialAccounts: Summary[];
}) {
  const user = useAccount();
  const manage = user.permissions.includes("authors:manage");
  const action = useAction();
  const capabilities = useQuery({
    queryKey: ["source-capabilities"],
    enabled: manage,
    queryFn: async () => unwrap(await client.GET("/api/authors/sources")),
  });
  const accounts = useQuery({
    queryKey: ["author-accounts", authorId],
    enabled: manage,
    queryFn: async () =>
      unwrap(
        await client.GET("/api/authors/{authorId}/accounts", {
          params: { path: { authorId } },
        }),
      ),
  });
  const history = useQuery({
    queryKey: ["author-archived-accounts", authorId],
    enabled: manage,
    queryFn: async () =>
      unwrap(
        await client.GET("/api/authors/{authorId}/accounts/archived", {
          params: { path: { authorId } },
        }),
      ),
  });
  const [editor, setEditor] = useState<{
    account?: Account;
    platform: "x" | "pixiv";
  } | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  async function refresh() {
    await Promise.all(
      [
        "author",
        "authors",
        "author-accounts",
        "author-archived-accounts",
        "author-avatar",
        "candidate-author-avatar",
        "candidates",
      ].map((key) =>
        queryClient.invalidateQueries({
          queryKey:
            key === "authors" || key === "candidates" ? [key] : [key, authorId],
        }),
      ),
    );
  }
  const visible = manage ? (accounts.data ?? initialAccounts) : initialAccounts;
  return (
    <Surface className="workspace-panel">
      <h2>平台账号</h2>
      <p className="workspace-muted">
        每位作者最多关联一个 X 和一个 Pixiv 账号。
      </p>
      <Feedback
        error={
          action.error ||
          (accounts.error instanceof Error ? accounts.error.message : "")
        }
        success={action.success}
      />
      <PlatformLinks accounts={visible} />
      {visible.length ? (
        <ul className="workspace-account-list">
          {visible.map((account) => {
            const managed =
              manage && "revision" in account ? (account as Account) : null;
            const hasCollection =
              managed &&
              (managed.fetchEnabled ||
                managed.adapterStates.length > 0 ||
                capabilities.data?.some(
                  (item) =>
                    item.platform === account.platform && item.available,
                ));
            return (
              <li key={account.id}>
                <div>
                  <strong>
                    {account.platform === "x"
                      ? `X · @${account.handle ?? "未填写"}`
                      : `Pixiv · ${account.externalUserId}`}
                  </strong>
                  <small>
                    {account.displayNameSnapshot || "未设置显示昵称"}
                  </small>
                  {hasCollection && managed && (
                    <small>
                      {managed.fetchEnabled
                        ? "自动抓取已启用"
                        : "自动抓取已暂停"}
                    </small>
                  )}
                  {managed && managed.adapterStates.length > 0 && (
                    <div className="workspace-adapter-list">
                      {managed.adapterStates.map((state) => (
                        <span key={state.adapterKey}>
                          <Badge
                            tone={
                              state.health === "healthy" ? "success" : "neutral"
                            }
                          >
                            {sourceAdapterLabels[state.adapterKey] ??
                              state.adapterKey}{" "}
                            ·{" "}
                            {sourceAdapterHealthLabels[state.health] ??
                              state.health}
                          </Badge>
                          {state.lastErrorMessage && (
                            <small>{state.lastErrorMessage}</small>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              action.busy ||
                              (!state.enabled &&
                                (Boolean(capabilities.error) ||
                                  !capabilities.data?.some(
                                    (item) =>
                                      item.platform === account.platform &&
                                      item.adapterKey === state.adapterKey &&
                                      item.available,
                                  )))
                            }
                            onClick={() =>
                              void action.run(async () => {
                                await unwrap(
                                  await client.PATCH(
                                    "/api/authors/{authorId}/accounts/{id}/adapters/{adapterKey}",
                                    {
                                      params: {
                                        path: {
                                          authorId,
                                          id: account.id,
                                          adapterKey: state.adapterKey,
                                        },
                                      },
                                      body: {
                                        enabled: !state.enabled,
                                        expectedRevision: state.revision,
                                      },
                                    },
                                  ),
                                );
                                await refresh();
                                action.setSuccess("抓取通道设置已保存");
                              })
                            }
                          >
                            {state.enabled ? "停用通道" : "启用通道"}
                          </Button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {managed && (
                  <div className="workspace-inline-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={action.busy}
                      onClick={() =>
                        setEditor({
                          account: managed,
                          platform: managed.platform === "x" ? "x" : "pixiv",
                        })
                      }
                    >
                      编辑账号
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() => setRemoving(managed)}
                    >
                      解绑账号
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="workspace-muted">尚未关联账号。</p>
      )}
      {manage && (
        <>
          <div className="workspace-inline-actions">
            {(["x", "pixiv"] as const).map((platform) => (
              <Button
                key={platform}
                size="sm"
                variant="secondary"
                disabled={
                  accounts.isPending ||
                  visible.some((account) => account.platform === platform)
                }
                onClick={() => setEditor({ platform })}
              >
                关联 {platform === "x" ? "X" : "Pixiv"}
              </Button>
            ))}
          </div>
          <OptionalSection label="已解绑账号" defaultOpen={false}>
            {history.error ? (
              <p className="account-error">
                历史账号读取失败，请重试。
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void history.refetch()}
                >
                  重试
                </Button>
              </p>
            ) : (history.data ?? []).length ? (
              <ul className="workspace-account-list">
                {history.data!.map((account) => {
                  const occupied = visible.some(
                    (current) => current.platform === account.platform,
                  );
                  return (
                    <li key={account.id}>
                      <div>
                        <strong>
                          {account.platform === "x"
                            ? `X · @${account.handle ?? account.externalUserId}`
                            : `Pixiv · ${account.externalUserId}`}
                        </strong>
                        <small>已解绑；原有候选及作品来源保留</small>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={occupied || action.busy}
                        title={occupied ? "请先解绑当前同平台账号" : undefined}
                        onClick={() =>
                          void action.run(async () => {
                            await unwrap(
                              await client.POST(
                                "/api/authors/{authorId}/accounts/{id}/restore",
                                {
                                  params: {
                                    path: { authorId, id: account.id },
                                  },
                                  body: { expectedRevision: account.revision },
                                },
                              ),
                            );
                            await refresh();
                            action.setSuccess(
                              "关联已恢复，抓取保持关闭，需要重新开启账号和抓取通道",
                            );
                          })
                        }
                      >
                        恢复关联
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="workspace-muted">没有已解绑账号。</p>
            )}
          </OptionalSection>
        </>
      )}
      {editor && (
        <AccountEditor
          authorId={authorId}
          account={editor.account}
          platform={editor.platform}
          capabilities={capabilities.error ? undefined : capabilities.data}
          capabilityError={capabilities.error}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await refresh();
            setEditor(null);
            action.setSuccess("平台账号已保存");
          }}
        />
      )}
      {removing && (
        <UnbindDialog
          account={removing}
          authorId={authorId}
          onClose={() => setRemoving(null)}
          onRemoved={async () => {
            await refresh();
            setRemoving(null);
            action.setSuccess("账号已解绑，历史来源已保留");
          }}
        />
      )}
    </Surface>
  );
}

function AccountEditor({
  authorId,
  platform,
  account,
  capabilities,
  capabilityError,
  onClose,
  onSaved,
}: {
  authorId: string;
  platform: "x" | "pixiv";
  account?: Account;
  capabilities?: Capability[];
  capabilityError: Error | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useAction();
  const [handle, setHandle] = useState(account?.handle ?? "");
  const [externalUserId, setId] = useState(account?.externalUserId ?? "");
  const [nickname, setNickname] = useState(account?.displayNameSnapshot ?? "");
  const [profile, setProfile] = useState<Profile | null>(null);
  const collectionModes = [
    ...new Set(
      (capabilities ?? [])
        .filter((item) => item.platform === platform && item.available)
        .flatMap((item) => item.supportedFirstSyncModes),
    ),
  ];
  const [fetchEnabled, setFetch] = useState(
    account?.fetchEnabled ?? (platform === "x" && collectionModes.length > 0),
  );
  const [firstSyncMode, setMode] = useState<Account["firstSyncMode"]>(
    account?.firstSyncMode ??
      (platform === "x" && collectionModes.includes("last_24_hours")
        ? "last_24_hours"
        : "none"),
  );
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const replacing = Boolean(
    account && externalUserId.trim() !== account.externalUserId,
  );
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!externalUserId.trim())
        throw new Error(
          "请先同步 X 资料；若已知稳定用户 ID，也可在高级区手动填写。",
        );
      if (replacing && !replaceConfirmed)
        throw new Error("请确认更换账号，原有来源记录将保留。");
      const collectionChanged =
        (fetchEnabled && !account?.fetchEnabled) ||
        firstSyncMode !== (account?.firstSyncMode ?? "none");
      if (
        collectionChanged &&
        (fetchEnabled || firstSyncMode !== "none") &&
        !collectionModes.includes(firstSyncMode)
      )
        throw new Error("当前没有支持所选首次同步范围的可用抓取通道");
      const fields = {
        externalUserId: externalUserId.trim(),
        handle: platform === "x" ? handle : null,
        displayNameSnapshot: nickname.trim() || null,
        fetchEnabled,
        firstSyncMode,
        ...(profile
          ? {
              avatarFileObjectId: profile.avatarFileObjectId,
              profileSyncAdapter: profile.adapterKey,
              profileSyncedAt: profile.syncedAt,
            }
          : {}),
      };
      if (account)
        await unwrap(
          await client.PATCH("/api/authors/{authorId}/accounts/{id}", {
            params: { path: { authorId, id: account.id } },
            body: { ...fields, expectedRevision: account.revision },
          }),
        );
      else
        await unwrap(
          await client.POST("/api/authors/{authorId}/accounts", {
            params: { path: { authorId } },
            body: { ...fields, platform },
          }),
        );
      await onSaved();
    });
  }
  return (
    <dialog
      ref={dialog}
      aria-label={account ? "编辑平台账号" : "关联平台账号"}
      className="workspace-business-dialog"
      onCancel={(event) => {
        if (action.busy) event.preventDefault();
        else onClose();
      }}
    >
      <header>
        <h2>
          {account ? "编辑" : "关联"} {platform === "x" ? "X" : "Pixiv"} 账号
        </h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={action.busy}
          onClick={onClose}
        >
          关闭
        </Button>
      </header>
      <form
        className="workspace-stacked-form"
        onSubmit={(event) => void save(event)}
      >
        {platform === "x" ? (
          <>
            <TextField
              label="X @账号"
              hint="输入 @ 后的名称，也可粘贴 X 主页地址。更换实际账号请同步资料或填写新的稳定 ID。"
              required
              value={handle}
              onChange={(event) => {
                setHandle(event.target.value);
                setProfile(null);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              loading={action.busy}
              disabled={!handle.trim()}
              onClick={() =>
                void action.run(async () => {
                  const result = await unwrap(
                    await client.POST("/api/authors/x-profile/resolve", {
                      body: { handle, authorId },
                    }),
                  );
                  setProfile(result);
                  setHandle(result.handle);
                  setId(result.externalUserId);
                  setNickname(result.displayName);
                  setReplaceConfirmed(false);
                  action.setSuccess("X 昵称和头像已同步，保存后生效");
                })
              }
            >
              同步昵称和头像
            </Button>
            {profile && (
              <p className="workspace-profile-sync">
                <strong>@{profile.handle}</strong>
                <span>{profile.displayName}</span>
                {profile.avatarUrl && (
                  <img src={profile.avatarUrl} alt="同步的作者头像" />
                )}
              </p>
            )}
            <OptionalSection
              label="高级：X 稳定用户 ID"
              defaultOpen={Boolean(account)}
            >
              <TextField
                label="X 稳定用户 ID"
                hint="平台分配的身份 ID，与可修改的 @账号不同。通常由同步自动获取；只有已知该 ID 时才手动填写，不要填 @名称。"
                value={externalUserId}
                onChange={(event) => {
                  setId(event.target.value);
                  setProfile(null);
                  setReplaceConfirmed(false);
                }}
              />
            </OptionalSection>
          </>
        ) : (
          <TextField
            label="Pixiv 用户 ID"
            hint="主页 https://www.pixiv.net/users/123456 中的 123456；不是登录账号名。"
            placeholder="123456"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            required
            value={externalUserId}
            onChange={(event) => {
              setId(event.target.value);
              setReplaceConfirmed(false);
            }}
          />
        )}
        <TextField
          label="平台显示昵称（可选）"
          hint="仅作为资料快照显示，不用于生成主页链接。"
          value={nickname}
          maxLength={255}
          onChange={(event) => setNickname(event.target.value)}
        />
        {(collectionModes.length > 0 || account?.fetchEnabled) && (
          <>
            <label className="account-checkbox">
              <input
                type="checkbox"
                checked={fetchEnabled}
                disabled={
                  !fetchEnabled && !collectionModes.includes(firstSyncMode)
                }
                onChange={(event) => setFetch(event.target.checked)}
              />
              启用自动抓取
            </label>
            <SelectField
              label="首次同步范围"
              value={firstSyncMode}
              disabled={collectionModes.length === 0}
              onValueChange={(value) =>
                setMode(value as Account["firstSyncMode"])
              }
            >
              {!collectionModes.includes(firstSyncMode) && (
                <option value={firstSyncMode} disabled>
                  {firstSyncModeLabels[firstSyncMode]}
                  （当前不可用）
                </option>
              )}
              {collectionModes.includes("none") && (
                <option value="none">{firstSyncModeLabels.none}</option>
              )}
              {collectionModes.includes("last_7_days") && (
                <option value="last_7_days">
                  {firstSyncModeLabels.last_7_days}
                </option>
              )}
              {collectionModes.includes("last_24_hours") && (
                <option value="last_24_hours">
                  {firstSyncModeLabels.last_24_hours}
                </option>
              )}
            </SelectField>
          </>
        )}
        {replacing && (
          <label className="account-checkbox">
            <input
              type="checkbox"
              required
              checked={replaceConfirmed}
              onChange={(event) => setReplaceConfirmed(event.target.checked)}
            />
            确认更换平台身份：旧关联及来源保留，新账号从新的抓取范围开始。
          </label>
        )}
        <Feedback
          error={action.error || capabilityError?.message}
          success={action.success}
        />
        <Button type="submit" loading={action.busy}>
          保存账号
        </Button>
      </form>
    </dialog>
  );
}

function UnbindDialog({
  account,
  authorId,
  onClose,
  onRemoved,
}: {
  account: Account;
  authorId: string;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useAction();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label="确认解绑账号"
      className="workspace-business-dialog"
      onCancel={(event) => {
        if (action.busy) event.preventDefault();
        else onClose();
      }}
    >
      <header>
        <h2>
          解绑{" "}
          {account.platform === "x"
            ? `X @${account.handle ?? account.externalUserId}`
            : `Pixiv ${account.externalUserId}`}
        </h2>
      </header>
      <p>
        解绑会停止该账号抓取。已有候选、作品及来源记录保留，可在“已解绑账号”中恢复关联。
      </p>
      <Feedback error={action.error} success={action.success} />
      <div className="workspace-dialog-actions">
        <Button variant="ghost" disabled={action.busy} onClick={onClose}>
          取消
        </Button>
        <Button
          loading={action.busy}
          onClick={() =>
            void action.run(async () => {
              await unwrap(
                await client.DELETE("/api/authors/{authorId}/accounts/{id}", {
                  params: { path: { authorId, id: account.id } },
                  body: { expectedRevision: account.revision },
                }),
              );
              await onRemoved();
            })
          }
        >
          确认解绑
        </Button>
      </div>
    </dialog>
  );
}
