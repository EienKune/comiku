import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Badge, Button, SelectField, Surface } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { SourceHistoryTasks } from "./SourceHistoryTasks";
import {
  formatTime,
  isActiveRun,
  statusLabels,
  statusTone,
  useHistoryPage,
  useHistoryVisible,
  type SourceRun,
} from "./source-history";
import "./source-history.css";

function SourceRunRow({
  initial,
  opened,
  enabled,
  onToggle,
}: {
  initial: SourceRun;
  opened: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  const summary = useQuery({
    queryKey: ["source-history", "summary", initial.id],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/source-fetch/runs/{id}", {
          params: { path: { id: initial.id } },
          signal,
        }),
      ),
    initialData: initial,
    enabled: enabled && isActiveRun(initial),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      enabled && query.state.data && isActiveRun(query.state.data)
        ? 15_000
        : false,
  });
  const run = isActiveRun(initial) ? summary.data : initial;
  const when = formatTime(run.startedAt);
  return (
    <article className="source-history-run">
      <div className="source-history-summary">
        <div className="source-history-time">
          <time dateTime={run.startedAt}>{when}</time>
          <span>{run.trigger === "scheduled" ? "定时同步" : "手动同步"}</span>
        </div>
        <Badge
          tone={
            run.status === "succeeded" && run.anomalyTargets > 0
              ? "warning"
              : statusTone(run.status)
          }
        >
          {statusLabels[run.status]}
          {run.status === "succeeded" && run.anomalyTargets > 0
            ? " · 有异常"
            : ""}
        </Badge>
        <div className="source-history-counts">
          <span>
            已结束 {run.completedTargets}/{run.targetCount} 账号
          </span>
          <span>新增 {run.candidatesCreated} 帖</span>
          <span>原图 {run.mediaStored} 张</span>
          {run.anomalyTargets > 0 && (
            <span>异常 {run.anomalyTargets} 账号</span>
          )}
          {run.waitingTargets > 0 && (
            <span>等待 {run.waitingTargets} 账号</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={opened}
          aria-controls={`source-run-${run.id}`}
          aria-label={`查看批次详情 ${when}`}
          leadingIcon={
            <ChevronDown size={15} className={opened ? "is-open" : ""} />
          }
          onClick={onToggle}
        >
          详情
        </Button>
      </div>
      {summary.isError && (
        <p role="alert">活动批次状态更新失败，请刷新重试。</p>
      )}
      {opened && (
        <div className="source-history-run-detail" id={`source-run-${run.id}`}>
          <SourceHistoryTasks run={run} enabled={enabled} />
        </div>
      )}
    </article>
  );
}

export function SourceFetchHistory({ enabled = true }: { enabled?: boolean }) {
  const visible = useHistoryVisible(enabled);
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<SourceRun["trigger"] | "all">("all");
  const [status, setStatus] = useState<SourceRun["status"] | "all">("all");
  const page = useHistoryPage();
  const query = useQuery({
    queryKey: [
      "source-history",
      "runs",
      trigger,
      status,
      page.cursor,
      page.revision,
    ],
    enabled: visible,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/source-fetch/runs", {
          params: {
            query: {
              limit: 10,
              cursor: page.cursor,
              trigger: trigger === "all" ? undefined : trigger,
              status: status === "all" ? undefined : status,
            },
          },
          signal,
        }),
      ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (!visible)
      void queryClient.cancelQueries({ queryKey: ["source-history"] });
  }, [visible, queryClient]);
  const reset = () => {
    page.reset();
    setExpanded(null);
  };
  return (
    <Surface className="source-history">
      <header className="source-history-heading">
        <h2>同步记录</h2>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<RefreshCw size={15} />}
          onClick={reset}
          disabled={!visible}
          loading={query.isFetching}
        >
          刷新
        </Button>
      </header>
      <div className="source-history-filters source-history-run-filters">
        <SelectField
          label="触发方式"
          value={trigger}
          onValueChange={(value) => {
            setTrigger(value as typeof trigger);
            reset();
          }}
        >
          <option value="all">全部</option>
          <option value="scheduled">定时同步</option>
          <option value="manual">手动同步</option>
        </SelectField>
        <SelectField
          label="批次状态"
          value={status}
          onValueChange={(value) => {
            setStatus(value as typeof status);
            reset();
          }}
        >
          <option value="all">全部</option>
          {Object.entries(statusLabels)
            .filter(([key]) => key !== "waiting" && key !== "skipped")
            .map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
        </SelectField>
      </div>
      {query.isPending && visible && <p role="status">正在读取同步记录…</p>}
      {query.isError && <p role="alert">同步记录读取失败，请重试。</p>}
      {query.data?.items?.length === 0 && <p>暂无同步记录。</p>}
      <div>
        {query.data?.items?.map((run) => (
          <SourceRunRow
            key={run.id}
            initial={run}
            opened={expanded === run.id}
            enabled={visible}
            onToggle={() => setExpanded(expanded === run.id ? null : run.id)}
          />
        ))}
      </div>
      {query.data && (
        <div className="source-history-pagination">
          <span className="source-history-observed">
            读取于 {formatTime(query.data.observedAt)}
          </span>
          {page.previous.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!visible || query.isFetching}
              onClick={() => {
                page.back();
                setExpanded(null);
              }}
            >
              上一页批次
            </Button>
          )}
          {query.data.nextCursor && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!visible || query.isFetching}
              onClick={() => {
                page.next(query.data.nextCursor!);
                setExpanded(null);
              }}
            >
              下一页批次
            </Button>
          )}
        </div>
      )}
    </Surface>
  );
}
