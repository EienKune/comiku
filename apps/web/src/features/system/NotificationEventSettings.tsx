import { useState } from "react";
import { Button, IconButton } from "../../components/ui";
import { Eye } from "lucide-react";
import type {
  EventOption,
  SubscriptionRule,
} from "./NotificationTemplateEditor";

type EventType = EventOption["type"];
import {
  categories,
  keyEvents,
  stageNames,
} from "./notification-event-categories";

export function NotificationEventSettings({
  events,
  rules,
  onChange,
  onPreview,
}: {
  events: EventOption[];
  rules: SubscriptionRule[];
  onChange: (rules: SubscriptionRule[]) => void;
  onPreview: (event: EventOption) => void;
}) {
  const [expanded, setExpanded] = useState("");
  const [scope, setScope] = useState("");
  const [feedback, setFeedback] = useState("");
  function choose(types: EventType[]) {
    onChange(
      types.map(
        (eventType) =>
          rules.find((rule) => rule.eventType === eventType) ?? {
            eventType,
            stages: null,
          },
      ),
    );
  }
  return (
    <section aria-label="作品通知">
      <header className="notification-heading">
        <h3>作品通知</h3>
        <span>
          {rules.length} / {events.length}
        </span>
      </header>
      <div className="notification-event-presets">
        <span>快捷选择</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            choose(
              events
                .filter((event) => keyEvents.includes(event.type))
                .map((event) => event.type),
            )
          }
        >
          关键进展
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => choose(events.map((event) => event.type))}
        >
          全部事件
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([])}
        >
          清空
        </Button>
      </div>
      {categories.map((category) => {
        const items = events.filter(
          (event) =>
            category.ids.includes(event.type) ||
            (category.name === "制作进度" &&
              !categories.some((item) => item.ids.includes(event.type))),
        );
        return (
          <section className="notification-event-category" key={category.name}>
            <button
              type="button"
              className="notification-category-heading"
              aria-expanded={expanded === category.name}
              onClick={() =>
                setExpanded(expanded === category.name ? "" : category.name)
              }
            >
              <strong>{category.name}</strong>
              <span>
                {
                  rules.filter((rule) =>
                    items.some((event) => event.type === rule.eventType),
                  ).length
                }{" "}
                / {items.length} {expanded === category.name ? "⌃" : "⌄"}
              </span>
            </button>
            <div hidden={expanded !== category.name}>
              <div className="notification-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    choose([
                      ...new Set([
                        ...rules.map((rule) => rule.eventType),
                        ...items.map((event) => event.type),
                      ]),
                    ])
                  }
                >
                  全选本组
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange(
                      rules.filter(
                        (rule) =>
                          !items.some((event) => event.type === rule.eventType),
                      ),
                    )
                  }
                >
                  清空本组
                </Button>
              </div>
              {items.map((event) => {
                const rule = rules.find(
                  (item) => item.eventType === event.type,
                );
                return (
                  <div className="notification-event-rule" key={event.type}>
                    <div className="notification-heading">
                      <label className="notification-check">
                        <input
                          type="checkbox"
                          checked={!!rule}
                          onChange={(change) =>
                            onChange(
                              change.target.checked
                                ? [
                                    ...rules,
                                    { eventType: event.type, stages: null },
                                  ]
                                : rules.filter(
                                    (item) => item.eventType !== event.type,
                                  ),
                            )
                          }
                        />
                        {event.label}
                      </label>
                      <IconButton
                        type="button"
                        label={`预览 ${event.label}`}
                        onClick={() => onPreview(event)}
                      >
                        <Eye size={16} />
                      </IconButton>
                    </div>
                    {rule &&
                      event.supportsStages &&
                      (event.allowedStages?.length ?? 0) > 1 && (
                        <>
                          <button
                            type="button"
                            className="notification-scope-trigger"
                            aria-expanded={scope === event.type}
                            onClick={() =>
                              setScope(scope === event.type ? "" : event.type)
                            }
                          >
                            适用环节：
                            {rule.stages === null
                              ? "全部环节"
                              : rule.stages
                                  .map((stage) => stageNames[stage])
                                  .join("、")}
                          </button>
                          <div
                            className="notification-stage-rules"
                            hidden={scope !== event.type}
                          >
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                onChange(
                                  rules.map((item) =>
                                    item === rule
                                      ? { ...item, stages: null }
                                      : item,
                                  ),
                                )
                              }
                            >
                              全部环节
                            </Button>
                            {event.allowedStages?.map((stage) => (
                              <label className="notification-check" key={stage}>
                                <input
                                  type="checkbox"
                                  aria-label={`${event.label}：${stageNames[stage]}`}
                                  checked={
                                    rule.stages === null ||
                                    rule.stages.includes(stage)
                                  }
                                  onChange={() => {
                                    const selected =
                                      rule.stages ?? event.allowedStages ?? [];
                                    const stages = selected.includes(stage)
                                      ? selected.filter(
                                          (item) => item !== stage,
                                        )
                                      : [...selected, stage];
                                    if (!stages.length) {
                                      setFeedback("至少保留一个适用环节。");
                                      return;
                                    }
                                    setFeedback("");
                                    onChange(
                                      rules.map((item) =>
                                        item === rule
                                          ? { ...item, stages }
                                          : item,
                                      ),
                                    );
                                  }}
                                />
                                {stageNames[stage]}
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      <p className="notification-boundary">
        适用环节筛选消息内容，不改变群里的接收成员。
      </p>
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
