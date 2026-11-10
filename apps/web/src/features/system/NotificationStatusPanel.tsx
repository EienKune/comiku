import { useState } from "react";
import type { components } from "@comiku/api-client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Badge, Button, SelectField } from "../../components/ui";
import { client, unwrap } from "../account/api";

type ReceiptStatus =
  components["schemas"]["NotificationReceiptItemDto"]["status"];
const statusLabels: Record<
  components["schemas"]["NotificationStatusDto"]["state"],
  string
> = {
  disabled: "通知已关闭",
  not_started: "尚未开始维护",
  healthy: "维护正常",
  stale: "维护记录已过期",
  error: "最近维护失败",
};
const receiptLabels: Record<ReceiptStatus, string> = {
  pending: "待登记",
  retry_wait: "等待重试",
  invalid: "已隔离",
  recorded: "已登记",
  skipped: "已跳过",
};
function controlledError(code: string) {
  const labels: Record<string, string> = {
    source_mapping_invalid: "来源事件无法识别",
    no_source_subscription: "没有适用的群订阅",
    persistent_input_conflict: "登记内容冲突，已隔离",
    registration_temporarily_unavailable: "登记暂时不可用",
    maintenance_failed: "补账维护暂时失败",
  };
  return labels[code] ?? "处理失败，请检查服务端运行记录";
}
function time(value: string | null) {
  return value ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    "—"
  );
}
export function NotificationStatusPanel({ enabled }: { enabled: boolean }) {
  const [filter, setFilter] = useState<ReceiptStatus>("retry_wait");
  const status = useQuery({
    queryKey: ["notification-status"],
    queryFn: async () => unwrap(await client.GET("/api/notifications/status")),
    enabled,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      enabled && query.state.data?.enabled ? 15000 : false,
  });
  const receipts = useInfiniteQuery({
    queryKey: ["notification-receipts", filter],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await client.GET("/api/notifications/receipts", {
          params: { query: { status: filter, limit: 20, cursor: pageParam } },
        }),
      ),
    enabled,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchOnWindowFocus: false,
  });
  const data = status.data;
  return (
    <div className="notification-status">
      <header className="notification-heading">
        <h3>运行状态</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={!enabled}
          loading={status.isFetching || receipts.isFetching}
          onClick={() => {
            if (!enabled) return;
            void status.refetch();
            void receipts.refetch();
          }}
        >
          刷新运行状态
        </Button>
      </header>
      {status.isPending && enabled && <p role="status">正在读取运行状态…</p>}
      {status.isError && <p role="alert">运行状态读取失败，请刷新重试。</p>}
      {data && (
        <>
          <div className="notification-actions">
            <Badge
              tone={
                data.state === "healthy"
                  ? "success"
                  : data.state === "error"
                    ? "danger"
                    : data.state === "stale"
                      ? "warning"
                      : "neutral"
              }
            >
              {statusLabels[data.state]}
            </Badge>
          </div>
          <h3>外发队列</h3>
          <div className="notification-status-metrics">
            {(
              [
                ["pending", "排队中"],
                ["retryWait", "等待重试"],
                ["sending", "发送中"],
                ["failedUnresolved", "未核对失败"],
                ["unknownUnresolved", "未核对未知"],
              ] as const
            ).map(([key, label]) => {
              const metric = data.deliveries?.[key];
              return (
                <div className="notification-status-metric" key={key}>
                  <span>{label}</span>
                  <strong>
                    {metric
                      ? `${metric.count}${metric.capped ? "+" : ""}`
                      : "—"}
                  </strong>
                  <span className="notification-boundary">
                    最老记录 {time(metric?.oldestAt ?? null)}
                  </span>
                </div>
              );
            })}
          </div>
          <h3>事件补账</h3>
          <dl className="notification-status-evidence">
            <div>
              <dt>最后完成维护</dt>
              <dd>{time(data.lastMaintenanceAt)}</dd>
            </div>
            <div>
              <dt>最近捕获</dt>
              <dd>{time(data.lastCaptureAt)}</dd>
            </div>
            <div>
              <dt>最近登记</dt>
              <dd>{time(data.lastRegistrationAt)}</dd>
            </div>
            <div>
              <dt>原事件起点</dt>
              <dd>{time(data.sourceSince)}</dd>
            </div>
            <div>
              <dt>扩展事件起点</dt>
              <dd>{time(data.expandedSourceSince)}</dd>
            </div>
          </dl>
          {data.lastErrorCode && (
            <p className="account-error">
              {controlledError(data.lastErrorCode)} · {time(data.lastErrorAt)}
            </p>
          )}
          <div className="notification-status-metrics">
            {(
              [
                ["uncaptured", "未捕获"],
                ["pending", "待登记"],
                ["retryWait", "等待重试"],
                ["invalid", "已隔离"],
              ] as const
            ).map(([key, label]) => {
              const metric = data.counts[key];
              return (
                <div className="notification-status-metric" key={key}>
                  <span>{label}</span>
                  <strong>
                    {metric
                      ? `${metric.count}${metric.capped ? "+" : ""}`
                      : "—"}
                  </strong>
                  <span className="notification-boundary">
                    最老记录 {time(metric?.oldestAt ?? null)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <header className="notification-heading">
        <h3>事件登记记录</h3>
        <SelectField
          label="登记状态"
          value={filter}
          onValueChange={(value) => setFilter(value as ReceiptStatus)}
        >
          {Object.entries(receiptLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
      </header>
      {receipts.isPending && enabled && <p role="status">正在读取登记记录…</p>}
      {receipts.isError && <p role="alert">登记记录读取失败，请刷新重试。</p>}
      <div className="notification-deliveries">
        {receipts.data?.pages
          .flatMap((page) => page.items)
          .map((receipt) => (
            <article key={receipt.id} className="notification-delivery">
              <div className="notification-heading">
                <strong>
                  <a href={`/works/${encodeURIComponent(receipt.resourceId)}`}>
                    {receipt.workNumber === null
                      ? "查看作品"
                      : `#${receipt.workNumber}`}
                  </a>{" "}
                  · <span>{receipt.eventLabel ?? "未知事件"}</span>
                </strong>
                <Badge
                  tone={
                    receipt.status === "invalid"
                      ? "danger"
                      : receipt.status === "retry_wait"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {receiptLabels[receipt.status] ?? "未知登记状态"}
                </Badge>
              </div>
              <div className="notification-meta">
                <span>尝试 {receipt.attempts} 次</span>
                <span>创建 {time(receipt.createdAt)}</span>
                <span>更新 {time(receipt.updatedAt)}</span>
                {(receipt.status === "pending" ||
                  receipt.status === "retry_wait") && (
                  <span>下次尝试 {time(receipt.nextAttemptAt)}</span>
                )}
                {receipt.errorCode && (
                  <span>{controlledError(receipt.errorCode)}</span>
                )}
              </div>
            </article>
          ))}
      </div>
      {receipts.data?.pages[0]?.items.length === 0 && (
        <p>暂无{receiptLabels[filter]}的登记记录。</p>
      )}
      {receipts.hasNextPage && (
        <Button
          variant="secondary"
          disabled={!enabled}
          loading={receipts.isFetchingNextPage}
          onClick={() => {
            if (enabled) void receipts.fetchNextPage();
          }}
        >
          加载更多登记记录
        </Button>
      )}
    </div>
  );
}
