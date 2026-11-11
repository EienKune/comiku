import type { components } from "@comiku/api-client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Button, Surface, TextField } from "../../components/ui";
import { ErrorToast } from "../../components/ErrorToast";
import { client, unwrap } from "../account/api";
import { birthdayError, useBirthdayQuery } from "./use-birthday-query";
import "./birthdays.css";

type Settings = components["schemas"]["BirthdaySettingsDto"];
export function BirthdaySettings({ enabled = true }: { enabled?: boolean }) {
  const cache = useQueryClient();
  const query = useBirthdayQuery("settings", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/settings", { signal })),
  );
  const [draft, setDraft] = useState<Settings | null>(null);
  const [comparison, setComparison] = useState<Settings | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const current = draft ?? query.data?.settings;
  function change(patch: Partial<Settings>) {
    if (current) setDraft({ ...current, ...patch });
    setSuccess("");
  }
  async function save() {
    if (!current) return;
    setDraft(current);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await client.PATCH("/api/birthdays/settings", {
        body: {
          expectedRevision: current.revision,
          displayEnabled: current.displayEnabled,
          remindersEnabled: current.remindersEnabled,
          sendTime: current.sendTime,
          offsetDays: current.offsetDays.filter(
            (day): day is 0 | 1 | 7 => day === 0 || day === 1 || day === 7,
          ),
        },
      });
      if (result.response.status === 409) {
        setConflict(true);
        throw new Error("设置已变化，草稿已保留。请核对当前版本。");
      }
      const saved = await unwrap(result);
      cache.setQueryData(["birthdays", "settings"], {
        ...query.data,
        settings: saved,
      });
      setDraft(null);
      setConflict(false);
      setComparison(null);
      void cache.invalidateQueries({ queryKey: ["birthdays", "settings"] });
      void cache.invalidateQueries({ queryKey: ["birthdays", "summary"] });
      setSuccess("生日设置已保存。");
    } catch (caught) {
      setError(birthdayError(caught));
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    setSyncing(true);
    setSyncNote("");
    try {
      const result = await unwrap(await client.POST("/api/birthdays/sync"));
      setSyncNote(result.queued ? "已安排同步。" : "同步已在进行中。");
    } catch {
      /* Synchronization errors belong to technical logs. */
    } finally {
      setSyncing(false);
    }
  }
  return (
    <div className="birthday-settings">
      <ErrorToast message={error} onDismiss={() => setError("")} />
      <Surface>
        <header className="birthday-panel-heading">
          <h2>生日数据</h2>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={syncing}
            disabled={!enabled || !query.data?.available}
            onClick={() => void sync()}
          >
            手动同步
          </Button>
        </header>
        {query.data && (
          <p>
            {query.data.personCount} 位角色
            {query.data.dataUpdatedAt && (
              <>
                {" "}
                · 更新于{" "}
                {new Date(query.data.dataUpdatedAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </>
            )}
          </p>
        )}
        <p className="birthday-muted">每天 06:00 同步 · Asia/Shanghai</p>
        {syncNote && <p role="status">{syncNote}</p>}
      </Surface>
      {query.isPending && <p role="status">正在读取生日设置…</p>}
      {query.isError && (
        <p role="alert">
          生日设置读取失败。
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
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset
            className="birthday-settings-fields"
            disabled={busy || !enabled}
          >
            <Surface>
              <header className="birthday-panel-heading">
                <h2>工作台展示</h2>
                <label className="birthday-check">
                  <input
                    type="checkbox"
                    checked={current.displayEnabled}
                    onChange={(event) =>
                      change({ displayEnabled: event.target.checked })
                    }
                  />
                  启用工作台生日
                </label>
              </header>
              <p className="birthday-muted">未来 7 天；空窗展示最近一次</p>
            </Surface>
            <Surface>
              <header className="birthday-panel-heading">
                <h2>群提醒日程</h2>
                <label className="birthday-check">
                  <input
                    type="checkbox"
                    checked={current.remindersEnabled}
                    onChange={(event) =>
                      change({ remindersEnabled: event.target.checked })
                    }
                  />
                  启用生日提醒
                </label>
              </header>
              <div className="birthday-form-grid">
                <fieldset className="birthday-offsets">
                  <legend>提醒日期</legend>
                  {[
                    [0, "生日当天"],
                    [1, "提前 1 天"],
                    [7, "提前 7 天"],
                  ].map(([offset, label]) => (
                    <label key={offset} className="birthday-check">
                      <input
                        type="checkbox"
                        checked={current.offsetDays.includes(Number(offset))}
                        onChange={(event) =>
                          change({
                            offsetDays: event.target.checked
                              ? [...current.offsetDays, Number(offset)].sort(
                                  (a, b) => a - b,
                                )
                              : current.offsetDays.filter(
                                  (day) => day !== offset,
                                ),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <TextField
                  label="提醒时刻"
                  type="time"
                  required
                  value={current.sendTime}
                  onChange={(event) => change({ sendTime: event.target.value })}
                />
              </div>
              <div className="birthday-setting-foot">
                <span className="birthday-muted">
                  Asia/Shanghai · 同一天生日合并为一条摘要
                </span>
                <Link to="?tab=notifications">配置接收群与消息模板</Link>
              </div>
            </Surface>
            {conflict && (
              <Surface>
                <p>设置已由其他管理员更新，草稿仍保留。</p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={async () => {
                    const latest = await query.refetch();
                    if (latest.data) setComparison(latest.data.settings);
                  }}
                >
                  核对当前设置
                </Button>
                {comparison && (
                  <>
                    <p>
                      当前版本：工作台
                      {comparison.displayEnabled ? "开启" : "关闭"}，提醒
                      {comparison.remindersEnabled ? "开启" : "关闭"}，
                      {comparison.sendTime}，提前{" "}
                      {comparison.offsetDays.join("、")} 天。
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setDraft({ ...current, revision: comparison.revision });
                        setComparison(null);
                        setConflict(false);
                      }}
                    >
                      保留草稿并采用当前版本
                    </Button>
                  </>
                )}
              </Surface>
            )}
            <div className="birthday-save-bar">
              <span role="status">{success}</span>
              <Button
                type="submit"
                loading={busy}
                disabled={current.offsetDays.length === 0}
              >
                保存设置
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}
