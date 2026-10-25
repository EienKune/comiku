import { downloadPrepared } from "./transfers-api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Upload, X } from "lucide-react";
import type { components } from "@comiku/api-client";
import { Button } from "../../components/ui";
import { useAccount } from "../account/account-context";
import { client, unwrap } from "../account/api";
import {
  useTopbarActions,
  type TopbarActionRegistration,
} from "../account/topbar-actions";

import { refreshTypesetWork } from "./typeset-batch-api";
import { TypesetUploadDialog } from "./TypesetUploadDialog";

type Item = components["schemas"]["TypesetHandoffManifestItemDto"];
type QueueItem = Item & {
  key: string;
  selected: boolean;
  state: "pending" | "running" | "delivered" | "failed";
  error?: string;
};

export function TypesetBatchTools({
  enabled = true,
  fallbackTopbar = null,
}: {
  enabled?: boolean;
  fallbackTopbar?: TopbarActionRegistration | null;
}) {
  const user = useAccount();
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const delivered = items.filter((item) => item.state === "delivered").length;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    const element = dialog.current;
    return () => element?.close();
  }, [open]);
  const loadManifest = useCallback(async (workId?: string) => {
    setBusy(true);
    setError("");
    try {
      const manifest = await unwrap(
        await client.GET("/api/typeset/handoff-manifest"),
      );
      if (!active.current) return;
      if (workId) {
        const item = manifest.items.find((row) => row.workId === workId);
        if (!item) throw new Error("该作品已不属于当前嵌字待办");
        setItems((previous) => {
          if (!previous.some((row) => row.workId === workId))
            return [
              ...previous,
              {
                ...item,
                key: crypto.randomUUID(),
                selected: item.canDownload,
                state: "pending",
              },
            ];
          return previous.map((row) =>
            row.workId === workId
              ? {
                  ...item,
                  key: crypto.randomUUID(),
                  selected: item.canDownload,
                  state: "pending",
                }
              : row,
          );
        });
      } else {
        setItems(
          manifest.items.map((item) => ({
            ...item,
            key: crypto.randomUUID(),
            selected: item.canDownload,
            state: "pending",
          })),
        );
      }
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : "无法加载清单");
    } finally {
      if (active.current) setBusy(false);
    }
  }, []);

  const registration = useMemo(
    () =>
      fallbackTopbar ??
      (enabled && user.roles.includes("typesetter")
        ? {
            content: (
              <div className="workspace-topbar-actions">
                {uploadProgress ? (
                  <strong>{uploadProgress}</strong>
                ) : busy || delivered ? (
                  <strong>嵌字交接 · {delivered} 项已取得</strong>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Download size={16} />}
                  onClick={() => {
                    setUploadProgress("");
                    setOpen(true);
                    if (!items.length) void loadManifest();
                  }}
                >
                  批量下载嵌字交接包
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Upload size={16} />}
                  onClick={() => setUploadOpen(true)}
                >
                  批量上传成图
                </Button>
              </div>
            ),
            collapsedLabel: uploadProgress
              ? "成图上传"
              : busy || delivered
                ? `交接 ${delivered} 项`
                : "嵌字批量处理",
          }
        : null),
    [
      enabled,
      user.roles,
      busy,
      delivered,
      fallbackTopbar,
      uploadProgress,
      items.length,
      loadManifest,
    ],
  );
  useTopbarActions(registration);

  async function runQueue(rows: QueueItem[]) {
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    for (const item of rows) {
      if (!active.current || controller.signal.aborted) break;
      const update = (patch: Partial<QueueItem>) => {
        if (active.current)
          setItems((previous) =>
            previous.map((row) =>
              row.workId === item.workId ? { ...row, ...patch } : row,
            ),
          );
      };
      update({ state: "running", error: undefined });
      const body = {
        expectedRevision: item.workRevision,
        expectedEditorEpoch: item.editorEpoch,
        idempotencyKey: item.key,
      };
      try {
        await downloadPrepared(
          { ...body, purpose: "handoff", workId: item.workId },
          controller.signal,
        );
        if (!active.current) break;
        update({ state: "delivered", selected: false });
      } catch (failure) {
        update({
          state: "failed",
          error: failure instanceof Error ? failure.message : "交接失败",
        });
      } finally {
        // Also refresh after a failed response: the server may already have delivered the first handoff.
        await refreshTypesetWork(item.workId);
      }
    }
    if (active.current) setBusy(false);
    abort.current = null;
  }

  if (!user.roles.includes("typesetter")) return null;
  return (
    <>
      <TypesetUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onStatus={setUploadProgress}
        onHandoff={(workId) => {
          setUploadProgress("");
          setItems([]);
          setOpen(true);
          void loadManifest(workId);
        }}
      />
      {open && (
        <dialog
          ref={dialog}
          aria-label="嵌字交接清单"
          className="workspace-business-dialog workspace-batch-dialog"
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else setOpen(false);
          }}
        >
          <header>
            <div>
              <h2>嵌字交接清单</h2>
              <p>包含本人全部嵌字待办，覆盖尚未加载的页面。</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="关闭下载清单"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </Button>
          </header>
          <p>
            确认取得交接包将开始嵌字，校对将不能普通取消提交。浏览器可能询问是否允许多文件下载；以下结果只表示已交付浏览器，不能确认已保存到本机。
          </p>
          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}
          <div className="workspace-batch-items">
            {!busy && !items.length && <p>暂无嵌字待办。</p>}
            {items.map((item) => (
              <div className="workspace-batch-item" key={item.workId}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.selected}
                    disabled={
                      busy || !item.canDownload || item.state === "delivered"
                    }
                    onChange={(event) =>
                      setItems((previous) =>
                        previous.map((row) =>
                          row.workId === item.workId
                            ? { ...row, selected: event.target.checked }
                            : row,
                        ),
                      )
                    }
                  />
                  <span>
                    <strong>
                      #{item.workNumber} · {item.title || "待定标题"}
                    </strong>
                    <small>
                      {item.imageCount} 张 · 版本 {item.workRevision} / 编辑周期{" "}
                      {item.editorEpoch}
                    </small>
                  </span>
                </label>
                <span>
                  {item.state === "delivered"
                    ? "已取得交接包，已交付浏览器下载"
                    : item.state === "running"
                      ? "正在取得交接包…"
                      : item.unavailableReason || item.error || "待确认"}
                </span>
                {(item.state === "failed" || item.state === "delivered") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void loadManifest(item.workId)}
                  >
                    重新预览此项
                  </Button>
                )}
                {item.state === "failed" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void runQueue([item])}
                  >
                    重试此项
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div className="workspace-dialog-actions">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void loadManifest()}
            >
              重新获取清单
            </Button>
            <Button
              loading={busy}
              disabled={
                !items.some(
                  (item) =>
                    item.selected &&
                    item.canDownload &&
                    item.state !== "delivered",
                )
              }
              onClick={() =>
                void runQueue(
                  items.filter(
                    (item) =>
                      item.selected &&
                      item.canDownload &&
                      item.state !== "delivered",
                  ),
                )
              }
            >
              确认交接并下载选中项
            </Button>
          </div>
        </dialog>
      )}
    </>
  );
}
