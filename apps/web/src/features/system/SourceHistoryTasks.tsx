import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, SearchField, SelectField } from "../../components/ui";
import { PlatformIcon } from "../../components/PlatformIcon";
import { client, unwrap } from "../account/api";
import { SourceHistoryTaskDetail } from "./SourceHistoryTaskDetail";
import { SourceHistoryExecutions } from "./SourceHistoryDiagnostics";
import { ChevronDown } from "lucide-react";
import {
  defaultTaskFilter,
  failureLabel,
  formatTime,
  taskStatusLabel,
  statusTone,
  taskFilterLabels,
  useDebouncedSearch,
  useHistoryPage,
  type SourceRun,
  type TaskFilter,
} from "./source-history";

function SourceTaskPage({
  run,
  enabled,
  filter,
  platform,
  search,
}: {
  run: SourceRun;
  enabled: boolean;
  filter: TaskFilter;
  platform: string;
  search: string;
}) {
  const page = useHistoryPage();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedView, setExpandedView] = useState<"account" | "failure">(
    "account",
  );
  const query = useQuery({
    queryKey: [
      "source-history",
      "tasks",
      run.id,
      filter,
      platform,
      search,
      page.cursor,
      page.revision,
    ],
    enabled,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/source-fetch/runs/{id}/tasks", {
          params: {
            path: { id: run.id },
            query: {
              limit: 20,
              cursor: page.cursor,
              status: filter,
              platform: platform || undefined,
              search: search || undefined,
            },
          },
          signal,
        }),
      ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <>
      <div className="source-history-heading source-history-account-heading">
        <h3>账号记录</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={!enabled}
          loading={query.isFetching}
          onClick={() => {
            page.reset();
            setExpanded(null);
          }}
        >
          刷新账号
        </Button>
      </div>
      {(run.legacy || query.data?.legacy) && (
        <p className="source-history-muted">
          该批仅保留旧版结果摘要，无法还原排队和逐次执行过程。
        </p>
      )}
      {query.isPending && enabled && <p role="status">正在读取账号记录…</p>}
      {query.isError && <p role="alert">账号记录读取失败，请刷新账号重试。</p>}
      {query.data?.items.length === 0 && <p>没有符合筛选的账号。</p>}
      <div className="source-history-accounts">
        {query.data?.items.map((task) => {
          const opened = expanded === task.id;
          const failureOpened = opened && expandedView === "failure";
          const accountOpened = opened && expandedView === "account";
          const reason = failureLabel(task.failureCode);
          const status = (
            <Badge
              tone={
                task.failureCode === "discovery_gaps"
                  ? "warning"
                  : statusTone(task.status)
              }
            >
              {taskStatusLabel(task)}
              {(task.status === "failed" ||
                task.failureCode === "discovery_gaps") && (
                <ChevronDown size={12} aria-hidden="true" />
              )}
            </Badge>
          );
          return (
            <article className="source-history-account" key={task.id}>
              <div className="source-history-account-row">
                <div className="source-history-account-name">
                  <strong>{task.authorName}</strong>
                  <span className="source-history-account-identity">
                    {(task.platform === "x" || task.platform === "pixiv") && (
                      <PlatformIcon platform={task.platform} size={16} />
                    )}
                    {task.handle ?? task.externalUserId}
                  </span>
                </div>
                <div className="source-history-account-state">
                  {task.status === "failed" ||
                  task.failureCode === "discovery_gaps" ? (
                    <button
                      type="button"
                      className="source-history-status-button"
                      aria-label={`查看错误详情 ${task.authorName}`}
                      aria-expanded={failureOpened}
                      aria-controls={`source-task-${task.id}`}
                      onClick={() => {
                        setExpanded(failureOpened ? null : task.id);
                        setExpandedView("failure");
                      }}
                    >
                      {status}
                    </button>
                  ) : (
                    status
                  )}
                  {reason && reason !== taskStatusLabel(task) && (
                    <p className="source-history-reason">{reason}</p>
                  )}
                  {task.deferredUntil && (
                    <span className="source-history-muted">
                      最早可执行 {formatTime(task.deferredUntil)}
                    </span>
                  )}
                </div>
                <div className="source-history-counts">
                  <span>扫描 {task.pagesFetched} 页</span>
                  <span>新增 {task.candidatesCreated} 帖</span>
                  <span>原图 {task.mediaStored} 张</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`查看账号详情 ${task.authorName}`}
                  aria-expanded={accountOpened}
                  aria-controls={`source-task-${task.id}`}
                  onClick={() => {
                    setExpanded(accountOpened ? null : task.id);
                    setExpandedView("account");
                  }}
                >
                  详情
                </Button>
              </div>
              {opened && (
                <div
                  id={`source-task-${task.id}`}
                  className="source-history-task-detail"
                >
                  {failureOpened ? (
                    <SourceHistoryExecutions
                      runId={run.id}
                      taskId={task.id}
                      enabled={enabled}
                    />
                  ) : (
                    <SourceHistoryTaskDetail
                      runId={run.id}
                      taskId={task.id}
                      enabled={enabled}
                    />
                  )}
                </div>
              )}
            </article>
          );
        })}
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
              disabled={!enabled || query.isFetching}
              onClick={() => {
                page.back();
                setExpanded(null);
              }}
            >
              上一页账号
            </Button>
          )}
          {query.data.nextCursor && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!enabled || query.isFetching}
              onClick={() => {
                page.next(query.data.nextCursor!);
                setExpanded(null);
              }}
            >
              下一页账号
            </Button>
          )}
        </div>
      )}
    </>
  );
}

export function SourceHistoryTasks({
  run,
  enabled,
}: {
  run: SourceRun;
  enabled: boolean;
}) {
  const [filter, setFilter] = useState<TaskFilter>(() =>
    defaultTaskFilter(run),
  );
  const [platform, setPlatform] = useState("");
  const [input, setInput] = useState("");
  const search = useDebouncedSearch(input);
  return (
    <>
      <div className="source-history-filters source-history-task-filters">
        <SearchField
          label="搜索作者或账号"
          value={input}
          maxLength={100}
          onChange={(event) => setInput(event.target.value)}
        />
        <SelectField label="平台" value={platform} onValueChange={setPlatform}>
          <option value="">全部</option>
          <option value="x">X</option>
          <option value="pixiv">Pixiv</option>
        </SelectField>
        <SelectField
          label="账号状态"
          value={filter}
          onValueChange={(value) => setFilter(value as TaskFilter)}
        >
          {Object.entries(taskFilterLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </SelectField>
      </div>
      <SourceTaskPage
        key={JSON.stringify([filter, platform, search])}
        run={run}
        enabled={enabled}
        filter={filter}
        platform={platform}
        search={search}
      />
    </>
  );
}
