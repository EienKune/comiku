import { useEffect, useRef, useState } from "react";
import type { components } from "@comiku/api-client";
import { Button, SelectField } from "../../components/ui";
import { Feedback } from "../account/forms";
import { client, unwrap } from "../account/api";

type EventType =
  components["schemas"]["NotificationChannelInputDto"]["eventTypes"][number];
type Stage = components["schemas"]["WorkStage"];
export type SubscriptionRule = { eventType: EventType; stages: null | Stage[] };
export type EventOption = {
  type: EventType;
  label: string;
  supportsStages?: boolean;
  allowedStages?: Stage[];
};
export type Template = {
  eventType: EventType;
  titleEnabled: boolean;
  authorEnabled: boolean;
  actorEnabled: boolean;
  note: string;
  revision: number;
  contentRevision: number;
  referencedGroupCount: number;
};
type Fields = Pick<
  Template,
  "titleEnabled" | "authorEnabled" | "actorEnabled" | "note"
>;
const fields = (t: Fields): Fields => ({
  titleEnabled: t.titleEnabled,
  authorEnabled: t.authorEnabled,
  actorEnabled: t.actorEnabled,
  note: t.note,
});
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "请求失败，请重试。";

function StageSelect({
  value,
  onChange,
  allowedStages,
}: {
  value: Stage;
  onChange: (stage: Stage) => void;
  allowedStages: Stage[];
}) {
  return (
    <SelectField
      label="样例职责"
      value={value}
      onValueChange={(v) => onChange(v as Stage)}
    >
      {allowedStages.map((s) => (
        <option value={s} key={s}>
          {
            {
              translate: "翻译",
              proofread: "校对",
              typeset: "嵌字",
              publish: "发布",
            }[s]
          }
        </option>
      ))}
    </SelectField>
  );
}
type SampleChannel = components["schemas"]["NotificationChannelDto"] & {
  receiverMode?: "legacy" | "templates";
  subscriptionRules?: SubscriptionRule[];
};
export function SavedSample(props: {
  enabled?: boolean;
  channel: SampleChannel;
  templates: Template[];
  events: EventOption[];
  unavailableReason: string;
  onUpdated: () => void;
}) {
  return (
    <SavedSampleSession
      key={JSON.stringify([
        props.channel,
        props.templates.filter((t) =>
          props.channel.eventTypes.includes(t.eventType),
        ),
      ])}
      {...props}
    />
  );
}
function SavedSampleSession({
  enabled = true,
  channel,
  templates,
  events,
  unavailableReason,
  onUpdated,
}: {
  enabled?: boolean;
  channel: SampleChannel;
  templates: Template[];
  events: EventOption[];
  unavailableReason: string;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState<EventType>(
    channel.eventTypes[0] as EventType,
  );
  const [stage, setStage] = useState<Stage>("translate");
  const [body, setBody] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const key = useRef<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    if (!enabled) {
      epoch.current++;
      setOpen(false);
      setBody("");
      setConfirmed(false);
    }
  }, [enabled]);
  const previewSnapshot = useRef<{
    channelId: string;
    revision: number;
    eventType: EventType;
    stage?: Stage;
    templateRevision?: number;
    receiverMode?: string;
  } | null>(null);
  const rule = channel.subscriptionRules?.find(
    (r) => r.eventType === eventType,
  );
  const allowedStages =
    events.find((e) => e.type === eventType)?.allowedStages ?? [];
  const sampleStages = rule?.stages ?? allowedStages;
  const selectedStage = sampleStages.includes(stage) ? stage : sampleStages[0];
  function reset() {
    epoch.current++;
    setBody("");
    setConfirmed(false);
    key.current = null;
    setError("");
    setSuccess("");
  }
  async function preview() {
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    setConfirmed(false);
    try {
      const template = templates.find((t) => t.eventType === eventType);
      const result = await unwrap(
        await client.POST("/api/notifications/preview", {
          body: {
            eventType,
            includeDetails: channel.includeDetails,
            ...(channel.receiverMode === "templates" && template
              ? { template: fields(template) }
              : {}),
            ...(events.find((e) => e.type === eventType)?.supportsStages
              ? { stage: selectedStage }
              : {}),
          },
        }),
      );
      if (current === epoch.current) {
        setBody(result.text);
        previewSnapshot.current = {
          channelId: channel.id,
          revision: channel.revision,
          eventType,
          ...(events.find((e) => e.type === eventType)?.supportsStages
            ? { stage: selectedStage }
            : {}),
          templateRevision:
            channel.receiverMode === "templates"
              ? template?.revision
              : undefined,
          receiverMode: channel.receiverMode,
        };
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    const snapshot = previewSnapshot.current;
    if (!body || !confirmed || unavailableReason || !snapshot) return;
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      const result = await client.POST(
        "/api/notifications/channels/{id}/test",
        {
          params: { path: { id: snapshot.channelId } },
          body: {
            eventType: snapshot.eventType,
            expectedRevision: snapshot.revision,
            idempotencyKey: key.current,
            ...(snapshot.receiverMode === "templates"
              ? { expectedTemplateRevision: snapshot.templateRevision }
              : {}),
            ...(snapshot.stage ? { stage: snapshot.stage } : {}),
          },
        },
      );
      if (result.response.status === 409) {
        setBody("");
        setConfirmed(false);
        key.current = null;
        throw new Error("已保存配置发生变化，请刷新配置后重新预览并确认。");
      }
      await unwrap(result);
      key.current = null;
      setSuccess("样例已排队，请到投递记录核实。");
      setConfirmed(false);
      onUpdated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="notification-sample">
      <span
        className="notification-disabled-tooltip"
        tabIndex={unavailableReason ? 0 : undefined}
        aria-label={
          unavailableReason ? `发送样例：${unavailableReason}` : undefined
        }
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={!enabled || !!unavailableReason}
          onClick={() => setOpen(!open)}
        >
          发送样例
        </Button>
        {unavailableReason && <span role="tooltip">{unavailableReason}</span>}
      </span>
      {open && enabled && (
        <div className="notification-editor">
          <strong>
            合成样例 → {channel.name}（QQ 群 {channel.groupId}）
          </strong>
          <fieldset disabled={busy}>
            <SelectField
              label="样例事件"
              value={eventType}
              onValueChange={(v) => {
                reset();
                setEventType(v as EventType);
              }}
            >
              {channel.eventTypes.map((type) => (
                <option key={type} value={type}>
                  {events.find((e) => e.type === type)?.label ?? type}
                </option>
              ))}
            </SelectField>
            {events.find((e) => e.type === eventType)?.supportsStages &&
              (sampleStages.length > 1 ? (
                <StageSelect
                  allowedStages={sampleStages}
                  value={selectedStage}
                  onChange={(s) => {
                    reset();
                    setStage(s);
                  }}
                />
              ) : (
                <p className="notification-boundary">
                  样例职责：
                  {
                    {
                      translate: "翻译",
                      proofread: "校对",
                      typeset: "嵌字",
                      publish: "发布",
                    }[selectedStage]
                  }
                </p>
              ))}
            <Button
              type="button"
              variant="secondary"
              loading={busy}
              onClick={() => void preview()}
            >
              预览已保存样例
            </Button>
            {body && (
              <>
                <pre className="notification-preview">{body}</pre>
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  确认目标群与以上正文
                </label>
              </>
            )}
            <Button
              disabled={!body || !confirmed || !!unavailableReason}
              loading={busy}
              onClick={() => void send()}
            >
              确认排队
            </Button>
            <Feedback error={error} success={success} />
          </fieldset>
        </div>
      )}
    </div>
  );
}
