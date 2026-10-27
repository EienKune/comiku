import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Badge, Button, Surface } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { sourceAdapterLabels } from "../workspace/source-labels";

const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "同步中",
  succeeded: "完成",
  partial_failed: "部分失败",
  failed: "失败",
  skipped: "跳过",
};
function statusTone(status: string) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "partial_failed") return "warning" as const;
  return "neutral" as const;
}

export function SourceFetchHistory() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["source-fetch-history"],
    queryFn: async () => unwrap(await client.GET("/api/source-fetch/runs")),
    refetchInterval: 15_000,
  });
  return (
    <Surface className="system-history">
      <header className="system-history-heading">
        <h2>图源采集</h2>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<RefreshCw size={15} />}
          onClick={() => void query.refetch()}
          loading={query.isFetching}
        >
          刷新
        </Button>
      </header>
      {query.isPending && <p role="status">正在读取同步记录…</p>}
      {query.isError && <p role="alert">同步记录读取失败，请重试。</p>}
      {query.data?.length === 0 && <p>暂无同步记录。</p>}
      <div className="system-runs">
        {query.data?.map((run) => {
          const opened = expanded === run.id;
          const when = new Date(run.startedAt).toLocaleString();
          return (
            <article className="system-run" key={run.id}>
              <div className="system-run-summary">
                <div className="system-run-time">
                  <time dateTime={run.startedAt}>{when}</time>
                  <span>
                    {run.trigger === "scheduled" ? "定时同步" : "手动同步"}
                  </span>
                </div>
                <Badge tone={statusTone(run.status)}>
                  {statusLabels[run.status] ?? run.status}
                </Badge>
                <div className="system-run-counts">
                  <span>
                    新增{" "}
                    {run.items.reduce(
                      (n, item) => n + item.candidatesCreated,
                      0,
                    )}
                  </span>
                  <span>
                    原图{" "}
                    {run.items.reduce((n, item) => n + item.mediaStored, 0)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={opened}
                  aria-controls={`source-run-${run.id}`}
                  aria-label={`查看批次详情 ${when}`}
                  leadingIcon={
                    <ChevronDown
                      size={15}
                      className={opened ? "is-open" : ""}
                    />
                  }
                  onClick={() => setExpanded(opened ? null : run.id)}
                >
                  详情
                </Button>
              </div>
              {opened && (
                <div className="system-run-detail" id={`source-run-${run.id}`}>
                  <div className="system-run-timing">
                    <span>尝试 {run.attempts} 次</span>
                    {run.attempts > 1 && (
                      <span>重试 {run.attempts - 1} 次</span>
                    )}
                    {run.nextRetryAt && (
                      <span>
                        下次重试：{new Date(run.nextRetryAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="system-run-table">
                    <table>
                      <thead>
                        <tr>
                          <th>作者 / 通道</th>
                          <th>状态</th>
                          <th>页数</th>
                          <th>新增</th>
                          <th>已有</th>
                          <th>原图</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.items.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <strong>{item.authorName}</strong>
                              <span className="system-run-adapter">
                                {sourceAdapterLabels[item.adapterKey] ??
                                  item.adapterKey}
                              </span>
                              {item.errorMessage && (
                                <p className="system-run-error">
                                  {item.errorMessage}
                                </p>
                              )}
                            </td>
                            <td>
                              <Badge tone={statusTone(item.status)}>
                                {statusLabels[item.status] ?? item.status}
                              </Badge>
                            </td>
                            <td>{item.pagesFetched}</td>
                            <td>{item.candidatesCreated}</td>
                            <td>{item.candidatesExisting}</td>
                            <td>{item.mediaStored}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </Surface>
  );
}
