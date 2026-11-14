import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import { Palette, UserRound, KeyRound } from "lucide-react";
import { Button, SelectField, Surface, TextField } from "../../components/ui";
import { isHexColor, themePresets, type ThemeStyle } from "../../styles/theme";
import { useSite } from "../site/site-context";
import { resolveTheme, siteTheme } from "../site/theme-selection";
import { useAccount } from "./account-context";
import { client, queryClient, unwrap, clearAccountCache } from "./api";
import { Feedback, SectionHeading } from "./forms";
import { AvatarSettings } from "./AvatarSettings";
import { refreshMemberProfile } from "./profile-cache";
import { useAction } from "./use-action";
import { loginReturnTarget } from "./login-return";
import { QqBindingSettings } from "./QqBindingSettings";

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
  showNavigation = true,
}: {
  children: ReactNode;
  showNavigation?: boolean;
}) {
  const location = useLocation();
  const [params] = useSearchParams();
  const active = location.pathname.endsWith("/password")
    ? "password"
    : params.get("tab") === "profile"
      ? "profile"
      : "appearance";
  return (
    <>
      <SectionHeading title={showNavigation ? "个人设置" : "设置密码"} />
      {showNavigation && (
        <nav className="account-settings-tabs" aria-label="个人设置分类">
          <Link
            to="/settings?tab=appearance"
            aria-current={active === "appearance" ? "page" : undefined}
          >
            <Palette size={16} />
            外观
          </Link>
          <Link
            to="/settings?tab=profile"
            aria-current={active === "profile" ? "page" : undefined}
          >
            <UserRound size={16} />
            个人资料
          </Link>
          <Link
            to="/settings/password"
            aria-current={active === "password" ? "page" : undefined}
          >
            <KeyRound size={16} />
            修改密码
          </Link>
        </nav>
      )}
      <Surface className="account-card account-settings-page">
        {children}
      </Surface>
    </>
  );
}

function AppearanceSettings() {
  const { settings, selection, selectTheme } = useSite();
  const theme = resolveTheme(selection, siteTheme(settings.themePresetId));
  const [draft, setDraft] = useState<string>();
  function choose(next: { brand: string; style: ThemeStyle }) {
    setDraft(undefined);
    selectTheme({
      mode: "custom",
      theme: { brand: next.brand, style: next.style },
    });
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
          value={draft ?? theme.brand}
          error={
            !isHexColor(draft ?? theme.brand)
              ? "请输入 # 加六位十六进制色值"
              : undefined
          }
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
      <Button
        variant="secondary"
        aria-pressed={selection.mode === "site"}
        onClick={() => {
          setDraft(undefined);
          selectTheme({ mode: "site" });
        }}
      >
        跟随站点
      </Button>
    </section>
  );
}

export function ProfilePage() {
  const user = useAccount();
  const action = useAction();
  const [params] = useSearchParams();
  const tab = params.get("tab") ?? "appearance";
  const location = useLocation();
  useEffect(() => {
    if (tab === "profile" && location.hash === "#qq-binding")
      document
        .getElementById("qq-binding")
        ?.scrollIntoView({ block: "center" });
  }, [tab, location.hash]);
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
  if (tab === "qq") {
    const next = new URLSearchParams(params);
    next.set("tab", "profile");
    return <Navigate to={`/settings?${next.toString()}#qq-binding`} replace />;
  }
  if (tab !== "profile")
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
          {!user.roles.length && (
            <p role="status">账号已注册，等待管理员分配职责。</p>
          )}
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
        <div id="qq-binding">
          <QqBindingSettings />
        </div>
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
  const location = useLocation();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(passwordSchema) });
  return (
    <SettingsFrame showNavigation={!user.mustChangePassword}>
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
              if (user.mustChangePassword) clearAccountCache();
              queryClient.setQueryData(["me"], updated);
              if (user.mustChangePassword)
                navigate(
                  updated.roles.length
                    ? loginReturnTarget(location.state)
                    : "/settings?tab=profile",
                  { replace: true },
                );
              else action.setSuccess("密码已更新");
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
          <Feedback error={action.error} success={action.success} />
          <Button type="submit" loading={action.busy}>
            确认修改密码
          </Button>
        </form>
      </section>
    </SettingsFrame>
  );
}
