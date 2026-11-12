import type { components } from "@comiku/api-client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, TextField } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { Feedback } from "../account/forms";
import "./work-reminders.css";

type Settings = components["schemas"]["WorkReminderSettingsDto"];
type Subscription = components["schemas"]["WorkReminderSubscriptionDto"];
type Channel = components["schemas"]["WorkReminderChannelDto"];
type Configuration = components["schemas"]["WorkReminderManagementDto"];
const key = ["work-reminders"];
function useConfiguration(
  enabled: boolean,
  panel: "subscriptions" | "template",
) {
  const cache = useQueryClient();
  useEffect(() => {
    if (!enabled) void cache.cancelQueries({ queryKey: [...key, panel] });
  }, [enabled, cache, panel]);
  return useQuery({
    queryKey: [...key, panel],
    enabled,
    queryFn: async ({ signal }): Promise<Configuration> =>
      unwrap(await client.GET("/api/notifications/work-reminders", { signal })),
    refetchOnWindowFocus: false,
  });
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请重试。";
function WorkReminderPreview({
  note,
  enabled,
  panel,
}: {
  note: string;
  enabled: boolean;
  panel: string;
}) {
  const [settledNote, setSettledNote] = useState(note);
  const cache = useQueryClient();
  useEffect(() => {
    if (!enabled) {
      void cache.cancelQueries({ queryKey: [...key, "preview", panel] });
      return;
    }
    const timer = setTimeout(() => setSettledNote(note), 200);
    return () => clearTimeout(timer);
  }, [note, enabled, cache, panel]);
  const preview = useQuery({
    queryKey: [...key, "preview", panel, settledNote],
    enabled,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.POST("/api/notifications/work-reminders/preview", {
          body: { note: settledNote },
          signal,
        }),
      ),
    placeholderData: (previous) => previous,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <>
      <pre className="notification-preview">
        {preview.data?.text ?? "正在生成预览…"}
      </pre>
      {preview.isError && <p role="status">预览更新失败，草稿已保留。</p>}
    </>
  );
}

export function WorkReminderSubscriptions({ enabled }: { enabled: boolean }) {
  const query = useConfiguration(enabled, "subscriptions");
  const cache = useQueryClient();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [comparison, setComparison] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const settings = draft ?? query.data?.settings;
  async function compareConfiguration() {
    if (
      !cache
        .getQueryCache()
        .find({ queryKey: [...key, "subscriptions"] })
        ?.isActive()
    )
      return;
    const result = await query.refetch();
    if (result.isError)
      throw new Error("读取当前设置失败，草稿已保留。请重试保存。");
    return result.data;
  }
  async function save() {
    if (!settings || !enabled || busy) return;
    if (new Set(settings.sendTimes).size !== settings.sendTimes.length) {
      setError("发送时段不能重复。");
      return;
    }
    setDraft(settings);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const { revision, ...input } = settings;
      const response = await client.PATCH(
        "/api/notifications/work-reminders/settings",
        { body: { ...input, expectedRevision: revision } },
      );
      if (response.response.status === 409) {
        const latest = await compareConfiguration();
        setComparison(latest?.settings ?? null);
        throw new Error("工作提醒设置已变化，草稿已保留。请核对当前设置。");
      }
      await unwrap(response);
      await cache.invalidateQueries({ queryKey: key });
      setDraft(null);
      setComparison(null);
      setSuccess("工作提醒设置已保存。");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="work-reminder-panel"
      aria-label="工作提醒设置"
      id="work-reminder-settings"
      tabIndex={-1}
    >
      <h3>工作提醒</h3>
      {query.isError && (
        <p role="alert">
          工作提醒读取失败。
          <Button
            variant="ghost"
            onClick={() => void query.refetch()}
            disabled={!enabled}
          >
            重试
          </Button>
        </p>
      )}
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={!enabled || busy}>
            <label className="notification-check">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) =>
                  setDraft({ ...settings, enabled: event.target.checked })
                }
              />
              启用工作提醒
            </label>
            <div className="work-reminder-times">
              {settings.sendTimes.map((time, index) => (
                <TextField
                  key={index}
                  label={`北京时间 ${index + 1}`}
                  type="time"
                  required
                  value={time}
                  onChange={(event) =>
                    setDraft({
                      ...settings,
                      sendTimes: settings.sendTimes.map((value, position) =>
                        position === index ? event.target.value : value,
                      ),
                    })
                  }
                  action={
                    index === 2 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setDraft({
                            ...settings,
                            sendTimes: settings.sendTimes.slice(0, 2),
                          })
                        }
                      >
                        移除
                      </Button>
                    ) : undefined
                  }
                />
              ))}
              {settings.sendTimes.length < 3 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setDraft({
                      ...settings,
                      sendTimes: [...settings.sendTimes, "12:00"],
                    })
                  }
                >
                  添加时段
                </Button>
              )}
            </div>
            <p className="notification-boundary">
              每天按北京时间合并发送。可开工后 72
              小时仍未交稿，每轮提醒一次；已有任务从启用后开始观测，无法确认的停机时段可能使提醒延后。
            </p>
            <TextField
              label="工作摘要提示语"
              maxLength={120}
              value={settings.note}
              onChange={(event) =>
                setDraft({ ...settings, note: event.target.value })
              }
            />
            <details className="work-reminder-preview" open>
              <summary>消息预览</summary>
              <WorkReminderPreview
                note={settings.note}
                enabled={enabled}
                panel="subscriptions"
              />
            </details>
            <div className="notification-actions">
              <Button type="submit" loading={busy}>
                保存工作提醒
              </Button>
              {draft && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setDraft(null);
                    setComparison(null);
                    setError("");
                  }}
                >
                  放弃草稿
                </Button>
              )}
            </div>
            {comparison && (
              <div className="work-reminder-comparison">
                <p>
                  当前设置：{comparison.enabled ? "开启" : "关闭"} ·{" "}
                  {comparison.sendTimes.join("、")} ·{" "}
                  {comparison.note || "无提示语"}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setDraft({ ...settings, revision: comparison.revision });
                    setComparison(null);
                    setError("");
                  }}
                >
                  保留草稿并以当前版本重试
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      )}
      <Feedback error={error} success={success} />
      <div className="work-reminder-channels">
        {query.data?.channels.map((channel) => (
          <ChannelReminder
            key={channel.id}
            channel={channel}
            enabled={enabled}
            onSaved={() => cache.invalidateQueries({ queryKey: key })}
            onCompare={async () =>
              (await compareConfiguration())?.channels.find(
                (item) => item.id === channel.id,
              )
            }
          />
        ))}
      </div>
      {query.data?.channels.length === 0 && (
        <p className="notification-boundary">先在群订阅中添加接收群。</p>
      )}
    </section>
  );
}

function ChannelReminder({
  channel,
  enabled,
  onSaved,
  onCompare,
}: {
  channel: Channel;
  enabled: boolean;
  onSaved: () => Promise<unknown>;
  onCompare: () => Promise<Channel | undefined>;
}) {
  const [draft, setDraft] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<Channel | null>(null);
  const current = draft ?? channel.subscription;
  const [baseChannelRevision, setBaseChannelRevision] = useState(
    channel.revision,
  );
  return (
    <form
      className="work-reminder-channel"
      aria-label={`${channel.name}的工作提醒`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!enabled || busy) return;
        setDraft(current);
        setBusy(true);
        setError("");
        setComparison(null);
        try {
          const { revision, ...input } = current;
          const response = await client.PATCH(
            "/api/notifications/work-reminders/subscriptions/{id}",
            {
              params: { path: { id: channel.id } },
              body: {
                ...input,
                expectedChannelRevision: draft
                  ? baseChannelRevision
                  : channel.revision,
                expectedRevision: revision,
              },
            },
          );
          if (response.response.status === 409) {
            const latest = await onCompare();
            setComparison(latest ?? null);
            throw new Error("群订阅已变化，草稿已保留。请核对当前设置。");
          }
          await unwrap(response);
          await onSaved();
          setDraft(null);
        } catch (caught) {
          setError(errorMessage(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <strong>{channel.name}</strong>
        <span className="notification-boundary">
          QQ 群 {channel.groupId}
          {!channel.enabled ? " · 群推送已关闭" : ""}
        </span>
      </div>
      <fieldset disabled={!enabled || busy} className="work-reminder-options">
        {(
          [
            ["digestEnabled", "每日摘要"],
            ["readyEnabled", "预认领可开工"],
            ["overdueEnabled", "72 小时未交稿"],
            ["mentionsEnabled", "@ 提醒成员"],
          ] as const
        ).map(([field, label]) => (
          <label className="notification-check" key={field}>
            <input
              type="checkbox"
              checked={current[field]}
              onChange={(event) => {
                if (!draft) setBaseChannelRevision(channel.revision);
                setDraft({ ...current, [field]: event.target.checked });
                setComparison(null);
              }}
            />
            {label}
          </label>
        ))}
        {draft && (
          <>
            <Button type="submit" size="sm" loading={busy}>
              保存群提醒
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(null);
                setComparison(null);
                setError("");
              }}
            >
              放弃草稿
            </Button>
          </>
        )}
      </fieldset>
      <Feedback error={error} />
      {comparison && (
        <div className="work-reminder-comparison">
          <p>
            当前服务器版本：{comparison.name} · 群推送
            {comparison.enabled ? "开启" : "关闭"} ·{" "}
            {[
              comparison.subscription.digestEnabled && "每日摘要",
              comparison.subscription.readyEnabled && "预认领可开工",
              comparison.subscription.overdueEnabled && "72 小时未交稿",
              comparison.subscription.mentionsEnabled && "@ 提醒成员",
            ]
              .filter(Boolean)
              .join("、") || "未启用工作提醒"}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={!enabled || busy}
            onClick={() => {
              setDraft({
                ...current,
                revision: comparison.subscription.revision,
              });
              setBaseChannelRevision(comparison.revision);
              setComparison(null);
              setError("");
            }}
          >
            保留草稿并以当前版本重试
          </Button>
        </div>
      )}
    </form>
  );
}

export function WorkReminderTemplate({
  enabled,
  onEdit,
}: {
  enabled: boolean;
  onEdit: () => void;
}) {
  const query = useConfiguration(enabled, "template");
  return (
    <section className="work-reminder-panel" aria-label="工作摘要模板">
      <h3>工作摘要</h3>
      <p className="notification-boundary">
        每日摘要、可以开工和超时事项合并发送，同一成员最多 @ 一次。
      </p>
      {query.isError && (
        <p role="alert">
          工作摘要读取失败。
          <Button
            type="button"
            variant="ghost"
            disabled={!enabled}
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </p>
      )}
      {query.data && (
        <WorkReminderPreview
          note={query.data.settings.note}
          enabled={enabled}
          panel="template"
        />
      )}
      <Button
        type="button"
        variant="secondary"
        disabled={!enabled}
        onClick={onEdit}
      >
        编辑工作提醒
      </Button>
    </section>
  );
}
