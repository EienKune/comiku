import { NotificationGroupActions } from "./NotificationGroupActions";
import { WorkReminderSubscriptions } from "./WorkReminderPanels";
import { NotificationBirthdayRules } from "./NotificationBirthdayRules";
import { adoptConfirmedChannelMetadata } from "./notification-channel-cache";
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
import { NotificationGroupRoster } from "./NotificationGroupRoster";
import {
  NotificationGroupDialog,
  type GroupSection,
} from "./NotificationGroupDialog";
import { NotificationEventSettings } from "./NotificationEventSettings";
import { NotificationGroupPreview } from "./NotificationGroupPreview";
import { NotificationGroupBirthday } from "./NotificationGroupBirthday";
import { localDayBoundary } from "./notification-history";
import { NotificationStatusPanel } from "./NotificationStatusPanel";
import {
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
function channelDraft(channel?: Channel, connectionKey = "") {
  return channel
    ? {
        id: channel.id,
        expectedRevision: channel.revision,
        name: channel.name,
        groupId: channel.groupId,
        connectionKey: channel.connectionKey,
        enabled: channel.enabled,
        eventTypes: [...channel.eventTypes] as EventType[],
        includeDetails: channel.includeDetails,
        receiverMode: channel.receiverMode ?? ("legacy" as const),
        subscriptionRules:
          channel.subscriptionRules ??
          channel.eventTypes.map((eventType) => ({
            eventType: eventType as EventType,
            stages: null,
          })),
      }
    : {
        name: "",
        groupId: "",
        connectionKey,
        enabled: false,
        eventTypes: [] as EventType[],
        includeDetails: false,
        receiverMode: "templates" as const,
        subscriptionRules: [] as SubscriptionRule[],
      };
}
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
  const [workPreview, setWorkPreview] = useState<
    components["schemas"]["WorkReminderSubscriptionDto"] | undefined
  >();
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupSection, setGroupSection] = useState<GroupSection>("events");
  const [globalSection, setGlobalSection] = useState("work");
  const [search, setSearch] = useState("");
  const savedDrafts = useRef(new Map<string, NonNullable<typeof draft>>());
  function closeGroup() {
    if (draft) savedDrafts.current.set(draft.id ?? "new", draft);
    setGroupOpen(false);
  }
  function openGlobal(section: string) {
    closeGroup();
    setTab("global");
    setGlobalSection(section);
  }

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
  const [groupConflict, setGroupConflict] = useState(false);
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
    if (draft) savedDrafts.current.set(draft.id ?? "new", draft);
    setGroupOpen(true);
    setGroupSection(channel ? "events" : "basic");
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
    setGroupConflict(false);
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
    const retained = savedDrafts.current.get(channel?.id ?? "new");
    if (retained) setDraft(retained);
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
        setGroupConflict(true);
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
      const saved = await unwrap(result);
      await adoptConfirmedChannelMetadata(queryClient, saved);
      const nextDraft = channelDraft(saved as Channel);
      setDraft(nextDraft);
      setAdoptionRequired(false);
      setGroupConflict(false);
      savedDrafts.current.delete(id ?? "new");
      setComparison(null);
      setSuccess("配置已保存");
      void queryClient.invalidateQueries({ queryKey: ["work-reminders"] });
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
        <h2>通知推送</h2>
        {(tab === "groups" || tab === "global") && (
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
          ["groups", "接收群"],
          ["global", "全局规则"],
          ["history", "发送记录"],
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
            <header className="notification-heading notification-section-heading">
              <h3>
                接收群{" "}
                <span className="notification-boundary">
                  {data.channels.length}
                </span>
              </h3>
              <TextField
                label="搜索接收群"
                placeholder="群名称或群号"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button size="sm" disabled={saving} onClick={() => edit()}>
                新增群目标
              </Button>
            </header>
            <NotificationGroupRoster
              data={data}
              enabled={enabled && tab === "groups"}
              search={search}
              saving={saving}
              templates={templates}
              events={eventTypes}
              onEdit={edit}
              onUpdated={() =>
                void queryClient.invalidateQueries({
                  queryKey: ["notification-deliveries"],
                })
              }
            />
            {data.channels.length === 0 && <p>暂无群目标。</p>}
          </>
        )}
        {!groupOpen && <Feedback error={error} success={success} />}
        {draft && data && (
          <NotificationGroupDialog
            open={enabled && tab === "groups" && groupOpen}
            title={draft.id ? `编辑接收群 · ${draft.name}` : "新增群目标"}
            section={groupSection}
            onSection={setGroupSection}
            onClose={closeGroup}
            preview={
              <NotificationGroupPreview
                enabled={enabled && tab === "groups" && groupOpen}
                section={groupSection}
                eventType={previewType}
                onEvent={setPreviewType}
                events={eventTypes}
                templates={templates}
                includeDetails={draft.includeDetails}
                receiverMode={adoptionRequired ? "legacy" : draft.receiverMode}
                rules={draft.subscriptionRules ?? []}
                workOptions={workPreview}
              />
            }
          >
            <div hidden={groupSection !== "basic" && groupSection !== "events"}>
              <form
                id="notification-group-general"
                className="notification-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                {groupSection === "basic" && <h3>基本信息</h3>}
                <fieldset disabled={saving}>
                  <div hidden={groupSection !== "basic"}>
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
                          (connection) =>
                            connection.key === draft.connectionKey,
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
                  </div>
                  <div hidden={groupSection !== "events"}>
                    <NotificationEventSettings
                      events={eventTypes}
                      rules={draft.subscriptionRules ?? []}
                      onChange={(rules) =>
                        changeDraft({
                          eventTypes: rules.map((rule) => rule.eventType),
                          subscriptionRules: rules,
                        })
                      }
                      onPreview={(event) => setPreviewType(event.type)}
                    />

                    {audienceChanged && (
                      <p className="account-notice" role="status">
                        修改受众或订阅会取消此群旧代全部未发送记录，包括仍符合新条件的消息。
                      </p>
                    )}
                    {draft.receiverMode === "templates" ? null : (
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
                              changeDraft({
                                includeDetails: event.target.checked,
                              })
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
                                      ? {
                                          ...current,
                                          receiverMode: "templates",
                                        }
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
                  </div>
                  <Feedback error={error} success={success} />
                  <NotificationGroupActions
                    active={
                      enabled &&
                      tab === "groups" &&
                      groupOpen &&
                      (groupSection === "basic" || groupSection === "events")
                    }
                    disabled={saving}
                  >
                    <Button
                      type="submit"
                      form="notification-group-general"
                      loading={saving}
                    >
                      保存群设置
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        previewEpoch.current++;
                        closeGroup();
                      }}
                    >
                      关闭
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        savedDrafts.current.delete(draft.id ?? "new");
                        setDraft(
                          channelDraft(original, data.connections[0]?.key),
                        );
                        setGroupOpen(false);
                        setComparison(null);
                        setGroupConflict(false);
                        previewEpoch.current++;
                        setAdopting(false);
                        setAdoptionPreview("");
                        setAdoptionRevisions(null);
                        setConfirmedAdoptionIdentity("");
                        setAdoptionRequired(
                          !!original &&
                            (original.receiverMode ?? "legacy") === "legacy",
                        );
                        setError("");
                      }}
                    >
                      放弃草稿
                    </Button>
                  </NotificationGroupActions>
                  {draft.id && groupConflict && (
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
                          setGroupConflict(false);
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
            </div>
            <div hidden={groupSection !== "work"}>
              {!draft.id && <p>保存群设置后可设置工作提醒。</p>}
              <WorkReminderSubscriptions
                enabled={
                  enabled &&
                  tab === "groups" &&
                  groupOpen &&
                  groupSection === "work"
                }
                mode="channel"
                selectedId={draft.id}
                onPreviewChange={setWorkPreview}
                onGlobal={() => openGlobal("work")}
              />
            </div>
            <div hidden={groupSection !== "birthday"}>
              {!draft.id && <p>保存群设置后可设置生日提醒。</p>}
              <NotificationGroupBirthday
                enabled={
                  enabled &&
                  tab === "groups" &&
                  groupOpen &&
                  groupSection === "birthday"
                }
                selectedId={draft.id}
                onGlobal={() => openGlobal("birthday")}
              />
            </div>
          </NotificationGroupDialog>
        )}
      </div>
      <div
        role="tabpanel"
        id="notification-panel-global"
        aria-labelledby="notification-tab-global"
        hidden={tab !== "global"}
      >
        <div className="notification-global-layout">
          <nav className="notification-settings-nav" aria-label="全局规则类别">
            <button
              type="button"
              aria-current={globalSection === "work" ? "page" : undefined}
              onClick={() => setGlobalSection("work")}
            >
              工作提醒
            </button>
            <button
              type="button"
              aria-current={globalSection === "birthday" ? "page" : undefined}
              onClick={() => setGlobalSection("birthday")}
            >
              生日提醒
            </button>
          </nav>
          <div>
            <div hidden={globalSection !== "work"}>
              <WorkReminderSubscriptions
                enabled={
                  enabled && tab === "global" && globalSection === "work"
                }
                mode="global"
              />
            </div>
            <div hidden={globalSection !== "birthday"}>
              <NotificationBirthdayRules
                enabled={
                  enabled && tab === "global" && globalSection === "birthday"
                }
              />
            </div>
          </div>
        </div>
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
          {delivery.errorCode && (
            <span>
              {delivery.errorCode === "notification_provider_not_ready"
                ? "机器人尚未就绪，等待自动重试"
                : delivery.errorCode}
            </span>
          )}
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
