import { useAction } from "./use-action";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { BookOpen } from "lucide-react";
import { Button, Surface, TextField } from "../../components/ui";
import { client, queryClient, unwrap, useMe } from "./api";
import { ErrorState, Feedback, LoadingState } from "./forms";
import "./account.css";
import { loginReturnTarget } from "./login-return";
import { useRegistrationOptions } from "./registration-options";

const schema = z.object({
  username: z.string().trim().min(3, "请输入至少 3 位账户名").max(64),
  password: z.string().min(1, "请输入密码").max(128),
});
export function LoginPage() {
  const me = useMe();
  const registration = useRegistrationOptions(!me.data);
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = loginReturnTarget(location.state);
  const action = useAction();
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
  return (
    <main className="account-login">
      <Surface className="account-login-card">
        <div className="account-brand">
          <BookOpen aria-hidden="true" />
          Comiku
        </div>
        <h1>一起，把故事带给更多人。</h1>
        <form
          className="account-form"
          onSubmit={handleSubmit((values) =>
            action.run(async () => {
              const user = await unwrap(
                await client.POST("/api/auth/login", { body: values }),
              );
              resetField("password");
              queryClient.clear();
              queryClient.setQueryData(["me"], user);
              navigate(
                user.mustChangePassword
                  ? "/settings/password"
                  : !user.roles.length
                    ? "/settings?tab=profile"
                    : returnTo,
                {
                  replace: true,
                  state: user.mustChangePassword ? { returnTo } : undefined,
                },
              );
            }),
          )}
        >
          <TextField
            label="账户名"
            autoComplete="username"
            {...register("username")}
            error={errors.username?.message}
          />
          <TextField
            label="密码"
            type="password"
            autoComplete="current-password"
            {...register("password")}
            error={errors.password?.message}
          />
          <Feedback error={action.error} />
          <Button type="submit" loading={action.busy}>
            登录
          </Button>
        </form>
        {registration.data?.enabled && (
          <p className="account-help">
            <Link to="/register" state={{ returnTo }}>
              注册账号
            </Link>
          </p>
        )}
        <p className="account-help">忘记密码，请联系团队管理员。</p>
      </Surface>
    </main>
  );
}
