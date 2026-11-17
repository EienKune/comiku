import type { components } from "@comiku/api-client";
import { Badge, Button } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { useBirthdayQuery } from "../birthdays/use-birthday-query";
import {
  SavedSample,
  type Template,
  type EventOption,
} from "./NotificationTemplateEditor";
import { useWorkReminderConfiguration } from "./use-work-reminder-configuration";

type Configuration = components["schemas"]["NotificationConfigurationDto"];
export function NotificationGroupRoster({
  data,
  enabled,
  search,
  saving,
  templates,
  events,
  onEdit,
  onUpdated,
}: {
  data: Configuration;
  enabled: boolean;
  search: string;
  saving: boolean;
  templates: Template[];
  events: EventOption[];
  onEdit: (channel: Configuration["channels"][number]) => void;
  onUpdated: () => void;
}) {
  const work = useWorkReminderConfiguration(enabled, "subscriptions");
  const birthdays = useBirthdayQuery("subscriptions", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/subscriptions", { signal })),
  );
  return (
    <div className="notification-channels">
      {data.channels
        .filter(
          (channel) =>
            channel.name.includes(search) || channel.groupId.includes(search),
        )
        .map((channel) => {
          const workSubscription = work.data?.channels?.find(
            (item) => item.id === channel.id,
          )?.subscription;
          const birthday = Array.isArray(birthdays.data)
            ? birthdays.data.find((item) => item.id === channel.id)
                ?.birthdayEnabled
            : undefined;
          const connection = data.connections.find(
            (item) => item.key === channel.connectionKey,
          );
          return (
            <article className="notification-channel" key={channel.id}>
              <div>
                <strong>{channel.name}</strong>
                <span>QQ 群 {channel.groupId}</span>
              </div>
              <span>{connection?.name ?? "连接已缺失"}</span>
              <Badge tone={channel.enabled ? "success" : "neutral"}>
                {channel.enabled ? "已启用" : "已停用"}
              </Badge>
              <span className="notification-subscription-summary">
                作品 {channel.eventTypes.length} 类
                {workSubscription
                  ? ` · 工作 ${[workSubscription.digestEnabled, workSubscription.overdueEnabled, workSubscription.readyEnabled].filter(Boolean).length} 项`
                  : ""}
                {birthday ? " · 生日" : ""}
              </span>
              <div className="notification-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`编辑 ${channel.name}`}
                  disabled={saving}
                  onClick={() => onEdit(channel)}
                >
                  编辑
                </Button>
                <SavedSample
                  enabled={enabled}
                  channel={channel}
                  templates={templates}
                  events={events}
                  unavailableReason={
                    !data.enabled
                      ? "通知服务已关闭"
                      : !channel.enabled
                        ? "此群已停用"
                        : !connection?.available
                          ? "连接配置不可用"
                          : channel.eventTypes.length === 0
                            ? "此群尚未订阅事件"
                            : ""
                  }
                  onUpdated={onUpdated}
                />
              </div>
            </article>
          );
        })}
    </div>
  );
}
