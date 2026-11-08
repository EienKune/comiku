import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Button, Surface, TextField } from "../../components/ui";
import { OptionalSection } from "../../components/OptionalSection";
import { PlatformLinks } from "../../components/PlatformLinks";
import { useAccount } from "../account/account-context";
import { client, queryClient, unwrap } from "../account/api";
import { Feedback } from "../account/forms";
import { useAction } from "../account/use-action";
import { useAuthorCollection } from "./author-collection";
import { AuthorCollectionFields } from "./AuthorCollectionFields";
import { preserveProfileAvatar } from "./profile-avatar";
import { canonicalXHandle } from "./x-account-handle";

type Account = components["schemas"]["ExternalAccountDto"];
type Summary = components["schemas"]["ExternalAccountSummaryDto"];
type Profile =
  | components["schemas"]["ResolvedXProfileDto"]
  | components["schemas"]["ResolvedPixivProfileDto"];
type Capability = components["schemas"]["SourceCapabilityDto"];

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
        "managed-author",
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
                  {managed?.notes && (
                    <p className="workspace-management-note">{managed.notes}</p>
                  )}
                  {hasCollection && managed && (
                    <small>
                      {managed.fetchEnabled
                        ? "自动抓取已启用"
                        : "自动抓取已暂停"}
                    </small>
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
                        {account.notes && (
                          <p className="workspace-management-note">
                            {account.notes}
                          </p>
                        )}
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
          capabilityPending={capabilities.isPending}
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
  capabilityPending,
  onClose,
  onSaved,
}: {
  authorId: string;
  platform: "x" | "pixiv";
  account?: Account;
  capabilities?: Capability[];
  capabilityError: Error | null;
  capabilityPending: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useAction();
  const [handle, setHandle] = useState(account?.handle ?? "");
  const [externalUserId, setId] = useState(account?.externalUserId ?? "");
  const pixivInput = useRef(account?.externalUserId ?? "");
  const [nickname, setNickname] = useState(account?.displayNameSnapshot ?? "");
  const [notes, setNotes] = useState(account?.notes ?? "");
  const [profile, setProfile] = useState<Profile | null>(null);
  const collection = useAuthorCollection(platform, capabilities, account);
  const { fetchEnabled, firstSyncMode } = collection.value;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      if (!account && capabilityPending)
        throw new Error("采集设置仍在读取，请稍后保存");
      if (platform === "pixiv" && !/^[1-9][0-9]*$/.test(externalUserId.trim()))
        throw new Error("Pixiv 用户 ID 必须是主页 /users/ 后的数字");
      if (!externalUserId.trim())
        throw new Error("请先同步 X 资料，获取可信平台身份。");
      const canonicalHandle =
        platform === "x" && handle.trim() ? canonicalXHandle(handle) : null;
      const handleChanged =
        platform === "x" &&
        (canonicalHandle?.toLowerCase() ?? null) !==
          (account?.handle
            ? canonicalXHandle(account.handle).toLowerCase()
            : null);
      if (
        platform === "x" &&
        (!account ||
          handleChanged ||
          (fetchEnabled && !account.fetchEnabled)) &&
        !profile
      )
        throw new Error("请先同步 X 资料后保存账号。");
      collection.validate();
      collection.freeze();
      const profileChanged =
        !account ||
        handleChanged ||
        (fetchEnabled && !account.fetchEnabled) ||
        Boolean(profile?.avatarFileObjectId);
      const fields = {
        handle: canonicalHandle,
        displayNameSnapshot: nickname.trim() || null,
        notes: notes.trim() || null,
        fetchEnabled,
        firstSyncMode,
        ...(profile &&
        profileChanged &&
        (platform === "x" || profile.externalUserId === externalUserId.trim())
          ? {
              avatarFileObjectId: profile.avatarFileObjectId,
              profileSyncAdapter: profile.adapterKey,
              profileSyncedAt: profile.syncedAt,
              profileProof: profile.profileProof,
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
            body: {
              ...fields,
              platform,
              externalUserId: externalUserId.trim(),
            },
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
              disabled={action.busy}
              hint="输入 @ 后的名称，也可粘贴 X 主页地址。"
              required={!account}
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
                      body: {
                        handle,
                        authorId,
                        ...(account &&
                        handle.toLowerCase() ===
                          (account.handle ?? "").toLowerCase()
                          ? { accountId: account.id }
                          : {}),
                      },
                    }),
                  );
                  if (
                    account &&
                    result.externalUserId !== account.externalUserId
                  )
                    throw new Error(
                      "同步结果属于不同的 X 账号，请通过新建入口关联新账号。",
                    );
                  setProfile((current) =>
                    preserveProfileAvatar(current, result),
                  );
                  setHandle(result.handle);
                  setId(result.externalUserId);
                  setNickname(result.displayName);
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
                disabled={action.busy}
                hint="由平台资料同步获取，关联后不可修改。"
                value={externalUserId}
                readOnly
              />
            </OptionalSection>
          </>
        ) : (
          <>
            <TextField
              label="Pixiv 用户 ID"
              disabled={action.busy}
              hint="主页 https://www.pixiv.net/users/123456 中的 123456；不是登录账号名。"
              placeholder="123456"
              inputMode="numeric"
              pattern="[1-9][0-9]*"
              required
              value={externalUserId}
              readOnly={Boolean(account)}
              onChange={(event) => {
                pixivInput.current = event.target.value;
                setId(event.target.value);
                setProfile(null);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              aria-label="同步 Pixiv 昵称和头像"
              loading={action.busy}
              disabled={
                action.busy || !/^[1-9][0-9]*$/.test(externalUserId.trim())
              }
              onClick={() =>
                void action.run(async () => {
                  const requestedId = externalUserId.trim();
                  const result = await unwrap(
                    await client.POST("/api/authors/pixiv-profile/resolve", {
                      body: {
                        externalUserId: requestedId,
                        authorId,
                        ...(account ? { accountId: account.id } : {}),
                      },
                    }),
                  );
                  if (
                    pixivInput.current.trim() !== requestedId ||
                    result.externalUserId !== requestedId ||
                    (account &&
                      result.externalUserId !== account.externalUserId)
                  )
                    throw new Error(
                      "Pixiv 用户 ID 已变化或同步结果不匹配，请重新同步。",
                    );
                  setProfile((current) =>
                    preserveProfileAvatar(current, { ...result, handle: null }),
                  );
                  setNickname(result.displayName);
                  action.setSuccess("Pixiv 昵称和头像已同步，保存后生效");
                })
              }
            >
              同步昵称和头像
            </Button>
            {profile && (
              <p className="workspace-profile-sync">
                <strong>{profile.externalUserId}</strong>
                <span>{profile.displayName}</span>
                {profile.avatarUrl && (
                  <img src={profile.avatarUrl} alt="同步的 Pixiv 头像" />
                )}
              </p>
            )}
          </>
        )}
        <TextField
          label="平台显示昵称（可选）"
          disabled={action.busy}
          hint="仅作为资料快照显示，不用于生成主页链接。"
          value={nickname}
          maxLength={255}
          onChange={(event) => setNickname(event.target.value)}
        />
        <label className="ui-field">
          <span className="ui-field__label">账号备注（可选）</span>
          <span className="ui-field__control">
            <textarea
              rows={3}
              disabled={action.busy}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </span>
        </label>
        <AuthorCollectionFields
          value={collection.value}
          modes={collection.modes}
          onChange={collection.change}
          disabled={action.busy}
        />
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
