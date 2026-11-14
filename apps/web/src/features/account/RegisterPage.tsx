import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { SiteBrand } from "../site/SiteBrand";
import { Button, Surface, TextField } from "../../components/ui";
import { client, queryClient, unwrap, useMe, clearAccountCache } from "./api";
import { ErrorState, Feedback, LoadingState } from "./forms";
import { useAction } from "./use-action";
import { loginReturnTarget } from "./login-return";
import { CapabilityFields, type Capabilities } from "./CapabilityFields";
import { useRegistrationOptions } from "./registration-options";
import "./account.css";

const schema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]{3,64}$/, "账户名仅可使用 3–64 位英文字母和数字"),
    displayName: z.string().trim().min(1, "请输入成员昵称").max(100),
    password: z.string().min(12, "密码至少 12 个字符").max(128),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "两次密码不一致",
  });

export function RegisterPage() {
  const me = useMe();
  const options = useRegistrationOptions(!me.data);
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = loginReturnTarget(location.state);
  const action = useAction();
  const [capabilities, setCapabilities] = useState<Capabilities>({
    roles: [],
    languageCapabilities: [],
  });
  const [roleError, setRoleError] = useState("");
  const [expectedSettingsRevision, setExpectedSettingsRevision] =
    useState<number>();
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors },
  } = useForm({ resolver: zodResolver(schema) });
  if (me.isPending) return <LoadingState />;
  if (me.isError) return <ErrorState retry={() => void me.refetch()} />;
  if (me.data)
    return (
      <Navigate
        to={
          me.data.mustChangePassword
            ? "/settings/password"
            : !me.data.roles.length
              ? "/settings?tab=profile"
              : returnTo
        }
        state={me.data.mustChangePassword ? { returnTo } : undefined}
        replace
      />
    );
  const available = options.data?.enabled === true && !options.isError;
  return (
    <main className="account-login">
      <Surface className="account-login-card">
        <div className="account-brand">
          <SiteBrand />
        </div>
        <h1>加入团队</h1>
        {options.isPending && <p role="status">正在读取注册设置…</p>}
        {options.isError && (
          <div>
            <p role="alert">暂时无法读取注册设置。</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void options.refetch()}
            >
              重新读取
            </Button>
          </div>
        )}
        {options.data && !options.data.enabled && (
          <p role="status">注册暂未开放，已有账号可继续登录。</p>
        )}
        <form
          className="account-form"
          aria-label="注册账号"
          onChange={() =>
            setExpectedSettingsRevision(
              (revision) => revision ?? options.data?.revision,
            )
          }
          onSubmit={handleSubmit((values) => {
            if (!available) return;
            if (
              options.data?.allowRoleSelection &&
              !capabilities.roles.length
            ) {
              setRoleError("至少选择一个业务职责");
              return;
            }
            setRoleError("");
            return action.run(async () => {
              const result = await client.POST("/api/auth/register", {
                body: {
                  username: values.username,
                  displayName: values.displayName,
                  password: values.password,
                  ...(options.data!.allowRoleSelection
                    ? capabilities
                    : { roles: [], languageCapabilities: [] }),
                  expectedSettingsRevision:
                    expectedSettingsRevision ?? options.data!.revision,
                },
              });
              if (!result.response.ok) {
                const latest = await options.refetch();
                if (latest.data)
                  setExpectedSettingsRevision(latest.data.revision);
              }
              const user = await unwrap(result);
              resetField("password");
              resetField("confirmPassword");
              clearAccountCache();
              queryClient.setQueryData(["me"], user);
              navigate(user.roles.length ? returnTo : "/settings?tab=profile", {
                replace: true,
              });
            });
          })}
        >
          <TextField
            label="账户名"
            autoComplete="username"
            maxLength={64}
            {...register("username")}
            error={errors.username?.message}
          />
          <TextField
            label="成员昵称"
            autoComplete="nickname"
            maxLength={100}
            {...register("displayName")}
            error={errors.displayName?.message}
          />
          <TextField
            label="密码"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            {...register("password")}
            error={errors.password?.message}
            hint="至少 12 个字符，最多 128 个字符。"
          />
          <TextField
            label="再次输入密码"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            {...register("confirmPassword")}
            error={errors.confirmPassword?.message}
          />
          {options.data?.allowRoleSelection && (
            <CapabilityFields
              options={options.data}
              value={capabilities}
              disabled={action.busy}
              onChange={(value) => {
                setCapabilities(value);
                setRoleError("");
                setExpectedSettingsRevision(
                  (revision) => revision ?? options.data?.revision,
                );
              }}
            />
          )}
          {options.data && !options.data.allowRoleSelection && (
            <p>注册后由管理员分配职责和语言能力。</p>
          )}
          <Feedback error={roleError || action.error} />
          <Button type="submit" disabled={!available} loading={action.busy}>
            注册并登录
          </Button>
        </form>
        <p className="account-help">
          <Link to="/login" state={{ returnTo }}>
            返回登录
          </Link>
        </p>
      </Surface>
    </main>
  );
}
