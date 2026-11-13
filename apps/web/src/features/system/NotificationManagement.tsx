import {
  WorkReminderSubscriptions,
  WorkReminderTemplate,
} from "./WorkReminderPanels";
import { BirthdayTemplate } from "../birthdays/BirthdayNotificationPanels";
import { BirthdayReminderSettings } from "../birthdays/BirthdayReminderSettings";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import {
  Badge,
  Button,
  SelectField,
  Surface,
  TextField,
} from "../../components/ui";
import { client, unwrap } from "../account/api";
import { Feedback } from "../account/forms";
import "./notifications.css";
import { localDayBoundary } from "./notification-history";
import { NotificationStatusPanel } from "./NotificationStatusPanel";
import {
  TemplateEditor,
  SavedSample,
  type Template,
  type SubscriptionRule,
  type EventOption,
} from "./NotificationTemplateEditor";

type Channel = components["schemas"]["NotificationChannelDto"] & {
  receiverMode?: "legacy" | "templates";
  subscriptionRules?: SubscriptionRule[];
};
type Delivery = components["schemas"]["NotificationDeliveryDto"];
type ChannelInput = components["schemas"]["NotificationChannelInputDto"] & {
  receiverMode?: "legacy" | "templates";
  subscriptionRules?: SubscriptionRule[];
};
type EventType = ChannelInput["eventTypes"][number];
const statusLabels: Record<Delivery["status"], string> = {
  pending: "排队中",
  sending: "发送中",
  retry_wait: "等待重试",
  accepted: "平台已接收",
  failed: "发送失败",
  unknown: "结果未知",
  cancelled: "已取消",
};
function tone(status: string) {
  return status === "accepted"
    ? ("success" as const)
    : status === "unknown"
      ? ("warning" as const)
      : status === "failed"
        ? ("danger" as const)
        : ("neutral" as const);
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请重试。";
}

export function NotificationManagement({
  enabled = true,
}: {
  enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("groups");
  const [adopting, setAdopting] = useState(false);
  const [adoptionPreview, setAdoptionPreview] = useState("");
  const [adoptionPreviewIdentity, setAdoptionPreviewIdentity] = useState("");
  const [adoptionRequired, setAdoptionRequired] = useState(false);
  const [adoptionRevisions, setAdoptionRevisions] = useState<
    Pick<Template, "eventType" | "revision">[] | null
  >(null);
  const [confirmedAdoptionIdentity, setConfirmedAdoptionIdentity] =
    useState("");
  const latestAdoptionIdentity = useRef("");
  const [adoptionBusy, setAdoptionBusy] = useState(false);
  const configuration = useQuery({
    queryKey: ["notification-configuration"],
    enabled: enabled && tab !== "status",
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/notifications/configuration", { signal })),
    refetchOnWindowFocus: false,
  });
  // The server-owned event catalogue and channel inputs share the same keys.
  const eventTypes = (configuration.data?.eventTypes ?? []) as EventOption[];
  const templates =
    (
      configuration.data as typeof configuration.data & {
        templates?: Template[];
      }
    )?.templates ?? [];
  const emptyFilters = {
    status: "" as Delivery["status"] | "",
    groupId: "",
    workNumber: "",
    eventType: "" as
      | EventType
      | "notification.test"
      | "birthday.reminder"
      | "work.digest"
      | "work.ready"
      | "",
    createdFrom: "",
    createdThrough: "",
  };
  const [filterForm, setFilterForm] = useState(emptyFilters);
  const [history, setHistory] = useState({
    filters: emptyFilters,
    cursors: [""],
    generation: 0,
  });
  const [filterError, setFilterError] = useState("");
  const applied = history.filters;
  const cursor = history.cursors.at(-1) || undefined;
  const deliveries = useQuery({
    queryKey: ["notification-deliveries", applied, cursor, history.generation],
    enabled: enabled && tab === "history",
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/notifications/deliveries", {
          signal,
          params: {
            query: {
              cursor,
              status: applied.status || undefined,
              groupId: applied.groupId || undefined,
              workNumber: applied.workNumber
                ? Number(applied.workNumber)
                : undefined,
              eventType: applied.eventType || undefined,
              createdFrom: localDayBoundary(applied.createdFrom),
              createdBefore: localDayBoundary(applied.createdThrough, true),
              limit: 20,
            },
          },
        }),
      ),
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!enabled || tab !== "history")
      void queryClient.cancelQueries({ queryKey: ["notification-deliveries"] });
    if (!enabled || tab === "status")
      void queryClient.cancelQueries({
        queryKey: ["notification-configuration"],
      });
  }, [enabled, tab, queryClient]);
  function applyFilters(reset = false) {
    const filters = reset
      ? emptyFilters
      : {
          ...filterForm,
          groupId: filterForm.groupId.trim(),
          workNumber: filterForm.workNumber.trim(),
        };
    if (filters.groupId && !/^[1-9][0-9]{0,19}$/.test(filters.groupId)) {
      setFilterError("请输入有效的原目标群号。");
      return;
    }
    if (
      filters.workNumber &&
      (!/^[1-9][0-9]*$/.test(filters.workNumber) ||
        Number(filters.workNumber) > 2147483647)
    ) {
      setFilterError("请输入有效的作品编号。");
      return;
    }
    if (
      filters.createdFrom &&
      filters.createdThrough &&
      filters.createdFrom > filters.createdThrough
    ) {
      setFilterError("开始日期不能晚于结束日期。");
      return;
    }
    setFilterError("");
    if (reset) setFilterForm(emptyFilters);
    setHistory((current) => ({
      filters,
      cursors: [""],
      generation: current.generation + 1,
    }));
  }
  const [draft, setDraft] = useState<
    (ChannelInput & { id?: string; expectedRevision?: number }) | null
  >(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [comparison, setComparison] = useState<
    (Channel & { connectionName: string }) | null
  >(null);
  const [previewType, setPreviewType] = useState<EventType | "">("");
  const [preview, setPreview] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewEpoch = useRef(0);
  function changeDraft(patch: Partial<ChannelInput>) {
    previewEpoch.current++;
    setPreview("");
    setAdopting(false);
    setAdoptionPreview("");
    setAdoptionRevisions(null);
    setConfirmedAdoptionIdentity("");
    setDraft((current) => (current ? { ...current, ...patch } : null));
  }
  function edit(channel?: Channel) {
    if (saving) return;
    previewEpoch.current++;
    setPreview("");
    setAdopting(false);
    setAdoptionPreview("");
    setAdoptionRevisions(null);
    setConfirmedAdoptionIdentity("");
    setAdoptionRequired(
      !!channel && (channel.receiverMode ?? "legacy") === "legacy",
    );
    setError("");
    setSuccess("");
    setComparison(null);
    setPreviewType(eventTypes[0]?.type ?? "");
    setDraft(
      channel
        ? {
            id: channel.id,
            expectedRevision: channel.revision,
            name: channel.name,
            groupId: channel.groupId,
            connectionKey: channel.connectionKey,
            enabled: channel.enabled,
            eventTypes: [...channel.eventTypes] as EventType[],
            includeDetails: channel.includeDetails,
            receiverMode: channel.receiverMode ?? "legacy",
            subscriptionRules:
              channel.subscriptionRules ??
              (channel.eventTypes as EventType[]).map((eventType) => ({
                eventType,
                stages: null,
              })),
          }
        : {
            name: "",
            groupId: "",
            connectionKey: configuration.data?.connections[0]?.key ?? "",
            enabled: false,
            eventTypes: [],
            includeDetails: false,
            receiverMode: "templates",
            subscriptionRules: [],
          },
    );
  }
  async function save() {
    if (!draft) return;
    if (draft.subscriptionRules?.some((rule) => rule.stages?.length === 0)) {
      setError("指定职责时至少选择一个职责。");
      return;
    }
    const adoptingTemplates =
      adoptionRequired && draft.receiverMode === "templates";
    if (
      adoptingTemplates &&
      (!adoptionRevisions || confirmedAdoptionIdentity !== adoptionIdentity)
    ) {
      setError("请重新预览并确认所选事件模板后保存。");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    const { id, expectedRevision, ...input } = draft;
    try {
      const result = id
        ? await client.PATCH("/api/notifications/channels/{id}", {
            params: { path: { id } },
            body: {
              ...input,
              expectedRevision: expectedRevision!,
              ...(adoptingTemplates
                ? { expectedTemplateRevisions: adoptionRevisions! }
                : {}),
            },
          })
        : await client.POST("/api/notifications/channels", { body: input });
      if (result.response.status === 409) {
        setComparison(null);
        setConfirmedAdoptionIdentity("");
        setAdoptionRevisions(null);
        setAdopting(false);
        setAdoptionPreview("");
        if (adoptingTemplates) {
          // Refresh the preview source without rebasing the channel CAS or draft.
          await queryClient.invalidateQueries({
            queryKey: ["notification-configuration"],
          });
          const serverError = result.error;
          if (
            typeof serverError === "object" &&
            serverError !== null &&
            "message" in serverError &&
            typeof serverError.message === "string" &&
            serverError.message.includes("模板")
          ) {
            throw new Error(serverError.message);
          }
        }
        throw new Error(
          "配置已被其他管理员修改。草稿已保留，请比较当前版本后核对。",
        );
      }
      await unwrap(result);
      setDraft(null);
      setSuccess("配置已保存");
      void queryClient.invalidateQueries({
        queryKey: ["birthdays", "subscriptions"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["notification-configuration"],
      });
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(false);
    }
  }
  async function compareCurrent() {
    if (!draft?.id) return;
    setSaving(true);
    setError("");
    setComparison(null);
    try {
      const current = await unwrap(
        await client.GET("/api/notifications/configuration"),
      );
      queryClient.setQueryData(["notification-configuration"], current);
      const channel = current.channels.find((c) => c.id === draft.id);
      if (!channel) throw new Error("此群配置已不存在，请核对后重新选择。");
      setComparison({
        ...channel,
        connectionName:
          current.connections.find((c) => c.key === channel.connectionKey)
            ?.name ?? "连接已缺失",
      });
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(false);
    }
  }
  async function showPreview() {
    if (!draft || !previewType) return;
    const epoch = ++previewEpoch.current;
    setPreviewBusy(true);
    setError("");
    try {
      const result = await unwrap(
        await client.POST("/api/notifications/preview", {
          body: {
            eventType: previewType,
            includeDetails: draft.includeDetails,
          },
        }),
      );
      if (epoch === previewEpoch.current) setPreview(result.text);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setPreviewBusy(false);
    }
  }
  const data = configuration.data;
  const adoptionIdentity = JSON.stringify([
    draft && { ...draft, receiverMode: undefined },
    (draft?.eventTypes ?? []).map((eventType) => {
      const template = templates.find((t) => t.eventType === eventType);
      return [
        eventType,
        template?.revision,
        template?.contentRevision,
        template?.titleEnabled,
        template?.authorEnabled,
        template?.actorEnabled,
        template?.note,
      ];
    }),
  ]);
  useLayoutEffect(() => {
    if (latestAdoptionIdentity.current !== adoptionIdentity) {
      previewEpoch.current++;
      setAdopting(false);
      setAdoptionPreview("");
      setAdoptionRevisions(null);
      setConfirmedAdoptionIdentity("");
    }
    latestAdoptionIdentity.current = adoptionIdentity;
  }, [adoptionIdentity]);
  const original = data?.channels.find((c) => c.id === draft?.id) as
    Channel | undefined;
  const audienceChanged =
    !!original &&
    !!draft &&
    (original.groupId !== draft.groupId ||
      original.connectionKey !== draft.connectionKey ||
      original.enabled !== draft.enabled ||
      JSON.stringify(
        original.subscriptionRules ??
          original.eventTypes.map((eventType) => ({ eventType, stages: null })),
      ) !== JSON.stringify(draft.subscriptionRules));
  async function adoption() {
    if (!draft) return;
    const epoch = ++previewEpoch.current;
    const identity = adoptionIdentity;
    const revisions = draft.eventTypes.map((eventType) => {
      const template = templates.find((t) => t.eventType === eventType);
      if (
        !template ||
        !Number.isInteger(template.revision) ||
        template.revision < 0
      )
        return null;
      return { eventType, revision: template.revision };
    });
    if (revisions.some((revision) => revision === null)) {
      setError("事件模板配置缺失，请刷新配置后重新预览并确认。");
      return;
    }
    setAdoptionRevisions(null);
    setConfirmedAdoptionIdentity("");
    setAdoptionPreviewIdentity(identity);
    setAdopting(true);
    setAdoptionPreview("");
    setAdoptionBusy(true);
    setError("");
    try {
      const texts = await Promise.all(
        draft.eventTypes.map(async (eventType) => {
          const template = templates.find((t) => t.eventType === eventType);
          return (
            await unwrap(
              await client.POST("/api/notifications/preview", {
                body: {
                  eventType,
                  includeDetails: false,
                  ...(eventTypes.find((e) => e.type === eventType)
                    ?.supportsStages
                    ? {
                        stage:
                          draft.subscriptionRules?.find(
                            (r) => r.eventType === eventType,
                          )?.stages?.[0] ??
                          eventTypes.find((e) => e.type === eventType)
                            ?.allowedStages?.[0],
                      }
                    : {}),
                  template: template
                    ? {
                        titleEnabled: template.titleEnabled,
                        authorEnabled: template.authorEnabled,
                        actorEnabled: template.actorEnabled,
                        note: template.note,
                      }
                    : undefined,
                },
              }),
            )
          ).text;
        }),
      );
      if (
        epoch === previewEpoch.current &&
        identity === latestAdoptionIdentity.current
      ) {
        setAdoptionRevisions(revisions.filter((revision) => revision !== null));
        setAdoptionPreview(
          texts.join("\n\n") ||
            "此群尚未订阅事件，切换后使用各事件的公共模板。",
        );
      }
    } catch (caught) {
      if (
        epoch === previewEpoch.current &&
        identity === latestAdoptionIdentity.current
      )
        setError(message(caught));
    } finally {
      setAdoptionBusy(false);
    }
  }

  return (
    <Surface className="notification-management">
      <header className="notification-heading">
        <h2>推送通知</h2>
        {(tab === "groups" || tab === "templates") && (
          <div className="notification-actions">
            <Button
              variant="ghost"
              size="sm"
              loading={configuration.isFetching}
              onClick={() => void configuration.refetch()}
            >
              刷新配置
            </Button>
          </div>
        )}
      </header>
      <div
        className="system-tabs notification-tabs"
        role="tablist"
        aria-label="推送通知分类"
      >
        {[
          ["groups", "推送设置"],
          ["templates", "消息模板"],
          ["history", "投递记录"],
          ["status", "运行状态"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`notification-tab-${value}`}
            aria-controls={`notification-panel-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              );
              const index = buttons.indexOf(event.currentTarget);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index +
                        (event.key === "ArrowRight" ? 1 : buttons.length - 1)) %
                      buttons.length;
              buttons[next].focus();
              buttons[next].click();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="notification-panel-groups"
        aria-labelledby="notification-tab-groups"
        hidden={tab !== "groups"}
      >
        {configuration.isPending && <p role="status">正在读取通知配置…</p>}
        {configuration.isError && (
          <p role="alert">通知配置读取失败，请刷新重试。</p>
        )}
        {data && (
          <>
            {!data.enabled && <p className="account-notice">通知服务已关闭</p>}
            {data.configurationError && (
              <p className="account-error" role="alert">
                连接配置不可用：{data.configurationError}
              </p>
            )}
            <p className="notification-boundary">
              核心作品事件启用后异步补账推送，通知失败不影响作品操作；启用前历史不自动补推。
            </p>
            <details
              className="notification-connections"
              aria-labelledby="notification-connections-heading"
            >
              <summary id="notification-connections-heading">连接配置</summary>
              {data.connections.map((connection) => (
                <div key={connection.key} className="notification-connection">
                  <strong>{connection.name}</strong>
                  <Badge tone={connection.available ? "neutral" : "warning"}>
                    {connection.available ? "配置可用" : "配置不可用"}
                  </Badge>
                </div>
              ))}
              {data.connections.length === 0 && <p>暂无连接配置。</p>}
              <p className="notification-boundary">
                连接状态仅反映服务端配置，不代表 QQ 登录状态。
              </p>
            </details>
            <header className="notification-heading notification-section-heading">
              <h3>接收群</h3>
              <Button size="sm" disabled={saving} onClick={() => edit()}>
                新增群目标
              </Button>
            </header>
            <div className="notification-channels">
              {data.channels.map((channel) => (
                <article key={channel.id} className="notification-channel">
                  <div>
                    <strong>{channel.name}</strong>
                    <span>QQ 群 {channel.groupId}</span>
                    <span>
                      {data.connections.find(
                        (connection) =>
                          connection.key === channel.connectionKey,
                      )?.name ?? "连接已缺失"}
                      {data.connections.some(
                        (connection) =>
                          connection.key === channel.connectionKey &&
                          !connection.available,
                      ) && "（不可用）"}
                    </span>
                  </div>
                  <span className="notification-boundary">
                    {channel.eventTypes
                      .map(
                        (type) =>
                          eventTypes.find((e) => e.type === type)?.label ??
                          type,
                      )
                      .join(" · ") || "未订阅事件"}
                  </span>
                  <Badge tone={channel.enabled ? "success" : "neutral"}>
                    {channel.enabled ? "已启用" : "已停用"}
                  </Badge>
                  <div className="notification-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`编辑 ${channel.name}`}
                      disabled={saving}
                      onClick={() => edit(channel)}
                    >
                      编辑
                    </Button>
                    <SavedSample
                      channel={channel as Channel}
                      templates={templates}
                      events={eventTypes}
                      unavailableReason={
                        !data.enabled
                          ? "通知服务已关闭"
                          : !channel.enabled
                            ? "此群已停用"
                            : !data.connections.some(
                                  (c) =>
                                    c.key === channel.connectionKey &&
                                    c.available,
                                )
                              ? "连接配置不可用"
                              : channel.eventTypes.length === 0
                                ? "此群尚未订阅事件"
                                : ""
                      }
                      onUpdated={() =>
                        void queryClient.invalidateQueries({
                          queryKey: ["notification-deliveries"],
                        })
                      }
                    />
                  </div>
                </article>
              ))}
            </div>
            {data.channels.length === 0 && <p>暂无群目标。</p>}
          </>
        )}
        <Feedback error={error} success={success} />
        {draft && data && (
          <form
            className="notification-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h3>{draft.id ? "编辑群目标" : "新增群目标"}</h3>
            <fieldset disabled={saving}>
              <div className="notification-fields">
                <TextField
                  label="名称"
                  required
                  maxLength={80}
                  value={draft.name}
                  onChange={(event) =>
                    changeDraft({ name: event.target.value })
                  }
                />
                <TextField
                  label="群号"
                  required
                  inputMode="numeric"
                  pattern="[1-9][0-9]{0,19}"
                  maxLength={20}
                  value={draft.groupId}
                  onChange={(event) =>
                    changeDraft({ groupId: event.target.value })
                  }
                />
                <SelectField
                  label="连接"
                  value={draft.connectionKey}
                  required
                  onValueChange={(value) =>
                    changeDraft({ connectionKey: value })
                  }
                >
                  {!data.connections.some(
                    (connection) => connection.key === draft.connectionKey,
                  ) && (
                    <option value={draft.connectionKey}>
                      {draft.connectionKey ? "连接已缺失" : "请选择连接"}
                    </option>
                  )}
                  {data.connections.map((connection) => (
                    <option key={connection.key} value={connection.key}>
                      {connection.name}
                      {connection.available ? "" : "（不可用）"}
                    </option>
                  ))}
                </SelectField>
              </div>
              <label className="notification-check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    changeDraft({ enabled: event.target.checked })
                  }
                />
                启用此群通知
              </label>
              <fieldset className="notification-events">
                <legend>事件</legend>
                {eventTypes.map((event) => {
                  const rule = draft.subscriptionRules?.find(
                    (r) => r.eventType === event.type,
                  );
                  return (
                    <div key={event.type} className="notification-event-rule">
                      <label className="notification-check">
                        <input
                          type="checkbox"
                          checked={draft.eventTypes.includes(event.type)}
                          onChange={(change) =>
                            changeDraft({
                              eventTypes: change.target.checked
                                ? [...draft.eventTypes, event.type]
                                : draft.eventTypes.filter(
                                    (type) => type !== event.type,
                                  ),
                              subscriptionRules: change.target.checked
                                ? [
                                    ...(draft.subscriptionRules ?? []),
                                    { eventType: event.type, stages: null },
                                  ]
                                : (draft.subscriptionRules ?? []).filter(
                                    (r) => r.eventType !== event.type,
                                  ),
                            })
                          }
                        />
                        {event.label}
                      </label>
                      {rule && event.supportsStages && (
                        <div className="notification-stage-rules">
                          <label className="notification-check">
                            <input
                              type="checkbox"
                              aria-label={`${event.label}：指定职责`}
                              checked={rule.stages !== null}
                              onChange={(e) =>
                                changeDraft({
                                  subscriptionRules:
                                    draft.subscriptionRules!.map((r) =>
                                      r.eventType === event.type
                                        ? {
                                            ...r,
                                            stages: e.target.checked
                                              ? []
                                              : null,
                                          }
                                        : r,
                                    ),
                                })
                              }
                            />
                            指定职责
                          </label>
                          {rule.stages !== null &&
                            (event.allowedStages ?? [])
                              .map(
                                (stage) =>
                                  [
                                    stage,
                                    {
                                      translate: "翻译",
                                      proofread: "校对",
                                      typeset: "嵌字",
                                      publish: "发布",
                                    }[stage],
                                  ] as const,
                              )
                              .map(([stage, label]) => (
                                <label
                                  key={stage}
                                  className="notification-check"
                                >
                                  <input
                                    type="checkbox"
                                    aria-label={`${event.label}：${label}`}
                                    checked={rule.stages!.includes(stage)}
                                    onChange={(e) =>
                                      changeDraft({
                                        subscriptionRules:
                                          draft.subscriptionRules!.map((r) =>
                                            r.eventType === event.type
                                              ? {
                                                  ...r,
                                                  stages: e.target.checked
                                                    ? [...r.stages!, stage]
                                                    : r.stages!.filter(
                                                        (s) => s !== stage,
                                                      ),
                                                }
                                              : r,
                                          ),
                                      })
                                    }
                                  />
                                  {label}
                                </label>
                              ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </fieldset>
              {audienceChanged && (
                <p className="account-notice" role="status">
                  修改受众或订阅会取消此群旧代全部未发送记录，包括仍符合新条件的消息。
                </p>
              )}
              {draft.receiverMode === "templates" ? (
                <p className="notification-boundary">使用公共事件模板</p>
              ) : (
                <div className="notification-content">
                  <h4>旧版消息内容</h4>
                  <p className="notification-boundary">
                    固定格式包含事件和作品编号；附加信息仅使用事件已留存的内容。
                  </p>
                  <label className="notification-check">
                    <input
                      type="checkbox"
                      checked={draft.includeDetails}
                      onChange={(event) =>
                        changeDraft({ includeDetails: event.target.checked })
                      }
                    />
                    包含作者、标题和操作昵称
                  </label>
                  <div className="notification-preview-controls">
                    <SelectField
                      label="预览事件"
                      value={previewType}
                      onValueChange={(value) => {
                        previewEpoch.current++;
                        setPreview("");
                        setPreviewType(value as EventType);
                      }}
                    >
                      {eventTypes.map((event) => (
                        <option key={event.type} value={event.type}>
                          {event.label}
                        </option>
                      ))}
                    </SelectField>
                    <Button
                      type="button"
                      variant="secondary"
                      loading={previewBusy}
                      disabled={!previewType}
                      onClick={() => void showPreview()}
                    >
                      预览内容
                    </Button>
                  </div>
                  {preview && (
                    <pre className="notification-preview">{preview}</pre>
                  )}
                </div>
              )}
              {(draft.receiverMode === "legacy" || adoptionRequired) && (
                <div className="notification-content">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={adoptionBusy}
                    onClick={() => void adoption()}
                  >
                    预览并切换事件模板
                  </Button>
                  {adopting &&
                    adoptionPreview &&
                    adoptionPreviewIdentity === adoptionIdentity && (
                      <>
                        <pre className="notification-preview">
                          {adoptionPreview}
                        </pre>
                        <p className="notification-boundary">
                          仅改变后续消息内容，已有待发保留原文。
                        </p>
                        <Button
                          type="button"
                          onClick={() => {
                            setDraft((current) =>
                              current
                                ? { ...current, receiverMode: "templates" }
                                : null,
                            );
                            setConfirmedAdoptionIdentity(
                              adoptionPreviewIdentity,
                            );
                            setAdopting(false);
                          }}
                        >
                          确认使用事件模板
                        </Button>
                      </>
                    )}
                </div>
              )}
              <div className="notification-actions">
                <Button type="submit" loading={saving}>
                  保存
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    previewEpoch.current++;
                    setDraft(null);
                  }}
                >
                  取消
                </Button>
              </div>
              {draft.id && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void compareCurrent()}
                >
                  比较当前版本
                </Button>
              )}
              {comparison && (
                <section
                  className="notification-content"
                  aria-label="当前群配置"
                >
                  <strong>当前服务器版本 {comparison.revision}</strong>
                  <p>
                    {comparison.name}（QQ 群 {comparison.groupId}）
                  </p>
                  <p>
                    {comparison.connectionName} ·{" "}
                    {comparison.enabled ? "已启用" : "已停用"}
                  </p>
                  <p>
                    {(
                      comparison.subscriptionRules ??
                      comparison.eventTypes.map((eventType) => ({
                        eventType,
                        stages: null,
                      }))
                    )
                      .map((rule) => {
                        const label =
                          eventTypes.find((e) => e.type === rule.eventType)
                            ?.label ?? rule.eventType;
                        return `${label}（${rule.stages === null ? "不限制职责" : rule.stages.map((stage) => ({ translate: "翻译", proofread: "校对", typeset: "嵌字", publish: "发布" })[stage]).join("、")}）`;
                      })
                      .join(" · ") || "未订阅事件"}
                  </p>
                  <p>
                    {comparison.receiverMode === "templates"
                      ? "使用公共事件模板"
                      : comparison.includeDetails
                        ? "旧版：包含作者、标题和操作昵称"
                        : "旧版：仅固定事实"}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      previewEpoch.current++;
                      setPreview("");
                      setAdopting(false);
                      setAdoptionPreview("");
                      setAdoptionPreviewIdentity("");
                      setAdoptionRevisions(null);
                      setConfirmedAdoptionIdentity("");
                      setAdoptionRequired(
                        (comparison.receiverMode ?? "legacy") === "legacy",
                      );
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              expectedRevision: comparison.revision,
                              ...(comparison.receiverMode === "templates"
                                ? { receiverMode: "templates" as const }
                                : {}),
                            }
                          : null,
                      );
                      setComparison(null);
                      setError("");
                      setSuccess(
                        "已采用当前版本号，草稿字段保留。请核对后保存。",
                      );
                    }}
                  >
                    保留草稿并以当前版本重试
                  </Button>
                </section>
              )}
            </fieldset>
          </form>
        )}
        <BirthdayReminderSettings enabled={enabled && tab === "groups"} />
        <WorkReminderSubscriptions enabled={enabled && tab === "groups"} />
      </div>
      <div
        role="tabpanel"
        id="notification-panel-templates"
        aria-labelledby="notification-tab-templates"
        hidden={tab !== "templates"}
      >
        <TemplateEditor
          enabled={enabled && tab === "templates"}
          templates={templates}
          events={eventTypes}
          onUpdated={() =>
            void queryClient.invalidateQueries({
              queryKey: ["notification-configuration"],
            })
          }
        />
        <BirthdayTemplate enabled={enabled && tab === "templates"} />
        <WorkReminderTemplate
          enabled={enabled && tab === "templates"}
          onEdit={() => {
            setTab("groups");
            requestAnimationFrame(() => {
              const editor = document.getElementById("work-reminder-settings");
              editor?.focus();
              editor?.scrollIntoView({ block: "start", behavior: "smooth" });
            });
          }}
        />
      </div>
      <div
        role="tabpanel"
        id="notification-panel-history"
        aria-labelledby="notification-tab-history"
        hidden={tab !== "history"}
      >
        <div className="notification-history-toolbar">
          <header className="notification-heading">
            <h3>投递记录</h3>
            <Button
              variant="ghost"
              size="sm"
              loading={deliveries.isFetching}
              disabled={!enabled}
              onClick={() =>
                setHistory((current) => ({
                  ...current,
                  cursors: [""],
                  generation: current.generation + 1,
                }))
              }
            >
              刷新记录
            </Button>
          </header>
          <form
            className="notification-history-filters"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters();
            }}
          >
            <SelectField
              label="投递状态"
              value={filterForm.status}
              onValueChange={(value) =>
                setFilterForm((current) => ({
                  ...current,
                  status: value as Delivery["status"] | "",
                }))
              }
            >
              <option value="">全部状态</option>
              {Object.entries(statusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </SelectField>
            <TextField
              label="原目标群号"
              value={filterForm.groupId}
              onChange={(event) =>
                setFilterForm((current) => ({
                  ...current,
                  groupId: event.target.value,
                }))
              }
              inputMode="numeric"
            />
            <TextField
              label="作品编号"
              value={filterForm.workNumber}
              onChange={(event) =>
                setFilterForm((current) => ({
                  ...current,
                  workNumber: event.target.value,
                }))
              }
              inputMode="numeric"
            />
            <SelectField
              label="事件类型"
              value={filterForm.eventType}
              onValueChange={(value) =>
                setFilterForm((current) => ({
                  ...current,
                  eventType: value as typeof current.eventType,
                }))
              }
            >
              <option value="">全部事件</option>
              {eventTypes.map((event) => (
                <option key={event.type} value={event.type}>
                  {event.label}
                </option>
              ))}
              <option value="notification.test">通知测试</option>
              <option value="birthday.reminder">角色生日</option>
              <option value="work.digest">工作摘要</option>
              <option value="work.ready">任务交接提醒</option>
            </SelectField>
            <TextField
              label="开始日期"
              type="date"
              value={filterForm.createdFrom}
              onChange={(event) =>
                setFilterForm((current) => ({
                  ...current,
                  createdFrom: event.target.value,
                }))
              }
            />
            <TextField
              label="结束日期"
              type="date"
              value={filterForm.createdThrough}
              onChange={(event) =>
                setFilterForm((current) => ({
                  ...current,
                  createdThrough: event.target.value,
                }))
              }
            />
            <div className="notification-actions">
              <Button type="submit" disabled={!enabled}>
                筛选
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!enabled}
                onClick={() => applyFilters(true)}
              >
                重置
              </Button>
            </div>
          </form>
          <Feedback error={filterError} />
          {configuration.isError && (
            <div className="notification-actions">
              <p role="alert">事件目录读取失败。</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!enabled}
                loading={configuration.isFetching}
                onClick={() => void configuration.refetch()}
              >
                重试事件目录
              </Button>
            </div>
          )}
        </div>
        {deliveries.isPending && <p role="status">正在读取投递记录…</p>}
        {deliveries.isError && (
          <p role="alert">投递记录读取失败，请刷新重试。</p>
        )}
        <div className="notification-deliveries">
          {deliveries.data?.items.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              delivery={delivery}
              eventLabel={
                delivery.resourceKind === "work_ready"
                  ? "任务交接提醒"
                  : delivery.resourceKind === "work_digest"
                    ? "工作摘要"
                    : delivery.resourceKind === "birthday_digest"
                      ? "角色生日"
                      : delivery.eventType === "notification.test"
                        ? "通知测试"
                        : (eventTypes.find(
                            (event) => event.type === delivery.eventType,
                          )?.label ?? delivery.eventType)
              }
              onUpdated={() =>
                void queryClient.invalidateQueries({
                  queryKey: ["notification-deliveries"],
                })
              }
            />
          ))}
        </div>
        {deliveries.data?.items.length === 0 && <p>暂无投递记录。</p>}
        <nav className="notification-pagination" aria-label="投递记录分页">
          <Button
            variant="secondary"
            disabled={
              !enabled || deliveries.isFetching || history.cursors.length === 1
            }
            onClick={() =>
              setHistory((current) => ({
                ...current,
                cursors: current.cursors.slice(0, -1),
              }))
            }
          >
            上一页
          </Button>
          <span>第 {history.cursors.length} 页 · 每页 20 条</span>
          <Button
            variant="secondary"
            disabled={
              !enabled || deliveries.isFetching || !deliveries.data?.nextCursor
            }
            onClick={() => {
              const next = deliveries.data?.nextCursor;
              if (next)
                setHistory((current) => ({
                  ...current,
                  cursors: [...current.cursors, next],
                }));
            }}
          >
            下一页
          </Button>
        </nav>
      </div>
      <div
        role="tabpanel"
        id="notification-panel-status"
        aria-labelledby="notification-tab-status"
        hidden={tab !== "status"}
      >
        <NotificationStatusPanel enabled={enabled && tab === "status"} />
      </div>
    </Surface>
  );
}

function DeliveryRow({
  delivery,
  eventLabel,
  onUpdated,
}: {
  delivery: Delivery;
  eventLabel: string;
  onUpdated: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef<Partial<Record<"acknowledge" | "retry", string>>>({});
  async function resolve(action: "acknowledge" | "retry") {
    keys.current[action] ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      const result = await client.POST(
        "/api/notifications/deliveries/{id}/resolve",
        {
          params: { path: { id: delivery.id } },
          body: {
            action,
            expectedRevision: delivery.revision,
            idempotencyKey: keys.current[action]!,
            ...(action === "retry"
              ? { confirmPossibleDuplicate: confirmed }
              : {}),
          },
        },
      );
      if (result.response.status === 409)
        throw new Error("投递记录已变化，请刷新后核对。");
      await unwrap(result);
      keys.current = {};
      setConfirmed(false);
      onUpdated();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="notification-delivery">
      <div className="notification-delivery-summary">
        <Badge tone={tone(delivery.status)}>
          {statusLabels[delivery.status] ?? delivery.status}
        </Badge>
        <strong>{eventLabel}</strong>
        {delivery.resourceKind !== "work_digest" &&
          delivery.resourceKind !== "work_ready" && (
            <span>
              {delivery.resourceKind === "birthday_digest"
                ? delivery.birthday
                  ? `${delivery.birthday.targetLocalDate} · ${delivery.birthday.count} 位角色 · ${delivery.birthday.offsetDays === 0 ? "生日当天" : `提前 ${delivery.birthday.offsetDays} 天`}`
                  : "生日摘要"
                : delivery.resourceKind === "notification_test" ||
                    delivery.workNumber === null
                  ? "合成测试"
                  : `#${delivery.workNumber}`}
            </span>
          )}
        <time dateTime={delivery.createdAt}>
          {new Date(delivery.createdAt).toLocaleString()}
        </time>
        <span>原投递目标：QQ 群 {delivery.groupId}</span>
        {delivery.resolvedAt && <span>已核对</span>}
      </div>
      {(delivery.status === "pending" || delivery.status === "retry_wait") && (
        <p className="notification-boundary">
          {delivery.nextEligibleAt ? (
            <>下次可调度 {new Date(delivery.nextEligibleAt).toLocaleString()}</>
          ) : (
            "等待调度"
          )}
        </p>
      )}
      <details>
        <summary>查看内容与技术回执</summary>
        <div className="notification-meta">
          <span>当前管理名称：{delivery.channelName}</span>
          <span>连接标识：{delivery.connectionKey}</span>
          <span>尝试 {delivery.attempts} 次</span>
          {delivery.errorCode && <span>{delivery.errorCode}</span>}
          {delivery.providerMessageId && (
            <span>平台回执 {delivery.providerMessageId}</span>
          )}
        </div>
        {"contentRevision" in delivery && delivery.contentRevision != null && (
          <p className="notification-boundary">
            内容修订 {String(delivery.contentRevision)}
          </p>
        )}
        {"metadataObservedAt" in delivery &&
          typeof delivery.metadataObservedAt === "string" && (
            <p className="notification-boundary">
              资料捕获于{" "}
              {new Date(delivery.metadataObservedAt).toLocaleString()}
            </p>
          )}
        <pre className="notification-preview">{delivery.preview}</pre>
      </details>
      {(delivery.status === "unknown" || delivery.status === "failed") &&
        !delivery.resolvedAt && (
          <div className="notification-resolution">
            {delivery.resourceKind !== "work_digest" &&
              delivery.resourceKind !== "work_ready" && (
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  我已核对，确认补发可能重复
                </label>
              )}
            <div className="notification-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void resolve("acknowledge")}
              >
                确认已核对
              </Button>
              {delivery.resourceKind !== "work_digest" &&
                delivery.resourceKind !== "work_ready" && (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={!confirmed || busy}
                    onClick={() => void resolve("retry")}
                  >
                    补发
                  </Button>
                )}
            </div>
          </div>
        )}
      <Feedback error={error} />
    </article>
  );
}
