import { MemberAvatar } from "./MemberAvatar";
import { useAction } from "./use-action";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { CurrentUser, Role, components } from "@comiku/api-client";
import { Button, Surface, TextField, Badge } from "../../components/ui";
import { useAccount } from "./account-context";
import { client, queryClient, unwrap, useRoles } from "./api";
import { ErrorState, Feedback, LoadingState, SectionHeading } from "./forms";

type Credential = components["schemas"]["CredentialDto"];
type RoleOption = components["schemas"]["RoleOptionDto"];
type LanguageCapability = components["schemas"]["LanguageCapability"];
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="account-dialog"
      aria-labelledby="account-dialog-title"
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ) ?? [],
        ).filter((node) => node.offsetParent !== null);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className="account-dialog-heading">
        <h2 id="account-dialog-title">{title}</h2>
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </div>
      {children}
    </dialog>
  );
}
function RoleFields({
  roles,
  selected,
  toggle,
}: {
  roles: RoleOption[];
  selected: string[];
  toggle: (value: Role) => void;
}) {
  return (
    <fieldset className="account-role-fields">
      <legend>职务（可多选）</legend>
      {roles.map((role) => (
        <label key={role.value}>
          <input
            type="checkbox"
            checked={selected.includes(role.value)}
            onChange={() => toggle(role.value)}
          />
          {role.label}
        </label>
      ))}
    </fieldset>
  );
}
function LanguageFields({
  selected,
  toggle,
}: {
  selected: LanguageCapability[];
  toggle: (value: LanguageCapability) => void;
}) {
  return (
    <fieldset className="account-role-fields">
      <legend>翻译语言能力（可多选）</legend>
      {(
        [
          ["ja", "日语"],
          ["ko", "韩语"],
        ] as const
      ).map(([value, label]) => (
        <label key={value}>
          <input
            type="checkbox"
            checked={selected.includes(value)}
            onChange={() => toggle(value)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
const createSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]{3,64}$/, "账户名仅可使用 3–64 位英文字母和数字"),
  displayName: z.string().trim().min(1, "请输入成员昵称").max(100),
  roles: z.array(z.string()).min(1, "至少选择一个职务"),
  languageCapabilities: z.array(z.enum(["ja", "ko"])),
  canSkipProofreading: z.boolean(),
  currentPassword: z.string().min(1, "请输入当前管理员密码").max(128),
});
function CreateAccount({
  roles,
  onCreated,
}: {
  roles: RoleOption[];
  onCreated: (credential: Credential) => void;
}) {
  const action = useAction();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(createSchema),
    defaultValues: {
      username: "",
      displayName: "",
      currentPassword: "",
      roles: [] as string[],
      languageCapabilities: [] as LanguageCapability[],
      canSkipProofreading: false,
    },
  });
  const selected = watch("roles");
  const selectedLanguages = watch("languageCapabilities");
  return (
    <Surface className="account-card account-content-boundary">
      <h2>分发新账号</h2>
      <p>系统生成临时密码。请私下交付给成员，成员登录后需更换密码。</p>
      <form
        className="account-form"
        onSubmit={handleSubmit((values) =>
          action.run(async () => {
            const result = await unwrap(
              await client.POST("/api/users", {
                body: {
                  ...values,
                  roles: values.roles as Role[],
                  languageCapabilities: values.languageCapabilities,
                },
              }),
            );
            reset();
            onCreated(result);
            await queryClient.invalidateQueries();
          }),
        )}
      >
        <div className="account-form-row">
          <TextField
            label="账户名"
            autoComplete="off"
            {...register("username")}
            error={errors.username?.message}
            hint="仅用于登录，创建后固定；字母会统一转为小写。"
          />
          <TextField
            label="成员昵称"
            {...register("displayName")}
            error={errors.displayName?.message}
          />
        </div>
        <RoleFields
          roles={roles}
          selected={selected}
          toggle={(role) =>
            setValue(
              "roles",
              selected.includes(role)
                ? selected.filter((r) => r !== role)
                : [...selected, role],
              { shouldValidate: true },
            )
          }
        />
        <Feedback error={errors.roles?.message} />
        <LanguageFields
          selected={selectedLanguages}
          toggle={(language) =>
            setValue(
              "languageCapabilities",
              selectedLanguages.includes(language)
                ? selectedLanguages.filter((item) => item !== language)
                : [...selectedLanguages, language],
            )
          }
        />
        <TextField
          label="确认当前管理员密码"
          type="password"
          autoComplete="current-password"
          {...register("currentPassword")}
          error={errors.currentPassword?.message}
        />
        <Feedback error={action.error} />
        <label className="account-checkbox">
          <input type="checkbox" {...register("canSkipProofreading")} />
          免校对资格
        </label>
        <Button type="submit" loading={action.busy}>
          创建并显示临时密码
        </Button>
      </form>
    </Surface>
  );
}
function ManageAccount({
  user,
  roles,
  onClose,
}: {
  user: CurrentUser;
  roles: RoleOption[];
  onClose: () => void;
}) {
  const action = useAction();
  const [selected, setSelected] = useState<Role[]>(user.roles);
  const [selectedLanguages, setSelectedLanguages] = useState<
    LanguageCapability[]
  >(user.languageCapabilities);
  const [active, setActive] = useState(user.isActive);
  const [canSkipProofreading, setCanSkipProofreading] = useState(
    user.canSkipProofreading,
  );
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(
      z.object({
        displayName: z.string().trim().min(1, "请输入成员昵称").max(100),
        currentPassword: z.string().min(1, "请输入当前管理员密码").max(128),
      }),
    ),
    defaultValues: {
      displayName: user.displayName,
      currentPassword: "",
    },
  });
  return (
    <Dialog title={`管理账号 · ${user.username}`} onClose={onClose}>
      <form
        className="account-form"
        onSubmit={handleSubmit((values) =>
          action.run(async () => {
            await unwrap(
              await client.PATCH("/api/users/{id}", {
                params: { path: { id: user.id } },
                body: {
                  ...values,
                  roles: selected,
                  languageCapabilities: selectedLanguages,
                  isActive: active,
                  canSkipProofreading,
                  expectedRevision: user.revision,
                },
              }),
            );
            await queryClient.invalidateQueries();
            onClose();
          }),
        )}
      >
        <TextField
          label="成员昵称"
          {...register("displayName")}
          error={errors.displayName?.message}
          hint="团队内昵称，同时作为该成员参与作品时的默认署名。"
        />
        <RoleFields
          roles={roles}
          selected={selected}
          toggle={(role) =>
            setSelected(
              selected.includes(role)
                ? selected.filter((r) => r !== role)
                : [...selected, role],
            )
          }
        />
        <LanguageFields
          selected={selectedLanguages}
          toggle={(language) =>
            setSelectedLanguages(
              selectedLanguages.includes(language)
                ? selectedLanguages.filter((item) => item !== language)
                : [...selectedLanguages, language],
            )
          }
        />
        <label className="account-checkbox">
          <input
            type="checkbox"
            checked={canSkipProofreading}
            onChange={(event) => setCanSkipProofreading(event.target.checked)}
          />
          免校对资格
        </label>
        <label className="account-checkbox">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          启用账号
        </label>
        {!active && <p>停用后，成员的所有登录会话会失效，历史贡献会保留。</p>}
        {!selected.length && (
          <p>未分配职务的成员只能管理自己的凭据，无法访问团队业务数据。</p>
        )}
        <TextField
          label="确认当前管理员密码"
          type="password"
          autoComplete="current-password"
          {...register("currentPassword")}
          error={errors.currentPassword?.message}
        />
        <Feedback error={action.error} />
        <Button type="submit" loading={action.busy}>
          确认保存账号变更
        </Button>
      </form>
    </Dialog>
  );
}
function ConfirmAccountAction({
  user,
  kind,
  onClose,
  onCredential,
}: {
  user: CurrentUser;
  kind: "reset" | "revoke";
  onClose: () => void;
  onCredential: (credential: Credential) => void;
}) {
  const action = useAction();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(
      z.object({
        currentPassword: z.string().min(1, "请输入当前管理员密码").max(128),
      }),
    ),
  });
  return (
    <Dialog
      title={`${kind === "reset" ? "重置密码" : "撤销会话"} · ${user.username}`}
      onClose={onClose}
    >
      <p>
        {kind === "reset"
          ? "此账号的旧密码与全部登录会话将失效。请将新的临时密码重新交付给成员。"
          : "此账号在所有浏览器中的登录会话将失效，成员可使用现有密码重新登录。"}
      </p>
      <form
        className="account-form"
        onSubmit={handleSubmit((values) =>
          action.run(async () => {
            if (kind === "reset") {
              const credential = await unwrap(
                await client.POST("/api/users/{id}/reset-password", {
                  params: { path: { id: user.id } },
                  body: values,
                }),
              );
              onClose();
              onCredential(credential);
            } else {
              await unwrap(
                await client.POST("/api/users/{id}/revoke-sessions", {
                  params: { path: { id: user.id } },
                  body: values,
                }),
              );
              onClose();
            }
            await queryClient.invalidateQueries();
          }),
        )}
      >
        <TextField
          label="确认当前管理员密码"
          type="password"
          autoComplete="current-password"
          {...register("currentPassword")}
          error={errors.currentPassword?.message}
        />
        <Feedback error={action.error} />
        <Button type="submit" variant="danger" loading={action.busy}>
          确认{kind === "reset" ? "重置密码" : "撤销会话"}
        </Button>
      </form>
    </Dialog>
  );
}
function CredentialDialog({
  credential,
  onClose,
}: {
  credential: Credential;
  onClose: () => void;
}) {
  const action = useAction();
  return (
    <Dialog title="临时密码已生成" onClose={onClose}>
      <p>
        账户名：<strong>{credential.user.username}</strong>
      </p>
      <p>临时密码仅显示这一次，请安全交付。关闭后无法再次查询。</p>
      <code className="account-credential">{credential.temporaryPassword}</code>
      <Button
        variant="secondary"
        onClick={() =>
          void action.run(async () => {
            await navigator.clipboard.writeText(
              `账户名：${credential.user.username}\n临时密码：${credential.temporaryPassword}`,
            );
            action.setSuccess("已复制，请私下交付给成员");
          })
        }
      >
        复制账号信息
      </Button>
      <Feedback error={action.error} success={action.success} />
    </Dialog>
  );
}
export function AccountsPage() {
  const me = useAccount();
  const allowed = me.permissions.includes("accounts:manage");
  const roles = useRoles(allowed);
  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => unwrap(await client.GET("/api/users")),
    enabled: allowed,
  });
  const [editing, setEditing] = useState<CurrentUser | null>(null);
  const [confirmation, setConfirmation] = useState<{
    user: CurrentUser;
    kind: "reset" | "revoke";
  } | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  if (!allowed)
    return (
      <SectionHeading title="无权访问">账号管理仅向管理员开放。</SectionHeading>
    );
  if (roles.isPending || users.isPending) return <LoadingState />;
  if (roles.isError || users.isError)
    return (
      <ErrorState
        retry={() => {
          void roles.refetch();
          void users.refetch();
        }}
      />
    );
  const roleNames = (values: Role[]) =>
    roles.data
      .filter((r) => values.includes(r.value))
      .map((r) => r.label)
      .join("、");
  return (
    <>
      <SectionHeading title="账号管理">
        由管理员统一分发账号。重要操作需要确认当前管理员密码，并写入账号审计。
      </SectionHeading>
      <CreateAccount roles={roles.data} onCreated={setCredential} />
      <Surface className="account-card account-content-boundary">
        <h2>团队账号 · {users.data.length}</h2>
        <div className="account-table-wrap">
          <table className="account-table">
            <caption className="sr-only">团队账号及操作</caption>
            <thead>
              <tr>
                <th>成员</th>
                <th>职务</th>
                <th>语言能力</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.displayName}</strong>
                    <small>
                      {user.username}
                      {user.id === me.id && " · 你"}
                    </small>
                  </td>
                  <td>{roleNames(user.roles) || "未分配"}</td>
                  <td>
                    {user.languageCapabilities
                      .map((language) => (language === "ja" ? "日语" : "韩语"))
                      .join("、") || "英语基础"}
                  </td>
                  <td>
                    <Badge tone={user.isActive ? "success" : "neutral"}>
                      {user.isActive ? "启用" : "停用"}
                    </Badge>
                    {user.mustChangePassword && <small>待更换临时密码</small>}
                  </td>
                  <td>
                    <div className="account-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing(user)}
                      >
                        管理
                      </Button>
                      {user.id !== me.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setConfirmation({ user, kind: "reset" })
                          }
                        >
                          重置密码
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setConfirmation({ user, kind: "revoke" })
                        }
                      >
                        撤销会话
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>
      <AuditPanel />
      {editing && (
        <ManageAccount
          user={editing}
          roles={roles.data}
          onClose={() => setEditing(null)}
        />
      )}
      {confirmation && (
        <ConfirmAccountAction
          {...confirmation}
          onClose={() => setConfirmation(null)}
          onCredential={setCredential}
        />
      )}
      {credential && (
        <CredentialDialog
          credential={credential}
          onClose={() => setCredential(null)}
        />
      )}
    </>
  );
}
const auditLabels: Record<string, string> = {
  "auth.login": "登录",
  "auth.login_failed": "登录失败",
  "auth.logout": "退出登录",
  "auth.password_changed": "修改密码",
  "auth.revoke_other_sessions": "退出其他会话",
  "account.created": "创建账号",
  "account.managed": "变更账号",
  "account.password_reset": "重置密码",
  "account.sessions_revoked": "撤销会话",
  "account.profile_updated": "修改资料",
  "account.avatar_updated": "修改头像",
  "account.avatar_removed": "移除头像",
  "account.admin_initialized": "初始化管理员",
  "account.admin_recovered": "服务器恢复管理员",
};
function AuditPanel() {
  const query = useQuery({
    queryKey: ["audit"],
    queryFn: async () => unwrap(await client.GET("/api/users/audit")),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => unwrap(await client.GET("/api/users")),
  });
  return (
    <Surface className="account-card account-content-boundary">
      <h2>最近账号审计</h2>
      <p>显示最近 100 条记录。密码与会话令牌不会记录在这里。</p>
      {query.isPending ? (
        <p role="status">加载中…</p>
      ) : query.isError ? (
        <ErrorState retry={() => void query.refetch()} />
      ) : (
        <ul className="account-audit">
          {query.data.map((item) => (
            <li key={item.id}>
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
              <strong>{auditLabels[item.action] ?? item.action}</strong>
              <span>
                {users.data?.find((u) => u.id === item.actorId)?.displayName ??
                  (item.actorId ? "历史成员" : "系统/未登录")}{" "}
                →{" "}
                {users.data?.find((u) => u.id === item.targetId)?.displayName ??
                  "未知账号"}
              </span>
              {Object.keys(item.detail).length > 0 && (
                <details>
                  <summary>变更详情</summary>
                  <pre>{JSON.stringify(item.detail, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
export function MembersPage() {
  const user = useAccount();
  const enabled = user.permissions.includes("members:read");
  const roles = useRoles(enabled);
  const members = useQuery({
    queryKey: ["members"],
    queryFn: async () => unwrap(await client.GET("/api/users/members")),
    enabled,
  });
  if (!enabled)
    return (
      <SectionHeading title="尚未分配职务">
        请联系管理员开通团队访问权限。
      </SectionHeading>
    );
  if (members.isPending || roles.isPending) return <LoadingState />;
  if (members.isError || roles.isError)
    return (
      <ErrorState
        retry={() => {
          void members.refetch();
          void roles.refetch();
        }}
      />
    );
  return (
    <>
      <SectionHeading title="团队成员">
        一起完成翻译、校对与作品交付。
      </SectionHeading>
      <div className="account-member-grid account-content-boundary">
        {members.data.map((member) => (
          <Surface className="account-card" key={member.id}>
            <div className="account-actions">
              <MemberAvatar member={member} />
              <h2>{member.displayName}</h2>
            </div>
            <p>{member.username}</p>
            <div className="account-actions">
              {roles.data
                .filter((r) => member.roles.includes(r.value))
                .map((role) => (
                  <Badge key={role.value}>{role.label}</Badge>
                ))}
            </div>
          </Surface>
        ))}
      </div>
    </>
  );
}
