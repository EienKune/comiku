import { useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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

type Channel = components["schemas"]["NotificationChannelDto"];
type Delivery = components["schemas"]["NotificationDeliveryDto"];
type ChannelInput = components["schemas"]["NotificationChannelInputDto"];
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
  const configuration = useQuery({
    queryKey: ["notification-configuration"],
    enabled,
    queryFn: async () =>
      unwrap(await client.GET("/api/notifications/configuration")),
    refetchOnWindowFocus: false,
  });
  // The server-owned event catalogue and channel inputs share the same keys.
  const eventTypes = (configuration.data?.eventTypes ?? []) as {
    type: EventType;
    label: string;
  }[];
  const [status, setStatus] = useState<Delivery["status"] | "">("");
  const deliveries = useInfiniteQuery({
    queryKey: ["notification-deliveries", status],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await client.GET("/api/notifications/deliveries", {
          params: {
            query: {
              cursor: pageParam,
              status: status || undefined,
              limit: 50,
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<
    (ChannelInput & { id?: string; expectedRevision?: number }) | null
  >(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewType, setPreviewType] = useState<EventType | "">("");
  const [preview, setPreview] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewEpoch = useRef(0);
  function changeDraft(patch: Partial<ChannelInput>) {
    previewEpoch.current++;
    setPreview("");
    setDraft((current) => (current ? { ...current, ...patch } : null));
  }
  function edit(channel?: Channel) {
    if (saving) return;
    previewEpoch.current++;
    setPreview("");
    setError("");
    setSuccess("");
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
          }
        : {
            name: "",
            groupId: "",
            connectionKey: configuration.data?.connections[0]?.key ?? "",
            enabled: false,
            eventTypes: [],
            includeDetails: false,
          },
    );
  }
  async function save() {
    if (!draft) return;
    setSaving(true);
    setError("");
    setSuccess("");
    const { id, expectedRevision, ...input } = draft;
    try {
      const result = id
        ? await client.PATCH("/api/notifications/channels/{id}", {
            params: { path: { id } },
            body: { ...input, expectedRevision: expectedRevision! },
          })
        : await client.POST("/api/notifications/channels", { body: input });
      if (result.response.status === 409)
        throw new Error(
          "配置已被其他管理员修改。草稿已保留，请重新读取配置后核对。",
        );
      await unwrap(result);
      setDraft(null);
      setSuccess("配置已保存");
      void queryClient.invalidateQueries({
        queryKey: ["notification-configuration"],
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
  return (
    <Surface className="notification-management">
      <header className="notification-heading">
        <h2>推送通知</h2>
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
      </header>
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
          <section
            className="notification-connections"
            aria-labelledby="notification-connections-heading"
          >
            <h3 id="notification-connections-heading">连接配置</h3>
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
          </section>
          <header className="notification-heading">
            <h3>群订阅</h3>
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
                      (connection) => connection.key === channel.connectionKey,
                    )?.name ?? "连接已缺失"}
                    {data.connections.some(
                      (connection) =>
                        connection.key === channel.connectionKey &&
                        !connection.available,
                    ) && "（不可用）"}
                  </span>
                </div>
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
                  <TestChannel
                    channel={channel}
                    disabled={
                      !data.enabled ||
                      !channel.enabled ||
                      !data.connections.some(
                        (connection) =>
                          connection.key === channel.connectionKey &&
                          connection.available,
                      )
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
                onChange={(event) => changeDraft({ name: event.target.value })}
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
                onValueChange={(value) => changeDraft({ connectionKey: value })}
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
              {eventTypes.map((event) => (
                <label className="notification-check" key={event.type}>
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
                      })
                    }
                  />
                  {event.label}
                </label>
              ))}
            </fieldset>
            <div className="notification-content">
              <h4>消息内容</h4>
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
              {preview && <pre className="notification-preview">{preview}</pre>}
            </div>
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
          </fieldset>
        </form>
      )}
      <header className="notification-heading">
        <h3>投递记录</h3>
        <div className="notification-actions">
          <SelectField
            label="投递状态"
            value={status}
            onValueChange={(value) =>
              setStatus(value as Delivery["status"] | "")
            }
          >
            <option value="">全部状态</option>
            {Object.entries(statusLabels).map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </SelectField>
          <Button
            variant="ghost"
            size="sm"
            loading={deliveries.isFetching}
            onClick={() => void deliveries.refetch()}
          >
            刷新记录
          </Button>
        </div>
      </header>
      {deliveries.isPending && <p role="status">正在读取投递记录…</p>}
      {deliveries.isError && <p role="alert">投递记录读取失败，请刷新重试。</p>}
      <div className="notification-deliveries">
        {deliveries.data?.pages
          .flatMap((page) => page.items)
          .map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              delivery={delivery}
              eventLabel={
                eventTypes.find((event) => event.type === delivery.eventType)
                  ?.label ?? delivery.eventType
              }
              onUpdated={() =>
                void queryClient.invalidateQueries({
                  queryKey: ["notification-deliveries"],
                })
              }
            />
          ))}
      </div>
      {deliveries.data?.pages[0]?.items.length === 0 && <p>暂无投递记录。</p>}
      {deliveries.hasNextPage && (
        <Button
          variant="secondary"
          loading={deliveries.isFetchingNextPage}
          onClick={() => void deliveries.fetchNextPage()}
        >
          加载更多
        </Button>
      )}
    </Surface>
  );
}

function TestChannel({
  channel,
  disabled,
  onUpdated,
}: {
  channel: Channel;
  disabled: boolean;
  onUpdated: () => void;
}) {
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function send() {
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await unwrap(
        await client.POST("/api/notifications/channels/{id}/test", {
          params: { path: { id: channel.id } },
          body: { idempotencyKey: key.current },
        }),
      );
      key.current = null;
      setSuccess("测试已排队，请刷新投递记录查看结果。");
      onUpdated();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        loading={busy}
        onClick={() => void send()}
      >
        发送测试
      </Button>
      <Feedback error={error} success={success} />
    </div>
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
      <div className="notification-heading">
        <strong>
          {delivery.channelName}
          {delivery.workNumber !== null
            ? ` · #${delivery.workNumber}`
            : " · 合成测试"}
        </strong>
        <Badge tone={tone(delivery.status)}>
          {statusLabels[delivery.status] ?? delivery.status}
        </Badge>
      </div>
      <div className="notification-meta">
        <span>{eventLabel}</span>
        <time dateTime={delivery.createdAt}>
          {new Date(delivery.createdAt).toLocaleString()}
        </time>
        <span>尝试 {delivery.attempts} 次</span>
        {delivery.errorCode && <span>{delivery.errorCode}</span>}
        {delivery.providerMessageId && (
          <span>平台回执 {delivery.providerMessageId}</span>
        )}
        {delivery.resolvedAt && <span>已核对</span>}
      </div>
      <details>
        <summary>查看内容</summary>
        <pre className="notification-preview">{delivery.preview}</pre>
      </details>
      {(delivery.status === "unknown" || delivery.status === "failed") &&
        !delivery.resolvedAt && (
          <div className="notification-resolution">
            <label className="notification-check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已核对，确认补发可能重复
            </label>
            <div className="notification-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void resolve("acknowledge")}
              >
                确认已核对
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={!confirmed || busy}
                onClick={() => void resolve("retry")}
              >
                补发
              </Button>
            </div>
          </div>
        )}
      <Feedback error={error} />
    </article>
  );
}
