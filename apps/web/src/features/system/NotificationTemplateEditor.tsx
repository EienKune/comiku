import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import type { components } from "@comiku/api-client";
import {
  Button,
  IconButton,
  SelectField,
  TextField,
} from "../../components/ui";
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
export function TemplateEditor({
  templates,
  events,
  onUpdated,
  enabled = true,
}: {
  enabled?: boolean;
  templates: Template[];
  events: EventOption[];
  onUpdated: () => void;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<EventType, Template>>>(
    {},
  );
  const [active, setActive] = useState<EventType | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useLayoutEffect(() => {
    if (!active || !enabled) return;
    const element = dialog.current;
    if (!element) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    heading.current?.focus({ preventScroll: true });
    return () => {
      if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
      document.body.style.overflow = previousOverflow;
      if (opener.current?.isConnected)
        opener.current.focus({ preventScroll: true });
    };
  }, [active, enabled]);
  const [stage, setStage] = useState<Stage>("translate");
  const [missing, setMissing] = useState(false);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const epoch = useRef(0);
  const [comparison, setComparison] = useState<Template | null>(null);
  const draft = active ? drafts[active] : undefined;
  function change(patch: Partial<Template>) {
    epoch.current++;
    setPreview("");
    setSuccess("");
    setDrafts((d) => ({ ...d, [active!]: { ...d[active!]!, ...patch } }));
  }
  async function save() {
    if (!draft) return;
    if (Array.from(draft.note).length > 120) {
      setError("事件提示语最多 120 个字符。");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await client.PATCH(
        "/api/notifications/templates/{eventType}",
        {
          params: { path: { eventType: draft.eventType } },
          body: { expectedRevision: draft.revision, ...fields(draft) },
        },
      );
      if (result.response.status === 409)
        throw new Error(
          "模板已被其他管理员修改。草稿已保留，请比较当前版本后核对。",
        );
      const saved = await unwrap(result);
      setDrafts((d) => ({ ...d, [draft.eventType]: saved }));
      setSuccess("模板已保存，只影响之后首次捕获的通知。");
      onUpdated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function compareCurrent() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const config = await unwrap(
        await client.GET("/api/notifications/configuration"),
      );
      const current = config.templates.find(
        (t) => t.eventType === draft.eventType,
      );
      if (!current) throw new Error("模板读取失败，请重试。");
      setComparison({ ...current, eventType: draft.eventType });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const previewInput = useMemo(
    () =>
      draft
        ? {
            eventType: draft.eventType,
            includeDetails: false,
            template: fields(draft),
            ...(events.find((event) => event.type === draft.eventType)
              ?.supportsStages
              ? { stage }
              : {}),
            missingMetadata: missing,
          }
        : null,
    [draft, events, stage, missing],
  );
  const previousNote = useRef("");
  useEffect(() => {
    const current = ++epoch.current;
    const controller = new AbortController();
    const note = previewInput?.template.note ?? "";
    const delay = note !== previousNote.current ? 300 : 0;
    previousNote.current = note;
    setPreview("");
    setPreviewError("");
    setPreviewBusy(false);
    if (
      !active ||
      !enabled ||
      !visible ||
      !previewInput ||
      Array.from(note).length > 120
    )
      return;
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await unwrap(
            await client.POST("/api/notifications/preview", {
              signal: controller.signal,
              body: previewInput,
            }),
          );
          if (!controller.signal.aborted && current === epoch.current)
            setPreview(result.text);
        } catch (caught) {
          if (!controller.signal.aborted && current === epoch.current)
            setPreviewError(errorMessage(caught));
        } finally {
          if (!controller.signal.aborted && current === epoch.current)
            setPreviewBusy(false);
        }
      })();
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [previewInput, active, enabled, visible]);
  function close() {
    epoch.current++;
    setActive(null);
  }
  function dismissExpandedSelector() {
    const selector = dialog.current?.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-expanded="true"]',
    );
    if (!selector) return false;
    // SelectControl owns its open state. Its trigger closes it without changing the selected value.
    selector.click();
    selector.focus({ preventScroll: true });
    return true;
  }
  return (
    <div className="notification-template-layout">
      <TextField
        label="搜索事件名称"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="notification-templates">
        {templates
          .filter((template) =>
            (
              events.find((event) => event.type === template.eventType)
                ?.label ?? template.eventType
            )
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase()),
          )
          .map((t) => (
            <article className="notification-template-row" key={t.eventType}>
              <div>
                <strong>
                  {events.find((e) => e.type === t.eventType)?.label ??
                    t.eventType}
                </strong>
                <span className="notification-boundary">
                  {[
                    t.titleEnabled && "标题",
                    t.authorEnabled && "作者",
                    t.actorEnabled && "操作人",
                  ]
                    .filter(Boolean)
                    .join(" · ") || "仅固定事实"}{" "}
                  · {t.referencedGroupCount} 群引用
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                aria-label={`编辑模板 ${events.find((e) => e.type === t.eventType)?.label ?? t.eventType}`}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  epoch.current++;
                  setActive(t.eventType);
                  setComparison(null);
                  setStage(
                    events.find((e) => e.type === t.eventType)
                      ?.allowedStages?.[0] ?? "translate",
                  );
                  setDrafts((d) => ({
                    ...d,
                    [t.eventType]: d[t.eventType] ?? { ...t },
                  }));
                  setPreview("");
                  setError("");
                  setSuccess("");
                }}
              >
                编辑
              </Button>
            </article>
          ))}
      </div>
      {draft && enabled && (
        <dialog
          ref={dialog}
          className="notification-template-dialog"
          aria-labelledby={headingId}
          onCancel={(event) => {
            event.preventDefault();
            if (!dismissExpandedSelector()) close();
          }}
          onKeyDownCapture={(event) => {
            if (event.key === "Escape" && dismissExpandedSelector()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
              return;
            }
            if (event.key !== "Tab") return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
              ),
            ).filter((element) => !element.closest("[hidden]"));
            const first = controls[0];
            const last = controls.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === heading.current)
            ) {
              event.preventDefault();
              last?.focus({ preventScroll: true });
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus({ preventScroll: true });
            }
          }}
        >
          <form
            className="notification-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <header className="notification-heading">
              <h3 id={headingId} ref={heading} tabIndex={-1}>
                {events.find((e) => e.type === active)?.label}模板
              </h3>
              <IconButton type="button" label="关闭" onClick={close}>
                <X size={18} aria-hidden="true" />
              </IconButton>
            </header>
            <fieldset disabled={busy}>
              <div className="notification-actions">
                {(
                  [
                    ["titleEnabled", "作品标题"],
                    ["authorEnabled", "作者"],
                    ["actorEnabled", "操作人"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="notification-check" key={key}>
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      onChange={(e) => change({ [key]: e.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <TextField
                label="事件提示语"
                value={draft.note}
                onChange={(e) => change({ note: e.target.value })}
              />
              <p className="notification-boundary">
                {Array.from(draft.note).length}/120 · 保存将影响引用此事件模板的{" "}
                {draft.referencedGroupCount} 个群，已有待发保留原文。
              </p>
              <div className="notification-preview-controls">
                {events.find((e) => e.type === active)?.supportsStages && (
                  <StageSelect
                    allowedStages={
                      events.find((e) => e.type === active)?.allowedStages ?? []
                    }
                    value={stage}
                    onChange={(s) => {
                      if (s === stage) return;
                      epoch.current++;
                      setStage(s);
                      setPreview("");
                    }}
                  />
                )}
                <SelectField
                  label="样例资料"
                  value={missing ? "missing" : "full"}
                  onValueChange={(v) => {
                    if ((v === "missing") === missing) return;
                    epoch.current++;
                    setMissing(v === "missing");
                    setPreview("");
                  }}
                >
                  <option value="full">完整资料</option>
                  <option value="missing">缺少资料</option>
                </SelectField>
              </div>
              {previewBusy && <p role="status">正在预览…</p>}
              {preview && <pre className="notification-preview">{preview}</pre>}
              <Feedback error={previewError} />
              <div className="notification-actions">
                <Button
                  type="submit"
                  loading={busy}
                  disabled={Array.from(draft.note).length > 120}
                >
                  保存模板
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setDrafts((d) => ({ ...d, [active!]: undefined }));
                    close();
                  }}
                >
                  放弃草稿
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void compareCurrent()}
                >
                  比较当前版本
                </Button>
              </div>
              {comparison && (
                <div className="notification-content">
                  <strong>当前服务器版本 {comparison.revision}</strong>
                  <p className="notification-boundary">
                    {[
                      comparison.titleEnabled && "标题",
                      comparison.authorEnabled && "作者",
                      comparison.actorEnabled && "操作人",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "仅固定事实"}
                  </p>
                  <pre className="notification-preview">
                    {comparison.note || "无事件提示语"}
                  </pre>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      epoch.current++;
                      setPreview("");
                      setDrafts((d) => ({
                        ...d,
                        [active!]: {
                          ...d[active!]!,
                          revision: comparison.revision,
                          contentRevision: comparison.contentRevision,
                          referencedGroupCount: comparison.referencedGroupCount,
                        },
                      }));
                      setComparison(null);
                      setError("");
                      setSuccess(
                        "已采用当前版本号，草稿字段保留。请核对后保存。",
                      );
                    }}
                  >
                    保留草稿并以当前版本重试
                  </Button>
                </div>
              )}
              <Feedback error={error} success={success} />
            </fieldset>
          </form>
        </dialog>
      )}
    </div>
  );
}

type SampleChannel = components["schemas"]["NotificationChannelDto"] & {
  receiverMode?: "legacy" | "templates";
  subscriptionRules?: SubscriptionRule[];
};
export function SavedSample(props: {
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
  channel,
  templates,
  events,
  unavailableReason,
  onUpdated,
}: {
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
      <Button
        variant="secondary"
        size="sm"
        disabled={!!unavailableReason}
        onClick={() => setOpen(!open)}
      >
        发送样例
      </Button>
      {unavailableReason && (
        <span className="notification-boundary">{unavailableReason}</span>
      )}
      {open && (
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
