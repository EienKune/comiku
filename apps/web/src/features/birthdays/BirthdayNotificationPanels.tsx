import type { components } from "@comiku/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SelectField, TextField } from "../../components/ui";
import { ErrorToast } from "../../components/ErrorToast";
import { client, unwrap } from "../account/api";
import {
  birthdayError,
  useBirthdayQuery,
  useBirthdayVisibility,
} from "./use-birthday-query";
import "./birthdays.css";

type Template = components["schemas"]["BirthdayTemplateDto"];

export function BirthdaySubscriptions({ enabled }: { enabled: boolean }) {
  const cache = useQueryClient();
  const query = useBirthdayQuery("subscriptions", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/subscriptions", { signal })),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const channels = Array.isArray(query.data) ? query.data : [];
  return (
    <section className="birthday-notification-panel" aria-label="生日群订阅">
      <h3>角色生日</h3>
      <ErrorToast message={error} onDismiss={() => setError("")} />
      {query.isError && (
        <p role="alert">
          生日订阅读取失败。
          <Button
            type="button"
            variant="ghost"
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </p>
      )}
      {channels.map((channel) => (
        <div className="birthday-subscription" key={channel.id}>
          <div>
            <strong>{channel.name}</strong>
            <span className="birthday-muted">QQ 群 {channel.groupId}</span>
          </div>
          <label className="birthday-check">
            <input
              type="checkbox"
              aria-label={`${channel.name}的生日提醒`}
              disabled={busy !== null || !enabled}
              checked={channel.birthdayEnabled}
              onChange={async (event) => {
                const checked = event.target.checked;
                setBusy(channel.id);
                setError("");
                try {
                  const result = await client.PATCH(
                    "/api/birthdays/subscriptions/{id}",
                    {
                      params: { path: { id: channel.id } },
                      body: {
                        expectedChannelRevision: channel.revision,
                        expectedScopeRevision: channel.birthdayRevision,
                        enabled: checked,
                      },
                    },
                  );
                  if (result.response.status === 409)
                    throw new Error("群订阅已变化，请核对当前设置后重试。");
                  await unwrap(result);
                } catch (caught) {
                  setError(birthdayError(caught));
                } finally {
                  setBusy(null);
                  void cache.invalidateQueries({
                    queryKey: ["birthdays", "subscriptions"],
                  });
                }
              }}
            />
            生日提醒
          </label>
        </div>
      ))}
      {query.data && channels.length === 0 && (
        <p className="birthday-muted">先在群订阅中添加接收群。</p>
      )}
    </section>
  );
}

export function BirthdayTemplate({ enabled }: { enabled: boolean }) {
  const cache = useQueryClient();
  const query = useBirthdayQuery("template", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/template", { signal })),
  );
  const [draft, setDraft] = useState<Template | null>(null);
  const current =
    draft ?? (typeof query.data?.note === "string" ? query.data : undefined);
  const [offset, setOffset] = useState("0");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [comparison, setComparison] = useState<Template | null>(null);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const active = useBirthdayVisibility(enabled);
  const stopPreview = useCallback(() => {
    epoch.current++;
    controller.current?.abort();
  }, []);
  useEffect(() => {
    if (!active) {
      stopPreview();
      setPreviewBusy(false);
    }
    return stopPreview;
  }, [active, stopPreview]);
  useEffect(() => {
    stopPreview();
    setPreview("");
    setPreviewBusy(false);
  }, [query.data?.note, query.data?.revision, stopPreview]);
  const dirty = Boolean(
    draft &&
    (draft.note !== query.data?.note ||
      draft.revision !== query.data?.revision),
  );
  function invalidatePreview() {
    epoch.current++;
    controller.current?.abort();
    setPreview("");
    setPreviewBusy(false);
  }
  async function save() {
    if (!current) return;
    if (Array.from(current.note).length > 120) {
      setError("生日提示语最多 120 个字符。");
      return;
    }
    setDraft(current);
    invalidatePreview();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await client.PATCH("/api/birthdays/template", {
        body: { expectedRevision: current.revision, note: current.note },
      });
      if (result.response.status === 409) {
        setConflict(true);
        throw new Error("生日模板已变化，草稿已保留。请核对当前版本。");
      }
      const saved = await unwrap(result);
      cache.setQueryData(["birthdays", "template"], saved);
      setDraft(null);
      setConflict(false);
      setComparison(null);
      setSuccess("生日模板已保存。");
      void cache.invalidateQueries({ queryKey: ["birthdays", "template"] });
    } catch (caught) {
      setError(birthdayError(caught));
    } finally {
      setBusy(false);
    }
  }
  async function loadPreview() {
    if (!active || dirty) return;
    invalidatePreview();
    const ticket = epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    setPreviewBusy(true);
    setError("");
    try {
      const result = await unwrap(
        await client.GET("/api/birthdays/preview", {
          signal: abort.signal,
          params: {
            query: { offsetDays: offset === "7" ? 7 : offset === "1" ? 1 : 0 },
          },
        }),
      );
      if (ticket === epoch.current) setPreview(result.text);
    } catch (caught) {
      if (ticket === epoch.current && !abort.signal.aborted)
        setError(birthdayError(caught));
    } finally {
      if (ticket === epoch.current) setPreviewBusy(false);
    }
  }
  return (
    <section className="birthday-notification-panel" aria-label="生日消息模板">
      <h3>角色生日</h3>
      <ErrorToast message={error} onDismiss={() => setError("")} />
      {query.isError && (
        <p role="alert">
          生日模板读取失败。
          <Button
            type="button"
            variant="ghost"
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </p>
      )}
      {current && (
        <>
          <TextField
            label="生日提示语"
            value={current.note}
            disabled={busy}
            onChange={(event) => {
              invalidatePreview();
              setDraft({ ...current, note: event.target.value });
              setSuccess("");
            }}
            hint={`${Array.from(current.note).length} / 120`}
          />
          <div className="birthday-template-actions">
            <Button
              type="button"
              loading={busy}
              disabled={!enabled || Array.from(current.note).length > 120}
              onClick={() => void save()}
            >
              保存生日模板
            </Button>
            <SelectField
              label="预览日期"
              value={offset}
              onValueChange={(value) => {
                invalidatePreview();
                setOffset(value);
              }}
            >
              <option value="0">生日当天</option>
              <option value="1">提前 1 天</option>
              <option value="7">提前 7 天</option>
            </SelectField>
            <Button
              type="button"
              variant="secondary"
              loading={previewBusy}
              disabled={!active || dirty || busy}
              onClick={() => void loadPreview()}
            >
              预览生日消息
            </Button>
          </div>
          {dirty && <p className="birthday-muted">保存提示语后可预览。</p>}
          {conflict && (
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={async () => {
                  const latest = await query.refetch();
                  if (latest.data) setComparison(latest.data);
                }}
              >
                核对当前生日模板
              </Button>
              {comparison && (
                <>
                  <p>当前提示语：{comparison.note || "（空）"}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setDraft({ ...current, revision: comparison.revision });
                      setConflict(false);
                      setComparison(null);
                    }}
                  >
                    保留提示语并采用当前版本
                  </Button>
                </>
              )}
            </div>
          )}
          {success && <p role="status">{success}</p>}
          {preview && <pre className="birthday-message-preview">{preview}</pre>}
        </>
      )}
    </section>
  );
}
