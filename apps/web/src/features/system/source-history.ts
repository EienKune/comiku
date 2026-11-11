import { useEffect, useState, useSyncExternalStore } from "react";
import type { components } from "@comiku/api-client";

export type SourceRun = components["schemas"]["SourceRunSummaryDto"];
export type SourceTask = components["schemas"]["SourceTaskRowDto"];
export type TaskFilter = SourceTask["status"] | "all" | "anomalies" | "active";
export const statusLabels: Record<
  SourceRun["status"] | SourceTask["status"],
  string
> = {
  queued: "排队中",
  running: "同步中",
  waiting: "等待中",
  succeeded: "完成",
  partial_failed: "部分失败",
  failed: "失败",
  skipped: "跳过",
};
export const taskFilterLabels: Record<TaskFilter, string> = {
  all: "全部",
  anomalies: "本批异常",
  active: "执行中 / 等待",
  queued: "排队中",
  running: "同步中",
  waiting: "等待中",
  succeeded: "完成",
  failed: "失败",
  skipped: "跳过",
};
export function statusTone(status: string) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "partial_failed") return "warning" as const;
  return "neutral" as const;
}
export function isActiveRun(run: SourceRun) {
  return run.status === "running" || run.status === "queued";
}
export function taskStatusLabel(task: SourceTask) {
  return task.status === "succeeded" && task.failureCode === "discovery_gaps"
    ? "媒体有缺口"
    : statusLabels[task.status];
}
export function defaultTaskFilter(run: SourceRun): TaskFilter {
  if (isActiveRun(run)) return "active";
  return run.status === "failed" || run.status === "partial_failed"
    ? "anomalies"
    : "all";
}
export function failureLabel(reason: string | null): string | null {
  if (!reason) return null;
  const labels: Record<string, string> = {
    auth_failed: "认证失败",
    credential_unavailable: "等待凭据复验",
    platform_auth_paused: "等待认证",
    platform_maintenance: "等待平台维护",
    platform_cooldown: "等待平台冷却",
    scope_paused: "等待平台恢复",
    capacity: "等待执行空位",
    scan_busy: "等待账号同步",
    discovery_gaps: "媒体有缺口",
    network_error: "网络连接失败",
    media_network_error: "媒体下载连接失败",
    process_timeout: "采集执行超时",
    worker_attempts_exhausted: "执行预算已用完",
    retry_pending: "等待重试",
    interrupted: "执行中断",
    account_failed: "账号同步失败",
    account_unavailable: "账号不可用",
    source_unavailable: "图源不可用",
    source_forbidden: "图源拒绝访问",
    challenge_required: "需要平台验证",
    rate_limited: "平台限流",
    source_not_found: "图源账号不存在",
    post_not_found: "帖子不存在",
    not_found: "来源不存在",
    media_too_large: "媒体超过大小限制",
    media_size_limit: "媒体超过大小限制",
    media_type_unsupported: "媒体格式不支持",
    media_empty: "媒体内容为空",
    media_url_not_allowed: "媒体地址不符合访问规则",
    storage_failure: "原图存储失败",
    discovery_incomplete: "扫描未完整结束",
    limit_reached: "达到采集上限",
    runtime_unavailable: "采集运行环境不可用",
    source_identity_conflict: "账号身份冲突",
    source_unresolved: "账号身份未确认",
    configuration_error: "图源配置错误",
    invalid_response: "图源响应无效",
    cursor_invalid: "采集游标失效",
    source_changed: "图源配置已改变",
    outside_window_or_unsupported: "不在采集范围或类型不支持",
    already_running: "账号已有同步任务",
    scan_epoch_stale: "账号扫描版本已改变",
    connector_failed: "图源连接失败",
    process_output_limit: "采集输出超过上限",
    process_start: "采集进程启动失败",
    process_exit: "采集进程异常结束",
    invalid_json: "图源返回格式无效",
  };
  const http = /^(media|request)_http_([1-5][0-9]{2})$/.exec(reason);
  return (
    labels[reason] ??
    (http
      ? `${http[1] === "media" ? "媒体下载" : "请求"}失败（HTTP ${http[2]}）`
      : "同步异常，未记录具体原因")
  );
}
export function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}
const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
};
export function useHistoryVisible(enabled: boolean) {
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
  return enabled && visible;
}
export function useDebouncedSearch(value: string) {
  const [search, setSearch] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(value.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [value]);
  return search;
}
export function useHistoryPage() {
  const [page, setPage] = useState<{
    cursor?: string;
    previous: (string | undefined)[];
    revision: number;
  }>({ previous: [], revision: 0 });
  return {
    ...page,
    next: (cursor: string) =>
      setPage((current) => ({
        ...current,
        cursor,
        previous: [...current.previous, current.cursor],
      })),
    back: () =>
      setPage((current) => ({
        ...current,
        cursor: current.previous.at(-1),
        previous: current.previous.slice(0, -1),
      })),
    reset: () =>
      setPage((current) => ({ previous: [], revision: current.revision + 1 })),
  };
}
