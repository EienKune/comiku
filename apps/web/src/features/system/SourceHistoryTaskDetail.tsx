import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { sourceAdapterHealthLabels } from "../workspace/source-labels";
import {
  failureLabel,
  formatTime,
  statusLabels,
  statusTone,
  taskStatusLabel,
} from "./source-history";
import {
  SourceHistoryExecutions,
  SourceHistoryGaps,
} from "./SourceHistoryDiagnostics";

export function SourceHistoryTaskDetail({
  runId,
  taskId,
  enabled,
}: {
  runId: string;
  taskId: string;
  enabled: boolean;
}) {
  const [showExecutions, setShowExecutions] = useState(false);
  const [showGaps, setShowGaps] = useState(false);
  const query = useQuery({
    queryKey: ["source-history", "task", runId, taskId],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/source-fetch/runs/{id}/tasks/{taskId}", {
          params: { path: { id: runId, taskId } },
          signal,
        }),
      ),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const detail = query.data;
  return (
    <>
      <div className="source-history-heading">
        <h4>单账号详情</h4>
        <Button
          variant="ghost"
          size="sm"
          disabled={!enabled}
          loading={query.isFetching}
          onClick={() => {
            if (enabled) void query.refetch();
          }}
        >
          刷新详情
        </Button>
      </div>
      {query.isPending && enabled && <p role="status">正在读取账号详情…</p>}
      {query.isError && <p role="alert">账号详情读取失败，请刷新详情重试。</p>}
      {detail && (
        <>
          <section className="source-history-fact">
            <h5>原批账号结果</h5>
            <div className="source-history-fact-line">
              <Badge
                tone={
                  detail.original.failureCode === "discovery_gaps"
                    ? "warning"
                    : statusTone(detail.original.status)
                }
              >
                {taskStatusLabel(detail.original)}
              </Badge>
              {failureLabel(detail.original.failureCode) !==
                taskStatusLabel(detail.original) && (
                <span>{failureLabel(detail.original.failureCode)}</span>
              )}
              <span>{formatTime(detail.original.completedAt)}</span>
            </div>
          </section>
          {detail.job && (
            <section className="source-history-fact">
              <h5>当前执行安排</h5>
              <div className="source-history-fact-line">
                <span>当前作业：{statusLabels[detail.job.status]}</span>
                <span>本任务已使用 {detail.job.attempts} 次执行预算</span>
                {detail.job.nextRetryAt ? (
                  <span>下次最早重试 {formatTime(detail.job.nextRetryAt)}</span>
                ) : detail.job.nextAvailableAt ? (
                  <span>
                    最早可执行 {formatTime(detail.job.nextAvailableAt)}
                  </span>
                ) : null}
                {failureLabel(detail.original.failureCode)?.startsWith(
                  "等待",
                ) && <span>{failureLabel(detail.original.failureCode)}</span>}
              </div>
            </section>
          )}
          {detail.followupSuccess && (
            <section className="source-history-fact">
              <h5>后续同步成功</h5>
              <p>{formatTime(detail.followupSuccess.completedAt)}</p>
            </section>
          )}
          <section className="source-history-fact">
            <h5>当前账号</h5>
            {detail.current ? (
              <>
                <div className="source-history-fact-line">
                  <span>
                    {detail.current.deletedAt
                      ? "账号已归档"
                      : detail.current.fetchEnabled
                        ? "采集已开启"
                        : "采集已关闭"}
                  </span>
                  {detail.current.adapterHealth && (
                    <span>
                      当前状态：
                      {sourceAdapterHealthLabels[detail.current.adapterHealth]}
                    </span>
                  )}
                </div>
                <p>
                  当前仍有 {detail.current.unresolvedGapCount}{" "}
                  条缺口，已确认排除 {detail.current.excludedGapCount} 条。
                </p>
                <p className="source-history-muted">
                  缺口属于账号当前全部已知帖子，不限定于本批。
                </p>
              </>
            ) : (
              <p>账号当前资料不可用，保留原批结果。</p>
            )}
          </section>
          <div className="source-history-diagnostic-actions">
            {detail.executionHistoryAvailable && (
              <Button
                variant="secondary"
                size="sm"
                disabled={!enabled}
                aria-expanded={showExecutions}
                onClick={() => setShowExecutions(!showExecutions)}
              >
                {showExecutions ? "收起本次扫描记录" : "查看本次扫描记录"}
              </Button>
            )}
            {detail.current && (
              <Button
                variant="secondary"
                size="sm"
                disabled={!enabled}
                aria-expanded={showGaps}
                onClick={() => setShowGaps(!showGaps)}
              >
                {showGaps ? "收起当前缺口" : "查看当前缺口"}
              </Button>
            )}
          </div>
          {showExecutions && detail.executionHistoryAvailable && (
            <SourceHistoryExecutions
              runId={runId}
              taskId={taskId}
              enabled={enabled}
            />
          )}
          {showGaps && (
            <SourceHistoryGaps
              runId={runId}
              taskId={taskId}
              enabled={enabled}
            />
          )}
          {!detail.executionHistoryAvailable && (
            <p className="source-history-muted">该时段仅保留结果摘要</p>
          )}
          <p className="source-history-observed">
            读取于 {formatTime(detail.observedAt)}
          </p>
        </>
      )}
    </>
  );
}
