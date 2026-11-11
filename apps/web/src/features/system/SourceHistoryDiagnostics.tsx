import type { components } from "@comiku/api-client";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button } from "../../components/ui";
import { client, unwrap } from "../account/api";
import {
  failureLabel,
  formatTime,
  statusTone,
  useHistoryPage,
} from "./source-history";

type DetailProps = { runId: string; taskId: string; enabled: boolean };
const stages: Record<string, string> = {
  execution: "执行",
  prepare_scan: "准备扫描",
  recovery_prepare: "准备补偿",
  fetch_page: "读取页面",
  fetch_post: "读取帖子",
  validate_post: "校验帖子",
  download: "下载媒体",
  store: "存储原图",
  sign: "签名",
  missing: "检查缺口",
  cleanup: "清理资源",
};
const scopes: Record<string, string> = {
  credential: "凭据",
  source: "图源",
  post: "帖子",
  media: "媒体",
  transport: "网络",
  storage: "存储",
  protocol: "协议",
  configuration: "配置",
};
const transportErrors: Record<string, string> = {
  tls_unexpected_eof: "TLS 连接提前关闭（EOF）",
  tls_certificate: "TLS 证书验证失败",
  connection_reset: "连接被重置",
  connection_refused: "连接被拒绝",
  dns_error: "域名解析失败",
  connect_timeout: "建立连接超时",
  read_timeout: "读取响应超时",
};
const responseFormats: Record<string, string> = {
  empty: "空响应",
  json: "JSON",
  html: "HTML",
  text: "文本",
  binary: "二进制",
};
function bytes(value: number) {
  return `${Number((value / 1048576).toFixed(2))} MiB（${value} 字节）`;
}
function DiagnosticSample({
  sample,
}: {
  sample: components["schemas"]["SourceDiagnosticSampleDto"];
}) {
  return (
    <li className="source-history-diagnostic">
      <p>
        <strong>
          {(sample.transportError && transportErrors[sample.transportError]) ||
            failureLabel(sample.reason)}
        </strong>
      </p>
      {sample.missingField ? (
        <p>
          响应缺少 {sample.missingField} 字段
          {sample.exceptionType ? `（${sample.exceptionType}）` : ""}
        </p>
      ) : (
        sample.exceptionType && <p>异常类型 {sample.exceptionType}</p>
      )}
      <div className="source-history-fact-line">
        <span>
          {stages[sample.stage] ?? "执行"} · {scopes[sample.scope] ?? "图源"}
        </span>
        <span>{formatTime(sample.occurredAt)}</span>
      </div>
      <div className="source-history-fact-line">
        {sample.httpStatus !== undefined && (
          <span>HTTP {sample.httpStatus}</span>
        )}
        {sample.limitBytes !== undefined && (
          <span>限制 {bytes(sample.limitBytes)}</span>
        )}
        {sample.observedBytes !== undefined && (
          <span>已接收 {bytes(sample.observedBytes)}</span>
        )}
        {sample.declaredBytes !== undefined && (
          <span>声明大小 {bytes(sample.declaredBytes)}</span>
        )}
        {sample.durationMs !== undefined && (
          <span>耗时 {sample.durationMs / 1000} 秒</span>
        )}
        {sample.timeout && <span>发生超时</span>}
        {sample.responseBytes !== undefined && (
          <span>
            返回 {sample.responseBytes} 字节
            {sample.responseFormat && responseFormats[sample.responseFormat]
              ? ` · ${responseFormats[sample.responseFormat]}`
              : ""}
          </span>
        )}
        {sample.responseBytes === undefined &&
          sample.responseFormat &&
          responseFormats[sample.responseFormat] && (
            <span>响应格式 {responseFormats[sample.responseFormat]}</span>
          )}
        {sample.requestOperation && <span>请求 {sample.requestOperation}</span>}
        {sample.runtimeVersion && (
          <span>gallery-dl {sample.runtimeVersion}</span>
        )}
        {sample.exitCode !== undefined && <span>退出码 {sample.exitCode}</span>}
        {sample.signal && <span>退出信号 {sample.signal}</span>}
      </div>
    </li>
  );
}

export function SourceHistoryExecutions({
  runId,
  taskId,
  enabled,
}: DetailProps) {
  const page = useHistoryPage();
  const query = useQuery({
    queryKey: [
      "source-history",
      "executions",
      runId,
      taskId,
      page.cursor,
      page.revision,
    ],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET(
          "/api/source-fetch/runs/{id}/tasks/{taskId}/executions",
          {
            params: {
              path: { id: runId, taskId },
              query: { limit: 20, cursor: page.cursor },
            },
            signal,
          },
        ),
      ),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const labels = {
    succeeded: "业务完成",
    partial_failed: "业务部分失败",
    failed: "业务失败",
    deferred: "本次暂缓",
  };
  return (
    <section className="source-history-fact">
      <div className="source-history-heading">
        <h5>本次扫描记录</h5>
        <Button
          variant="ghost"
          size="sm"
          disabled={!enabled}
          loading={query.isFetching}
          onClick={page.reset}
        >
          刷新扫描记录
        </Button>
      </div>
      {query.isPending && enabled && <p role="status">正在读取扫描记录…</p>}
      {query.isError && <p role="alert">扫描记录读取失败，请刷新重试。</p>}
      {query.data?.items.length === 0 && (
        <p>该批未保留详细诊断，只有历史结果摘要。</p>
      )}
      {query.data?.items.map((execution) => (
        <article className="source-history-execution" key={execution.id}>
          <div className="source-history-fact-line">
            <strong>
              预算第 {execution.budgetAttempt} 次
              {execution.budgetRefunded ? "（已退还）" : ""}
            </strong>
            <span>准入 {formatTime(execution.admittedAt)}</span>
            <Badge
              tone={
                execution.businessOutcome
                  ? statusTone(execution.businessOutcome)
                  : "neutral"
              }
            >
              {execution.businessOutcome
                ? labels[execution.businessOutcome]
                : "尚无业务结果"}
            </Badge>
          </div>
          <div className="source-history-fact-line">
            {execution.businessFinishedAt && (
              <span>业务结束 {formatTime(execution.businessFinishedAt)}</span>
            )}
            <span>
              {execution.settledAt
                ? `执行结束已确认 ${formatTime(execution.settledAt)}`
                : "执行结束尚未确认"}
            </span>
          </div>
          {execution.diagnostics.samples.length > 0 && (
            <ul className="source-history-diagnostics">
              {execution.diagnostics.samples.map((sample, index) => (
                <DiagnosticSample key={index} sample={sample} />
              ))}
            </ul>
          )}
          {execution.diagnostics.omitted > 0 && (
            <p className="source-history-muted">
              另有 {execution.diagnostics.omitted} 条诊断未展示
            </p>
          )}
        </article>
      ))}
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
              onClick={page.back}
            >
              上一页扫描记录
            </Button>
          )}
          {query.data.nextCursor && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!enabled || query.isFetching}
              onClick={() => page.next(query.data.nextCursor!)}
            >
              下一页扫描记录
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function SourceHistoryGaps({ runId, taskId, enabled }: DetailProps) {
  const page = useHistoryPage();
  const query = useQuery({
    queryKey: [
      "source-history",
      "gaps",
      runId,
      taskId,
      page.cursor,
      page.revision,
    ],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/source-fetch/runs/{id}/tasks/{taskId}/gaps", {
          params: {
            path: { id: runId, taskId },
            query: { limit: 20, cursor: page.cursor },
          },
          signal,
        }),
      ),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const states: Record<string, string> = {
    metadata_pending: "待补帖子信息",
    media_pending: "待补原图",
    needs_attention: "需要人工处理",
  };
  const campaignStates: Record<string, string> = {
    queued: "排队中",
    running: "执行中",
    succeeded: "完成",
    failed: "失败",
  };
  return (
    <section className="source-history-fact">
      <div className="source-history-heading">
        <h5>账号当前缺口</h5>
        <Button
          variant="ghost"
          size="sm"
          disabled={!enabled}
          loading={query.isFetching}
          onClick={page.reset}
        >
          刷新缺口
        </Button>
      </div>
      <p className="source-history-muted">
        来自账号当前全部已知帖子，不限定于本批。
      </p>
      {query.isPending && enabled && <p role="status">正在读取当前缺口…</p>}
      {query.isError && <p role="alert">当前缺口读取失败，请刷新重试。</p>}
      {query.data?.items.length === 0 && <p>当前没有未解决的已知帖子缺口。</p>}
      {query.data?.items.map((gap) => (
        <article className="source-history-gap" key={gap.id}>
          <div className="source-history-fact-line">
            <strong>帖子 {gap.postId}</strong>
            <Badge tone="warning">{states[gap.state] ?? "尚未补齐"}</Badge>
          </div>
          {gap.failureCode && (
            <p className="source-history-reason">
              {failureLabel(gap.failureCode)}
            </p>
          )}
          <div className="source-history-fact-line">
            <span>已失败 {gap.attempts} 轮补偿</span>
            {gap.nextRetryAt && (
              <span>下次最早补偿 {formatTime(gap.nextRetryAt)}</span>
            )}
          </div>
          {gap.campaign && (
            <div className="source-history-fact-line">
              <strong>第 {gap.campaign.number} 轮补偿</strong>
              <span>{campaignStates[gap.campaign.state] ?? "处理中"}</span>
              {gap.campaign.failureCode && (
                <span>{failureLabel(gap.campaign.failureCode)}</span>
              )}
              <span>开始 {formatTime(gap.campaign.startedAt)}</span>
              {gap.campaign.completedAt && (
                <span>结束 {formatTime(gap.campaign.completedAt)}</span>
              )}
            </div>
          )}
          <p className="source-history-observed">
            更新于 {formatTime(gap.updatedAt)}
          </p>
        </article>
      ))}
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
              onClick={page.back}
            >
              上一页缺口
            </Button>
          )}
          {query.data.nextCursor && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!enabled || query.isFetching}
              onClick={() => page.next(query.data.nextCursor!)}
            >
              下一页缺口
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
