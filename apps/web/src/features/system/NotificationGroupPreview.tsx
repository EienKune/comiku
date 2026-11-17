import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SelectField } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { stageNames } from "./notification-event-categories";
import type {
  EventOption,
  SubscriptionRule,
  Template,
} from "./NotificationTemplateEditor";
import type { GroupSection } from "./NotificationGroupDialog";
import { useBirthdayQuery } from "../birthdays/use-birthday-query";

export function NotificationGroupPreview({
  enabled,
  section,
  eventType,
  onEvent,
  events,
  templates,
  includeDetails,
  receiverMode,
  rules,
  workOptions,
}: {
  enabled: boolean;
  section: GroupSection;
  eventType: EventOption["type"] | "";
  onEvent: (event: EventOption["type"]) => void;
  events: EventOption[];
  templates: Template[];
  includeDetails: boolean;
  receiverMode?: string;
  rules: SubscriptionRule[];
  workOptions?: {
    digestEnabled: boolean;
    overdueEnabled: boolean;
    mentionsEnabled: boolean;
  };
}) {
  const [stage, setStage] = useState<keyof typeof stageNames>("translate");
  const [kind, setKind] = useState("digest");
  const [offset, setOffset] = useState("");
  const birthdaySettings = useBirthdayQuery(
    "settings",
    enabled && section === "birthday",
    async (signal) =>
      unwrap(await client.GET("/api/birthdays/settings", { signal })),
  );
  const offsets = birthdaySettings.data?.settings.offsetDays ?? [];
  const selectedOffset =
    offsets.includes(Number(offset)) && offset !== ""
      ? offset
      : String(offsets[0] ?? "");
  const event = events.find((item) => item.type === eventType);
  const selectedStage = event?.allowedStages?.includes(stage)
    ? stage
    : event?.allowedStages?.[0];
  const template = templates.find((item) => item.eventType === eventType);
  const rule = rules.find((item) => item.eventType === eventType);
  const cache = useQueryClient();
  useEffect(() => {
    if (!enabled)
      void cache.cancelQueries({ queryKey: ["notification-group-preview"] });
  }, [enabled, cache]);
  const preview = useQuery({
    queryKey: [
      "notification-group-preview",
      section,
      eventType,
      selectedStage,
      template,
      receiverMode,
      includeDetails,
      kind,
      selectedOffset,
      workOptions,
    ],
    enabled:
      enabled &&
      section !== "basic" &&
      (section !== "birthday" || selectedOffset !== "") &&
      (section !== "events" || (!!eventType && receiverMode === "templates")),
    queryFn: async ({ signal }) => {
      if (section === "birthday")
        return unwrap(
          await client.GET("/api/birthdays/preview", {
            signal,
            params: {
              query: {
                offsetDays:
                  selectedOffset === "7" ? 7 : selectedOffset === "1" ? 1 : 0,
              },
            },
          }),
        );
      if (section === "work")
        return unwrap(
          await client.POST("/api/notifications/work-reminders/preview", {
            signal,
            body: {
              kind: kind === "ready" ? "ready" : "digest",
              ...(workOptions
                ? {
                    digestEnabled: workOptions.digestEnabled,
                    overdueEnabled: workOptions.overdueEnabled,
                    mentionsEnabled: workOptions.mentionsEnabled,
                  }
                : {}),
            },
          }),
        );
      return unwrap(
        await client.POST("/api/notifications/preview", {
          signal,
          body: {
            eventType: eventType as EventOption["type"],
            includeDetails,
            ...(event?.supportsStages ? { stage: selectedStage } : {}),
            ...(receiverMode === "templates" && template
              ? {
                  template: {
                    titleEnabled: template.titleEnabled,
                    authorEnabled: template.authorEnabled,
                    actorEnabled: template.actorEnabled,
                    note: template.note,
                  },
                }
              : {}),
          },
        }),
      );
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (section === "basic")
    return (
      <p className="notification-boundary">
        选择作品通知、工作提醒或生日提醒查看消息。
      </p>
    );
  if (section === "events" && receiverMode !== "templates")
    return (
      <p className="notification-boundary">
        此群使用旧版消息内容，可在作品通知中预览或确认切换事件模板。
      </p>
    );
  return (
    <>
      {section === "events" && (
        <>
          <SelectField
            label="预览事件"
            value={eventType}
            onValueChange={(value) => onEvent(value as EventOption["type"])}
          >
            {events.map((item) => (
              <option key={item.type} value={item.type}>
                {item.label}
              </option>
            ))}
          </SelectField>
          {(event?.allowedStages?.length ?? 0) > 1 && (
            <SelectField
              label="预览环节"
              value={selectedStage ?? ""}
              onValueChange={(value) =>
                setStage(value as keyof typeof stageNames)
              }
            >
              {event?.allowedStages?.map((item) => (
                <option key={item} value={item}>
                  {stageNames[item]}
                </option>
              ))}
            </SelectField>
          )}
        </>
      )}
      {section === "work" && (
        <SelectField label="预览消息" value={kind} onValueChange={setKind}>
          <option value="digest">工作摘要</option>
          <option value="ready">任务交接提醒</option>
        </SelectField>
      )}
      {section === "birthday" && (
        <SelectField
          label="预览日期"
          value={selectedOffset}
          onValueChange={setOffset}
        >
          {offsets.map((day) => (
            <option key={day} value={String(day)}>
              {day === 0 ? "生日当天" : `提前 ${day} 天`}
            </option>
          ))}
        </SelectField>
      )}
      {preview.isError ? (
        <p role="status">预览读取失败。</p>
      ) : (
        <pre className="notification-preview">
          {preview.data?.text ?? "正在生成预览…"}
        </pre>
      )}
      <p className="notification-boundary">
        {section === "events" && !rule
          ? "本群未订阅此事件"
          : section === "events" &&
              rule?.stages &&
              selectedStage &&
              !rule.stages.includes(selectedStage)
            ? "当前预览环节不在接收范围"
            : "合成示例，不会向群发送消息。"}
      </p>
    </>
  );
}
