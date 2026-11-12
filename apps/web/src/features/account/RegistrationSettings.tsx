import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Button, Surface, TextField } from "../../components/ui";
import { client, queryClient, unwrap } from "./api";
import { Feedback } from "./forms";
import { useAction } from "./use-action";
import { registrationOptionsKey } from "./registration-options";

type Settings = components["schemas"]["RegistrationSettingsDto"];
const queryKey = ["registration-settings"];
export function RegistrationSettings({ enabled }: { enabled: boolean }) {
  const settings = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/users/registration-settings", { signal })),
    enabled,
  });
  const action = useAction();
  const [draft, setDraft] =
    useState<Pick<Settings, "enabled" | "allowRoleSelection">>();
  const [expectedRevision, setExpectedRevision] = useState<number>();
  const [password, setPassword] = useState("");
  const [conflict, setConflict] = useState(false);
  const [current, setCurrent] = useState<Settings>();
  const value = draft ??
    settings.data ?? { enabled: false, allowRoleSelection: false };
  function save(revision: number) {
    return action.run(async () => {
      const result = await client.PATCH("/api/users/registration-settings", {
        body: {
          enabled: value.enabled,
          allowRoleSelection: value.allowRoleSelection,
          expectedRevision: revision,
          currentPassword: password,
        },
      });
      if (result.response.status === 409) {
        setConflict(true);
        setCurrent(undefined);
      }
      const updated = await unwrap(result);
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, updated);
      setDraft(undefined);
      setExpectedRevision(undefined);
      setPassword("");
      setConflict(false);
      setCurrent(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: registrationOptionsKey }),
        queryClient.invalidateQueries({ queryKey: ["audit"] }),
      ]);
      action.setSuccess(updated.enabled ? "公开注册已开启" : "公开注册已关闭");
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !enabled ||
      !settings.data ||
      settings.isError ||
      draft === undefined ||
      !password ||
      conflict
    )
      return;
    void save(expectedRevision ?? settings.data.revision);
  }
  return (
    <Surface className="account-card account-content-boundary">
      <h2>公开注册</h2>
      <form
        className="account-form"
        aria-label="公开注册设置"
        onSubmit={submit}
      >
        {settings.isPending && <p role="status">正在读取注册设置…</p>}
        {settings.isError && (
          <div>
            <p role="alert">暂时无法读取注册设置。</p>
            <Button
              type="button"
              variant="secondary"
              disabled={!enabled}
              onClick={() => void settings.refetch()}
            >
              重新读取
            </Button>
          </div>
        )}
        <label className="account-checkbox">
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={!enabled || !settings.data || action.busy}
            onChange={(event) => {
              setExpectedRevision(
                (revision) => revision ?? settings.data?.revision,
              );
              setDraft({ ...value, enabled: event.target.checked });
              action.clearError();
            }}
          />
          开放注册
        </label>
        <label className="account-checkbox">
          <input
            type="checkbox"
            checked={value.allowRoleSelection}
            disabled={!enabled || !settings.data || action.busy}
            onChange={(event) => {
              setExpectedRevision(
                (revision) => revision ?? settings.data?.revision,
              );
              setDraft({ ...value, allowRoleSelection: event.target.checked });
              action.clearError();
            }}
          />
          允许注册时自选职责和语言
        </label>
        <p>关闭自选后，新成员由管理员分配职责和语言能力。</p>
        {draft !== undefined && (
          <TextField
            label="当前管理员密码"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            value={password}
            disabled={action.busy || !enabled}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
        <Feedback error={action.error} success={action.success} />
        {conflict && (
          <div className="account-actions">
            {current ? (
              <>
                <p>
                  当前设置：{current.enabled ? "注册已开放" : "注册已关闭"} ·{" "}
                  {current.allowRoleSelection
                    ? "允许自选职责和语言"
                    : "由管理员分配职责和语言"}
                </p>
                <Button
                  type="button"
                  disabled={!enabled || !password}
                  loading={action.busy}
                  onClick={() => void save(current.revision)}
                >
                  以当前版本保存开关
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="secondary"
                disabled={!enabled}
                loading={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    setCurrent(
                      await unwrap(
                        await client.GET("/api/users/registration-settings"),
                      ),
                    );
                  })
                }
              >
                读取当前开关
              </Button>
            )}
          </div>
        )}
        <Button
          type="submit"
          loading={action.busy}
          disabled={
            !enabled ||
            !settings.data ||
            settings.isError ||
            draft === undefined ||
            !password ||
            conflict
          }
        >
          保存注册设置
        </Button>
      </form>
    </Surface>
  );
}
