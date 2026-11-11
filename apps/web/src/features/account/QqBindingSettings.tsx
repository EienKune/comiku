import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Button, TextField } from "../../components/ui";
import { useAccount } from "./account-context";
import { client, queryClient, unwrap } from "./api";
import { Feedback } from "./forms";
import { useAction } from "./use-action";

type Binding = components["schemas"]["QqBindingDto"];

export function QqBindingSettings() {
  const user = useAccount();
  const action = useAction();
  const queryKey = ["my-qq-binding", user.id];
  const binding = useQuery({
    queryKey,
    queryFn: async () => unwrap(await client.GET("/api/users/me/qq-binding")),
    staleTime: Infinity,
  });
  const [draft, setDraft] = useState<string>();
  const [expectedRevision, setExpectedRevision] = useState<number>();
  const [conflict, setConflict] = useState(false);
  const [current, setCurrent] = useState<Binding>();
  const value = draft ?? binding.data?.qqNumber ?? "";
  const normalized = value.trim();
  const invalid = !!normalized && !/^[1-9][0-9]{4,19}$/.test(normalized);

  function save(revision: number) {
    return action.run(async () => {
      const result = await client.PATCH("/api/users/me/qq-binding", {
        body: { qqNumber: normalized || null, expectedRevision: revision },
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
      setConflict(false);
      setCurrent(undefined);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      action.setSuccess(updated.qqNumber ? "QQ 号已保存" : "QQ 号已解绑");
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!binding.data || draft === undefined || invalid || conflict) return;
    void save(expectedRevision ?? binding.data.revision);
  }

  return (
    <form className="account-form" aria-label="QQ 绑定" onSubmit={submit}>
      <TextField
        label="QQ 号（选填）"
        inputMode="numeric"
        autoComplete="off"
        maxLength={20}
        value={value}
        disabled={!binding.data || action.busy}
        hint="用于群内工作提醒，留空可解绑。"
        error={invalid ? "请输入 5–20 位数字，首位不能为 0" : undefined}
        onChange={(event) => {
          setExpectedRevision((revision) => revision ?? binding.data?.revision);
          setDraft(event.target.value);
          action.clearError();
        }}
      />
      {binding.isPending && <p role="status">正在读取 QQ 绑定…</p>}
      {binding.isError && (
        <div>
          <p role="alert">暂时无法读取 QQ 绑定</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void binding.refetch()}
          >
            重新读取
          </Button>
        </div>
      )}
      <Feedback error={action.error} success={action.success} />
      {conflict && (
        <div className="account-actions">
          {current ? (
            <>
              <p>当前绑定：{current.qqNumber ?? "未绑定"}</p>
              <Button
                type="button"
                disabled={invalid}
                loading={action.busy}
                onClick={() => void save(current.revision)}
              >
                以当前版本保存
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="secondary"
              loading={action.busy}
              onClick={() =>
                void action.run(async () => {
                  setCurrent(
                    await unwrap(await client.GET("/api/users/me/qq-binding")),
                  );
                })
              }
            >
              读取当前绑定
            </Button>
          )}
        </div>
      )}
      <Button
        type="submit"
        loading={action.busy}
        disabled={!binding.data || draft === undefined || invalid || conflict}
      >
        保存 QQ 号
      </Button>
    </form>
  );
}
