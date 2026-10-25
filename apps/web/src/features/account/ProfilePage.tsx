import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Palette, UserRound, KeyRound, X } from "lucide-react";
import {
  Button,
  IconButton,
  SelectField,
  TextField,
} from "../../components/ui";
import {
  applyTheme,
  defaultTheme,
  isHexColor,
  readTheme,
  themePresets,
  themeStorageKey,
  type ThemeStyle,
} from "../../styles/theme";
import { useAccount } from "./account-context";
import { client, queryClient, unwrap } from "./api";
import { Feedback } from "./forms";
import { useSettingsNavigation } from "./settings-routing";
import { AvatarSettings } from "./AvatarSettings";
import { refreshMemberProfile } from "./profile-cache";
import { useAction } from "./use-action";

const profileSchema = z.object({
  displayName: z.string().trim().min(1, "请输入成员昵称").max(100),
});
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "请输入当前密码").max(128),
    newPassword: z.string().min(12, "新密码至少 12 个字符").max(128),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "两次新密码不一致",
  });

function SettingsFrame({
  children,
  canClose = true,
}: {
  children: ReactNode;
  canClose?: boolean;
}) {
  const { close } = useSettingsNavigation();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (canClose) close();
      }}
      className="ui-surface workspace-settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-settings-title"
    >
      <header className="workspace-settings-heading">
        <div>
          <span>偏好与账号</span>
          <h1 id="workspace-settings-title">设置</h1>
        </div>
        {canClose && (
          <IconButton label="关闭设置" onClick={close}>
            <X size={18} />
          </IconButton>
        )}
      </header>
      {canClose && (
        <nav className="workspace-settings-tabs" aria-label="设置分类">
          <Link to="/settings?tab=appearance">
            <Palette size={16} />
            外观
          </Link>
          <Link to="/settings?tab=profile">
            <UserRound size={16} />
            个人资料
          </Link>
          <Link to="/settings/password">
            <KeyRound size={16} />
            修改密码
          </Link>
        </nav>
      )}
      <div className="workspace-settings-body">{children}</div>
    </dialog>
  );
}

function AppearanceSettings() {
  const [theme, setTheme] = useState(() =>
    readTheme(localStorage.getItem(themeStorageKey)),
  );
  const [draft, setDraft] = useState(theme.brand);
  function choose(next: { brand: string; style: ThemeStyle }) {
    setTheme(next);
    setDraft(next.brand);
    applyTheme(next);
  }
  return (
    <section className="settings-pane">
      <div>
        <h2>外观</h2>
        <p>品牌色会自动派生界面色阶，工作流状态色保持独立。</p>
      </div>
      <div
        className="workspace-theme-presets"
        role="group"
        aria-label="主题预设"
      >
        {themePresets.map((preset) => (
          <button
            type="button"
            key={preset.name}
            aria-pressed={
              theme.brand === preset.brand && theme.style === preset.style
            }
            onClick={() => choose(preset)}
          >
            <span style={{ background: preset.brand }} />
            <strong>{preset.name}</strong>
          </button>
        ))}
      </div>
      <div className="account-form-row">
        <TextField
          label="自定义品牌色"
          value={draft}
          error={!isHexColor(draft) ? "请输入 # 加六位十六进制色值" : undefined}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            if (isHexColor(value))
              choose({ ...theme, brand: value.toLowerCase() });
          }}
        />
        <SelectField
          label="界面风格"
          value={theme.style}
          onValueChange={(value) =>
            choose({ ...theme, style: value as ThemeStyle })
          }
        >
          <option value="soft">柔彩</option>
          <option value="minimal">黑白极简</option>
        </SelectField>
      </div>
      <Button variant="secondary" onClick={() => choose({ ...defaultTheme })}>
        恢复默认
      </Button>
    </section>
  );
}

export function ProfilePage() {
  const user = useAccount();
  const action = useAction();
  const [params] = useSearchParams();
  const tab = params.get("tab") ?? "appearance";
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      displayName: user.displayName,
    },
  });
  if (tab === "appearance")
    return (
      <SettingsFrame>
        <AppearanceSettings />
      </SettingsFrame>
    );
  return (
    <SettingsFrame>
      <section className="settings-pane">
        <div>
          <h2>个人资料</h2>
          <p>资料修改不会改变已经冻结的历史署名。</p>
        </div>
        <AvatarSettings />
        <form
          className="account-form"
          onSubmit={handleSubmit((values) =>
            action.run(async () => {
              const updated = await unwrap(
                await client.PATCH("/api/users/me", { body: values }),
              );
              await refreshMemberProfile(updated);
              action.setSuccess("个人资料已保存");
            }),
          )}
        >
          <TextField
            label="账户名"
            value={user.username}
            readOnly
            hint="仅用于登录，创建后固定，不作为署名展示。"
          />
          <TextField
            label="成员昵称"
            {...register("displayName")}
            error={errors.displayName?.message}
            hint="这是团队内昵称，也是参与作品时的默认署名。"
          />
          <Feedback error={action.error} success={action.success} />
          <Button type="submit" loading={action.busy}>
            保存资料
          </Button>
        </form>
        <Button
          variant="secondary"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await unwrap(
                await client.POST("/api/auth/revoke-others", { body: {} }),
              );
              action.setSuccess("其他浏览器的登录会话已退出");
            })
          }
        >
          退出其他登录会话
        </Button>
      </section>
    </SettingsFrame>
  );
}

export function PasswordPage() {
  const user = useAccount();
  const action = useAction();
  const navigate = useNavigate();
  const { close } = useSettingsNavigation();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(passwordSchema) });
  return (
    <SettingsFrame canClose={!user.mustChangePassword}>
      <section className="settings-pane">
        <div>
          <h2>{user.mustChangePassword ? "设置你自己的密码" : "修改密码"}</h2>
          <p>
            {user.mustChangePassword
              ? "当前使用的是临时密码。完成修改后，即可进入团队工作空间。"
              : "修改成功后，其他浏览器的旧登录会话会退出。"}
          </p>
        </div>
        <form
          className="account-form"
          onSubmit={handleSubmit((values) =>
            action.run(async () => {
              const updated = await unwrap(
                await client.POST("/api/auth/password", {
                  body: {
                    currentPassword: values.currentPassword,
                    newPassword: values.newPassword,
                  },
                }),
              );
              reset();
              if (user.mustChangePassword) queryClient.clear();
              queryClient.setQueryData(["me"], updated);
              if (user.mustChangePassword) navigate("/", { replace: true });
              else close();
            }),
          )}
        >
          <input
            type="hidden"
            name="username"
            autoComplete="username"
            value={user.username}
          />
          <TextField
            label={
              user.mustChangePassword ? "管理员提供的临时密码" : "当前密码"
            }
            type="password"
            autoComplete="current-password"
            {...register("currentPassword")}
            error={errors.currentPassword?.message}
          />
          <TextField
            label="新密码"
            type="password"
            autoComplete="new-password"
            {...register("newPassword")}
            error={errors.newPassword?.message}
            hint="使用至少 12 个字符的密码或口令，最多 128 个字符。"
          />
          <TextField
            label="再次输入新密码"
            type="password"
            autoComplete="new-password"
            {...register("confirmPassword")}
            error={errors.confirmPassword?.message}
          />
          <Feedback error={action.error} />
          <Button type="submit" loading={action.busy}>
            确认修改密码
          </Button>
        </form>
      </section>
    </SettingsFrame>
  );
}
