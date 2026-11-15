import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { ChevronDown, Download, RefreshCw } from "lucide-react";
import {
  Badge,
  Button,
  SelectField,
  Surface,
  TextField,
} from "../../components/ui";
import { Feedback } from "../account/forms";
import { client, unwrap } from "../account/api";
import {
  formatTime,
  useHistoryPage,
  useHistoryVisible,
} from "./source-history";
import "./ArchiveExportManagement.css";

type Run = components["schemas"]["ArchiveExportRunDto"];
type Scope = components["schemas"]["ArchiveExportScopeDto"];
type Preview = components["schemas"]["ArchiveExportPreviewDto"];
const labels: Record<Run["status"], string> = {
  queued: "排队中",
  preparing: "准备中",
  generating: "生成中",
  succeeded: "已完成",
  partial: "部分失败",
  failed: "失败",
  cancelling: "取消中",
  cancelled: "已取消",
};
const contents = { raw: "生肉", rendered: "熟肉", both: "生肉＋熟肉" } as const;
const packageLabels: Record<string, string> = {
  queued: "排队中",
  generating: "生成中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  deleted: "已删除",
};
const issueLabels: Record<string, string> = {
  missing_rendered: "缺少当前采用的成图",
  text_binding_invalid: "原文字版本关联无效，已使用可验证来源",
  rendered_binding_invalid: "成图版本关联无效",
  text_binding_unverified: "无法验证文字与成图或交接的关联，已保存当前正文",
  text_draft: "已保存当前未交接的翻校正文",
  text_encoding_failed: "翻校文本生成失败，图片仍保留",
};
const errorLabels: Record<string, string> = {
  generation_failed: "归档生成失败，请重试失败分包",
  cleanup_failed: "导出文件清理失败，请重试删除",
  owner_unsettled: "上次执行尚未确认停止，请联系维护者恢复",
  deadline_exceeded: "已超过本次导出的运行时限",
  state_changed: "任务状态已改变，请刷新后重试",
  source_unavailable: "部分源文件暂不可用",
  cancelled: "任务已取消",
  attempts_exhausted: "已达到重试次数上限",
  run_budget_exceeded: "本次导出超过容量上限",
  cache_budget_exceeded: "导出缓存空间不足",
  source_checksum_mismatch: "源文件校验不一致",
  snapshot_invalid: "导出快照无效，请联系维护者检查",
  receipt_mismatch: "分包完成记录不一致，请联系维护者检查",
};
function errorLabel(value: string) {
  return errorLabels[value.replace(/^archive_/, "")] ?? value;
}
const active = (run: Run) =>
  ["queued", "preparing", "generating", "cancelling"].includes(run.status);
const polling = (run: Run) => active(run) || run.filesStatus === "deleting";
function bytes(value: string | null) {
  const size = Number(value ?? 0);
  return size >= 1024 ** 3
    ? `${(size / 1024 ** 3).toFixed(2)} GiB`
    : `${(size / 1024 ** 2).toFixed(1)} MiB`;
}
function scopeLabel(scope: Pick<Scope, "year" | "month" | "content">) {
  return `${scope.year} 年${scope.month ? ` ${scope.month} 月` : "全年"} · ${contents[scope.content]}`;
}
function errorMessage(error: unknown) {
  return error instanceof Error
    ? errorLabel(error.message)
    : "操作失败，请重试。";
}
function Pagination({
  page,
  nextCursor,
  disabled,
  name,
}: {
  page: ReturnType<typeof useHistoryPage>;
  nextCursor?: string | null;
  disabled: boolean;
  name: string;
}) {
  return (
    <div className="archive-export-pagination">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !page.previous.length}
        onClick={page.back}
      >
        上一页{name}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled || !nextCursor}
        onClick={() => nextCursor && page.next(nextCursor)}
      >
        下一页{name}
      </Button>
    </div>
  );
}

function ExportDetails({ run, visible }: { run: Run; visible: boolean }) {
  const packagesPage = useHistoryPage();
  const issuesPage = useHistoryPage();
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState("");
  const [notice, setNotice] = useState("");
  const packages = useQuery({
    queryKey: [
      "archive-exports",
      "packages",
      run.id,
      run.status,
      run.filesStatus,
      packagesPage.cursor,
    ],
    enabled: visible,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/archive-exports/{id}/packages", {
          params: {
            path: { id: run.id },
            query: { limit: 20, cursor: packagesPage.cursor },
          },
          signal,
        }),
      ),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: visible && polling(run) ? 5000 : false,
  });
  const issues = useQuery({
    queryKey: [
      "archive-exports",
      "issues",
      run.id,
      run.status,
      issuesPage.cursor,
    ],
    enabled: visible,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/archive-exports/{id}/issues", {
          params: {
            path: { id: run.id },
            query: { limit: 20, cursor: issuesPage.cursor },
          },
          signal,
        }),
      ),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: visible && polling(run) ? 5000 : false,
  });
  async function download(packageId: string) {
    setDownloading(packageId);
    setDownloadError("");
    setNotice("");
    try {
      const result = await unwrap(
        await client.GET(
          "/api/archive-exports/{id}/packages/{packageId}/download",
          {
            params: { path: { id: run.id, packageId } },
          },
        ),
      );
      const link = document.createElement("a");
      link.href = result.url;
      link.download = result.fileName;
      link.rel = "noopener";
      link.click();
      setNotice("已交付浏览器下载，请在本地核对文件。链接过期可重新下载。");
    } catch (error) {
      setDownloadError(errorMessage(error));
    } finally {
      setDownloading("");
    }
  }
  const filesUnavailable =
    run.filesStatus === "deleting" ||
    run.filesStatus === "deleted" ||
    (!!run.expiresAt && Date.parse(run.expiresAt) <= Date.now());
  return (
    <div className="archive-export-details" id={`archive-export-${run.id}`}>
      <div className="archive-export-facts">
        <span>作品 {run.workCount}</span>
        <span>图片 {run.imageCount}</span>
        <span>文本 {run.textCount}</span>
        <span>已生成 {bytes(run.completedBytes)}</span>
        <span>警告 {run.warningCount}</span>
        <span>异常 {run.failureCount}</span>
        {run.expiresAt && <span>ZIP 保留至 {formatTime(run.expiresAt)}</span>}
      </div>
      {run.error && <Feedback error={errorLabel(run.error)} />}
      {run.deletionError && (
        <Feedback error={`ZIP 删除失败：${errorLabel(run.deletionError)}。`} />
      )}
      <h4>ZIP 分包</h4>
      {packages.isPending && <p role="status">正在读取分包…</p>}
      {packages.isError && <Feedback error="分包读取失败，请重试。" />}
      {packages.isError && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void packages.refetch()}
        >
          重试读取分包
        </Button>
      )}
      {packages.data?.items.length === 0 && <p>暂无分包。</p>}
      <ul className="archive-export-packages">
        {packages.data?.items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.fileName}</strong>
              <span>
                {bytes(item.bytes)} ·{" "}
                {packageLabels[item.status] ?? item.status}
              </span>
              {item.error && <Feedback error={errorLabel(item.error)} />}
              {item.checksum && (
                <code title="SHA-256">SHA-256 {item.checksum}</code>
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<Download size={15} />}
              loading={downloading === item.id}
              disabled={
                !visible ||
                filesUnavailable ||
                !item.downloadable ||
                !!downloading
              }
              onClick={() => void download(item.id)}
            >
              下载 ZIP
            </Button>
          </li>
        ))}
      </ul>
      <Feedback error={downloadError} success={notice} />
      {packages.data && (
        <Pagination
          page={packagesPage}
          nextCursor={packages.data.nextCursor}
          disabled={!visible || packages.isFetching}
          name="分包"
        />
      )}
      <h4>异常与说明</h4>
      {issues.isPending && <p role="status">正在读取异常…</p>}
      {issues.isError && (
        <>
          <Feedback error="异常明细读取失败。" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void issues.refetch()}
          >
            重试读取异常
          </Button>
        </>
      )}
      {issues.data?.items.length === 0 && <p>暂无异常。</p>}
      <ul className="archive-export-issues">
        {issues.data?.items.map((issue) => (
          <li key={issue.id}>
            作品 #{issue.workNumber}：
            {issue.codes.map((code) => issueLabels[code] ?? code).join("；")}
          </li>
        ))}
      </ul>
      {issues.data && (
        <Pagination
          page={issuesPage}
          nextCursor={issues.data.nextCursor}
          disabled={!visible || issues.isFetching}
          name="异常"
        />
      )}
    </div>
  );
}

function DeleteFilesDialog({
  run,
  current,
  onClose,
  onDelete,
  busy,
  error,
  onRecheck,
}: {
  run: Run;
  current: Run;
  onClose: () => void;
  onDelete: () => void;
  busy: boolean;
  error: string;
  onRecheck: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const title = useId();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    const restoreFocusTo = opener.current;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    return () => {
      // StrictMode replays setup/cleanup while the node is still connected.
      // Release its native modal focus trap before restoring the opener.
      element?.close?.();
      document.body.style.overflow = previous;
      restoreFocusTo?.focus();
    };
  }, []);
  const stale =
    current.revision !== run.revision ||
    active(current) ||
    current.filesStatus === "deleting" ||
    current.filesStatus === "deleted";
  return (
    <dialog
      className="archive-export-dialog"
      ref={ref}
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="archive-export-heading">
        <h3 id={title}>删除导出 ZIP</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onClose}
        >
          关闭
        </Button>
      </div>
      <p>{scopeLabel(run)}</p>
      <p>
        仅删除本次导出生成的 ZIP
        和临时文件。作品原图、成图和翻校文字保留，导出记录继续保留。
      </p>
      <label className="archive-export-check">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || stale}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        我已下载并核对需要保留的文件
      </label>
      {stale && (
        <>
          <Feedback error="任务状态已改变，请重新核对后确认。" />
          <Button
            type="button"
            variant="secondary"
            disabled={
              busy ||
              active(current) ||
              current.filesStatus === "deleting" ||
              current.filesStatus === "deleted"
            }
            onClick={() => {
              setConfirmed(false);
              onRecheck();
            }}
          >
            重新核对当前任务
          </Button>
        </>
      )}
      <Feedback error={error} />
      <div className="archive-export-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onClose}
        >
          保留文件
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={busy}
          disabled={!confirmed || stale}
          onClick={onDelete}
        >
          确认删除 ZIP
        </Button>
      </div>
    </dialog>
  );
}

export function ArchiveExportManagement({
  enabled = true,
}: {
  enabled?: boolean;
}) {
  const visible = useHistoryVisible(enabled);
  const cache = useQueryClient();
  const page = useHistoryPage();
  const [scope, setScope] = useState<Scope>(() => ({
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    content: "both",
    includeArchived: false,
    includeDiscarded: false,
  }));
  const scopeEpoch = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<{
    data: Preview;
    scope: Scope;
    epoch: number;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<Run | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const createIntent = useRef<{ epoch: number; id: string } | null>(null);
  const actionIntents = useRef(new Map<string, string>());
  const [settingDraft, setSettingDraft] = useState<{
    value: string;
    revision: number;
  } | null>(null);
  const [settingConflict, setSettingConflict] = useState(false);
  const [settingError, setSettingError] = useState("");
  const [settingSuccess, setSettingSuccess] = useState("");
  const settings = useQuery({
    queryKey: ["archive-exports", "settings"],
    enabled: visible,
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/archive-exports/settings", { signal })),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const runs = useQuery({
    queryKey: ["archive-exports", "runs", page.cursor, page.revision],
    enabled: visible,
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/archive-exports", {
          params: { query: { limit: 10, cursor: page.cursor } },
          signal,
        }),
      ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      visible && query.state.data?.items.some(polling) ? 5000 : false,
  });
  useEffect(() => {
    if (!visible) {
      void cache.cancelQueries({ queryKey: ["archive-exports"] });
      previewAbort.current?.abort();
      scopeEpoch.current += 1;
      setPreview(null);
      setPreviewing(false);
      setDeletion(null);
    }
    return () => previewAbort.current?.abort();
  }, [visible, cache]);
  const changeScope = (next: Partial<Scope>) => {
    scopeEpoch.current += 1;
    previewAbort.current?.abort();
    setPreviewing(false);
    setScope((current) => ({ ...current, ...next }));
    setPreview(null);
    setError("");
    setSuccess("");
    createIntent.current = null;
  };
  const validYear =
    Number.isInteger(scope.year) && scope.year >= 2000 && scope.year <= 9998;
  async function getPreview() {
    if (!visible || !settings.data?.enabled || !validYear || busy) return;
    previewAbort.current?.abort();
    const abort = new AbortController();
    previewAbort.current = abort;
    const epoch = ++scopeEpoch.current;
    const snapshot = { ...scope };
    setPreviewing(true);
    setPreview(null);
    setError("");
    setSuccess("");
    try {
      const data = await unwrap(
        await client.POST("/api/archive-exports/preview", {
          body: snapshot,
          signal: abort.signal,
        }),
      );
      if (epoch === scopeEpoch.current && !abort.signal.aborted)
        setPreview({ data, scope: snapshot, epoch });
    } catch (cause) {
      if (epoch === scopeEpoch.current && !abort.signal.aborted)
        setError(errorMessage(cause));
    } finally {
      if (epoch === scopeEpoch.current) setPreviewing(false);
    }
  }
  async function create() {
    if (
      !visible ||
      !settings.data?.enabled ||
      !preview ||
      preview.epoch !== scopeEpoch.current ||
      busy
    )
      return;
    const frozen = preview;
    if (createIntent.current?.epoch !== frozen.epoch)
      createIntent.current = { epoch: frozen.epoch, id: crypto.randomUUID() };
    setBusy("create");
    setError("");
    setSuccess("");
    try {
      await unwrap(
        await client.POST("/api/archive-exports", {
          body: { ...frozen.scope, idempotencyKey: createIntent.current.id },
        }),
      );
      setPreview(null);
      createIntent.current = null;
      page.reset();
      await cache.invalidateQueries({ queryKey: ["archive-exports", "runs"] });
      setSuccess("导出任务已创建，关闭页面后仍会继续生成。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  async function saveSettings() {
    if (!settingDraft || settingConflict || !visible || busy) return;
    const value = Number(settingDraft.value);
    if (
      !settingDraft.value.trim() ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 1024
    ) {
      setSettingError("请输入 0–1024 之间的整数。");
      return;
    }
    setBusy("settings");
    setSettingError("");
    setSettingSuccess("");
    try {
      const result = await client.PATCH("/api/archive-exports/settings", {
        body: {
          expectedRevision: settingDraft.revision,
          bandwidthLimitMiB: value,
        },
      });
      if (result.response.status === 409) {
        setSettingConflict(true);
        await settings.refetch();
        setSettingError(
          "设置已被其他管理员更新。当前输入已保留，请采用最新版本后再保存。",
        );
        return;
      }
      const data = await unwrap(result);
      cache.setQueryData(["archive-exports", "settings"], data);
      setSettingDraft(null);
      setSettingSuccess("生成带宽已保存，将应用于正在运行和后续任务。");
    } catch (cause) {
      setSettingError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  async function action(run: Run, kind: "cancel" | "retry" | "delete-files") {
    if (!visible || busy) return;
    if (
      kind === "delete-files" &&
      (!deletion || deletion.revision !== run.revision || active(run))
    )
      return;
    const key = `${run.id}:${run.revision}:${kind}`;
    if (!actionIntents.current.has(key))
      actionIntents.current.set(key, crypto.randomUUID());
    const body = {
      expectedRevision: run.revision,
      idempotencyKey: actionIntents.current.get(key)!,
    };
    setBusy(key);
    setError("");
    setDeleteError("");
    try {
      const params = { path: { id: run.id } };
      const result =
        kind === "cancel"
          ? await client.POST("/api/archive-exports/{id}/cancel", {
              params,
              body,
            })
          : kind === "retry"
            ? await client.POST("/api/archive-exports/{id}/retry", {
                params,
                body,
              })
            : await client.POST("/api/archive-exports/{id}/delete-files", {
                params,
                body: { ...body, confirmedDownloaded: true },
              });
      if (result.response.status === 409) {
        await cache.invalidateQueries({ queryKey: ["archive-exports"] });
        throw new Error("任务状态已改变，请核对最新状态后重试。");
      }
      const updated = await unwrap(result);
      cache.setQueriesData<components["schemas"]["ArchiveExportListDto"]>(
        { queryKey: ["archive-exports", "runs"] },
        (previous) =>
          previous
            ? {
                ...previous,
                items: previous.items.map((item) =>
                  item.id === updated.id ? updated : item,
                ),
              }
            : previous,
      );
      await cache.invalidateQueries({ queryKey: ["archive-exports"] });
      actionIntents.current.delete(key);
      if (kind === "delete-files") setDeletion(null);
      setSuccess(
        kind === "cancel"
          ? "已请求取消，等待正在执行的操作安全结束。"
          : kind === "retry"
            ? "已请求重试失败分包，已完成的分包保留。"
            : "已请求删除导出文件，导出记录保留。",
      );
    } catch (cause) {
      if (kind === "delete-files") setDeleteError(errorMessage(cause));
      else setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  const currentDeletion =
    deletion &&
    (runs.data?.items.find((run) => run.id === deletion.id) ?? deletion);
  return (
    <div className="archive-export-management">
      <Surface className="archive-export-panel">
        <h2>作品归档导出</h2>
        <p className="archive-export-muted">
          按作品入库日期（上海时间）导出当前采用的图片和配套翻校文本。
        </p>
        {settings.isPending && visible && (
          <p role="status">正在读取导出配置…</p>
        )}
        {settings.isError && (
          <>
            <Feedback error="导出配置读取失败。" />
            <Button
              variant="ghost"
              disabled={!visible}
              onClick={() => void settings.refetch()}
            >
              重试读取配置
            </Button>
          </>
        )}
        {settings.data && !settings.data.enabled && (
          <p className="account-notice" role="status">
            此部署尚未启用归档导出，请联系部署管理员。已有记录仍可查看。
          </p>
        )}
        <div className="archive-export-form">
          <TextField
            label="入库年份"
            type="number"
            min={2000}
            max={9998}
            step={1}
            value={scope.year}
            disabled={!!busy}
            onChange={(event) =>
              changeScope({ year: Number(event.target.value) })
            }
          />
          <SelectField
            label="入库月份"
            value={scope.month ?? "year"}
            disabled={!!busy}
            onValueChange={(value) =>
              changeScope({ month: value === "year" ? null : Number(value) })
            }
          >
            <option value="year">全年</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1} 月
              </option>
            ))}
          </SelectField>
          <SelectField
            label="导出内容"
            value={scope.content}
            disabled={!!busy}
            onValueChange={(value) =>
              changeScope({ content: value as Scope["content"] })
            }
          >
            {Object.entries(contents).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="archive-export-actions">
          <label className="archive-export-check">
            <input
              type="checkbox"
              checked={!!scope.includeArchived}
              disabled={!!busy}
              onChange={(event) =>
                changeScope({ includeArchived: event.target.checked })
              }
            />
            包含归档作品
          </label>
          <label className="archive-export-check">
            <input
              type="checkbox"
              checked={!!scope.includeDiscarded}
              disabled={!!busy}
              onChange={(event) =>
                changeScope({ includeDiscarded: event.target.checked })
              }
            />
            包含舍弃作品
          </label>
        </div>
        <div className="archive-export-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={
              !visible || !settings.data?.enabled || !validYear || !!busy
            }
            loading={previewing}
            onClick={() => void getPreview()}
          >
            预览导出
          </Button>
        </div>
        {preview && (
          <div className="archive-export-preview" aria-live="polite">
            <h3>{scopeLabel(preview.scope)}</h3>
            <div className="archive-export-facts">
              <span>作品 {preview.data.workCount}</span>
              <span>图片 {preview.data.imageCount}</span>
              <span>文本 {preview.data.textCount}</span>
              <span>缺少成图 {preview.data.missingRenderedCount}</span>
              <span>警告 {preview.data.warningCount}</span>
              <span>异常 {preview.data.failureCount}</span>
              <span>预估 {bytes(preview.data.estimatedBytes)}</span>
            </div>
            <p className="archive-export-muted">
              预览为当前估算；后台执行时逐月固定本次导出内容。生成期间可下载已完成的独立
              ZIP。
            </p>
            <Button
              type="button"
              disabled={
                !visible ||
                !settings.data?.enabled ||
                !!busy ||
                preview.epoch !== scopeEpoch.current
              }
              loading={busy === "create"}
              onClick={() => void create()}
            >
              创建导出任务
            </Button>
          </div>
        )}
        <Feedback error={error} success={success} />
      </Surface>
      <Surface className="archive-export-panel">
        <h2>生成带宽</h2>
        <div className="archive-export-bandwidth">
          <TextField
            label="归档生成带宽（MiB/s）"
            type="number"
            min={0}
            max={1024}
            step={1}
            value={settingDraft?.value ?? settings.data?.bandwidthLimitMiB ?? 0}
            disabled={!settings.data || !!busy}
            hint="0 为不限速；不限制浏览器直接下载 ZIP 的速度。"
            onChange={(event) => {
              if (settings.data)
                setSettingDraft({
                  value: event.target.value,
                  revision: settingDraft?.revision ?? settings.data.revision,
                });
              setSettingSuccess("");
            }}
          />
          <Button
            type="button"
            disabled={!visible || !settingDraft || !!busy || settingConflict}
            loading={busy === "settings"}
            onClick={() => void saveSettings()}
          >
            保存带宽
          </Button>
        </div>
        <Feedback error={settingError} success={settingSuccess} />
        {settingConflict && (
          <Button
            type="button"
            variant="secondary"
            disabled={
              !settings.data ||
              settings.isFetching ||
              settings.isError ||
              !!busy
            }
            onClick={() => {
              if (settings.data && settingDraft) {
                setSettingDraft({
                  ...settingDraft,
                  revision: settings.data.revision,
                });
                setSettingConflict(false);
                setSettingError("");
              }
            }}
          >
            采用最新版本并保留输入
          </Button>
        )}
      </Surface>
      <Surface className="archive-export-panel">
        <header className="archive-export-heading">
          <h2>导出记录</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leadingIcon={<RefreshCw size={15} />}
            disabled={!visible || !!busy}
            loading={runs.isFetching}
            onClick={() => {
              page.reset();
              setExpanded(null);
              void cache.invalidateQueries({
                queryKey: ["archive-exports", "runs"],
              });
            }}
          >
            刷新记录
          </Button>
        </header>
        {runs.isPending && visible && <p role="status">正在读取导出记录…</p>}
        {runs.isError && <Feedback error="导出记录读取失败，请刷新重试。" />}
        {runs.data?.items.length === 0 && <p>暂无导出记录。</p>}
        {runs.data?.items.map((run) => (
          <article key={run.id} className="archive-export-run">
            <div className="archive-export-summary">
              <div className="archive-export-identity">
                <strong>{scopeLabel(run)}</strong>
                <time dateTime={run.createdAt}>
                  {formatTime(run.createdAt)}
                </time>
              </div>
              <div className="archive-export-state">
                <Badge
                  tone={
                    run.status === "succeeded"
                      ? "success"
                      : run.status === "failed"
                        ? "danger"
                        : run.status === "partial"
                          ? "warning"
                          : "neutral"
                  }
                >
                  {labels[run.status]}
                </Badge>
                {run.filesStatus === "deleting" && <span>ZIP 删除中</span>}
                {run.filesStatus === "deleted" && <span>ZIP 已删除</span>}
                {run.filesStatus === "delete_failed" && (
                  <span>ZIP 删除失败，可重试</span>
                )}
              </div>
              <span className="archive-export-count">
                {run.filesStatus === "deleted"
                  ? "ZIP 已清理"
                  : `${run.completedPackageCount} / ${run.packageCount} 包已生成`}
              </span>
              <div className="archive-export-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={expanded === run.id}
                  aria-controls={`archive-export-${run.id}`}
                  leadingIcon={<ChevronDown size={15} />}
                  onClick={() =>
                    setExpanded(expanded === run.id ? null : run.id)
                  }
                >
                  查看与下载
                </Button>
                {active(run) && run.status !== "cancelling" && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!visible || !!busy}
                    onClick={() => void action(run, "cancel")}
                  >
                    取消任务
                  </Button>
                )}
                {["failed", "partial"].includes(run.status) &&
                  run.filesStatus === "available" && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!visible || !!busy || !settings.data?.enabled}
                      onClick={() => void action(run, "retry")}
                    >
                      重试失败包
                    </Button>
                  )}
                {!active(run) &&
                  ["available", "delete_failed"].includes(run.filesStatus) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!visible || !!busy}
                      onClick={() => {
                        setDeleteError("");
                        setDeletion(run);
                      }}
                    >
                      {" "}
                      {run.filesStatus === "delete_failed"
                        ? "重试删除 ZIP"
                        : "删除 ZIP"}
                    </Button>
                  )}
              </div>
            </div>
            {expanded === run.id && (
              <ExportDetails run={run} visible={visible} />
            )}
          </article>
        ))}
        {runs.data && (
          <Pagination
            page={page}
            nextCursor={runs.data.nextCursor}
            disabled={!visible || runs.isFetching || !!busy}
            name="记录"
          />
        )}
      </Surface>
      {visible && deletion && currentDeletion && (
        <DeleteFilesDialog
          key={`${deletion.id}:${deletion.revision}`}
          run={deletion}
          current={currentDeletion}
          onClose={() => setDeletion(null)}
          onRecheck={() => setDeletion(currentDeletion)}
          onDelete={() => void action(currentDeletion, "delete-files")}
          busy={!!busy}
          error={deleteError}
        />
      )}
    </div>
  );
}
