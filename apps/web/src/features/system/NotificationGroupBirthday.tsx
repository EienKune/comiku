import { NotificationGroupActions } from "./NotificationGroupActions";
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/ui";
import { Feedback } from "../account/forms";
import { client, unwrap } from "../account/api";
import { useBirthdayQuery } from "../birthdays/use-birthday-query";

type BirthdayChannel = {
  id: string;
  name: string;
  revision: number;
  birthdayRevision: number;
  birthdayEnabled: boolean;
  enabled: boolean;
  groupId: string;
};
export function NotificationGroupBirthday({
  enabled,
  selectedId,
  onGlobal,
}: {
  enabled: boolean;
  selectedId?: string;
  onGlobal: () => void;
}) {
  const cache = useQueryClient();
  const query = useBirthdayQuery("subscriptions", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/subscriptions", { signal })),
  );
  const settings = useBirthdayQuery("settings", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/settings", { signal })),
  );
  return (
    <section aria-label="生日群订阅">
      <h3>生日提醒</h3>
      {query.isError && (
        <p role="alert">
          生日订阅读取失败。
          <Button variant="ghost" onClick={() => void query.refetch()}>
            重试
          </Button>
        </p>
      )}
      {query.data?.map((channel) => (
        <div key={channel.id} hidden={channel.id !== selectedId}>
          <BirthdayGroup
            channel={channel}
            enabled={enabled && channel.id === selectedId}
            onSaved={async () => {
              await cache.invalidateQueries({
                queryKey: ["birthdays", "subscriptions"],
              });
            }}
            onCompare={async () => {
              if (
                !cache
                  .getQueryCache()
                  .find({
                    queryKey: ["birthdays", "subscriptions"],
                    exact: true,
                  })
                  ?.isActive()
              )
                return undefined;
              return (await query.refetch()).data?.find(
                (item) => item.id === channel.id,
              );
            }}
          />
        </div>
      ))}
      {settings.data && (
        <div className="notification-inherited-rule">
          <span>
            {settings.data.settings.remindersEnabled
              ? `${settings.data.settings.offsetDays.map((day) => (day === 0 ? "生日当天" : `提前 ${day} 天`)).join("、")} · ${settings.data.settings.sendTime}`
              : "全局生日提醒已关闭"}
          </span>
          <Button type="button" variant="ghost" onClick={onGlobal}>
            全局规则
          </Button>
        </div>
      )}
    </section>
  );
}
function BirthdayGroup({
  channel,
  enabled,
  onSaved,
  onCompare,
}: {
  channel: BirthdayChannel;
  enabled: boolean;
  onSaved: () => Promise<void>;
  onCompare: () => Promise<BirthdayChannel | undefined>;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<{
    value: boolean;
    channelRevision: number;
    revision: number;
  } | null>(null);
  const [comparison, setComparison] = useState<BirthdayChannel | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const current = draft ?? {
    value: channel.birthdayEnabled,
    channelRevision: channel.revision,
    revision: channel.birthdayRevision,
  };
  async function save() {
    if (!enabled || busy) return;
    setDraft(current);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await client.PATCH("/api/birthdays/subscriptions/{id}", {
        params: { path: { id: channel.id } },
        body: {
          enabled: current.value,
          expectedChannelRevision: current.channelRevision,
          expectedScopeRevision: current.revision,
        },
      });
      if (result.response.status === 409) {
        setComparison((await onCompare()) ?? null);
        throw new Error("生日订阅已变化，草稿已保留。请核对当前设置。");
      }
      await unwrap(result);
      await onSaved();
      setDraft(null);
      setComparison(null);
      setSuccess("生日订阅已保存。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      id={formId}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={!enabled || busy}>
        <label className="notification-check">
          <input
            type="checkbox"
            checked={current.value}
            onChange={(event) => {
              setDraft({ ...current, value: event.target.checked });
              setComparison(null);
            }}
          />
          {channel.name}接收生日提醒
        </label>
        <NotificationGroupActions active={enabled} disabled={busy}>
          <Button type="submit" form={formId} loading={busy}>
            保存生日订阅
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
        </NotificationGroupActions>
        {comparison && (
          <div className="notification-content">
            <p>
              当前服务器版本：{comparison.name} · 群推送
              {comparison.enabled ? "开启" : "关闭"} · 生日提醒
              {comparison.birthdayEnabled ? "开启" : "关闭"}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDraft({
                  ...current,
                  channelRevision: comparison.revision,
                  revision: comparison.birthdayRevision,
                });
                setComparison(null);
                setError("");
              }}
            >
              保留草稿并以当前版本重试
            </Button>
          </div>
        )}
      </fieldset>
      <Feedback error={error} success={success} />
    </form>
  );
}
