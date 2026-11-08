import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { components } from "@comiku/api-client";
import { Button } from "../../components/ui";
import { client, unwrap } from "../account/api";
import "./source-sync.css";

type Progress = components["schemas"]["SourceFetchProgressDto"];
type Snapshot = components["schemas"]["SourceFetchProgressSnapshotDto"];
const progressKey = ["source-fetch", "progress"] as const;
const statusLabels: Record<Snapshot["status"], string> = {
  queued: "已排队",
  running: "同步中",
  succeeded: "已完成",
  partial_failed: "部分失败",
  failed: "未完成",
};
const when = (value: string) => new Date(value).toLocaleString();

export function SourceSyncControl({
  onCompleted,
}: {
  onCompleted?: () => void | Promise<void>;
}) {
  const cache = useQueryClient();
  const progress = useQuery({
    queryKey: progressKey,
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/source-fetch/progress", { signal })),
    refetchInterval: (query) => (query.state.data?.active ? 2_000 : 15_000),
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  const active = progress.data?.active ?? null;
  const lastManual = progress.data?.lastManual ?? null;
  const previousActive = useRef<string | null>(null);
  const notified = useRef<string | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const anchor = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const tooltipId = useId();
  const disabled =
    Boolean(active) ||
    busy ||
    progress.isPending ||
    progress.isError ||
    !progress.data;

  const notifyCompleted = useCallback(
    (id: string) => {
      if (notified.current === id) return;
      notified.current = id;
      void cache.invalidateQueries({ queryKey: ["candidates"] });
      if (onCompleted)
        void Promise.resolve()
          .then(onCompleted)
          .catch(() => undefined);
    },
    [cache, onCompleted],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!progress.data) return;
    const previous = previousActive.current;
    previousActive.current = active?.id ?? null;
    if (previous && previous !== active?.id) notifyCompleted(previous);
  }, [progress.data, active?.id, notifyCompleted]);

  function show() {
    if (!open) {
      setPosition(null);
      setOpen(true);
    }
  }
  function dismiss() {
    setOpen(false);
    setPosition(null);
  }
  function inspect() {
    show();
    if (progress.isError) void progress.refetch({ cancelRefetch: false });
  }
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tooltip.current) return;
    const trigger = anchor.current.getBoundingClientRect();
    const box = tooltip.current.getBoundingClientRect();
    const margin = 16,
      gap = 8;
    const below = trigger.bottom + gap;
    setPosition({
      left: Math.max(
        margin,
        Math.min(
          trigger.right - box.width,
          window.innerWidth - box.width - margin,
        ),
      ),
      top: Math.max(
        margin,
        Math.min(
          below + box.height <= window.innerHeight - margin
            ? below
            : trigger.top - box.height - gap,
          window.innerHeight - box.height - margin,
        ),
      ),
    });
  }, [open, progress.data, progress.isError, progress.isPending, submitError]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target)
      )
        dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const hide = () => dismiss();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open]);

  async function synchronize() {
    if (
      submitting.current ||
      active ||
      progress.isPending ||
      progress.isError ||
      !progress.data
    )
      return;
    submitting.current = true;
    setBusy(true);
    setSubmitError("");
    let submittedId: string | undefined;
    let failure = "";
    try {
      const run = await unwrap(
        await client.POST("/api/source-fetch/runs", { body: {} }),
      );
      submittedId = run.id;
    } catch (error) {
      failure =
        error instanceof Error ? error.message : "同步请求未完成，请稍后重试";
    } finally {
      // A status read started before POST must not overwrite the committed batch.
      await cache.cancelQueries({ queryKey: progressKey, exact: true });
      await cache.invalidateQueries({ queryKey: progressKey, exact: true });
      const current = cache.getQueryData<Progress>(progressKey);
      if (submittedId && !current?.active) notifyCompleted(submittedId);
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        setSubmitError(failure);
        if (failure) show();
      }
    }
  }

  function summary(run: Snapshot, title: string) {
    return (
      <div className="source-sync-summary">
        <strong>
          {title} ·{" "}
          {run.waitingReason === "credential_unavailable"
            ? "等待凭据复验"
            : run.waitingReason === "platform_cooldown"
              ? "等待平台冷却"
              : run.waitingReason
                ? "等待执行空位"
                : run.nextRetryAt
                  ? "等待重试"
                  : statusLabels[run.status]}
        </strong>
        <time dateTime={run.completedAt ?? run.startedAt}>
          {when(run.completedAt ?? run.startedAt)}
        </time>
        <p>
          {run.targetCount !== undefined && (
            <>
              账号 {run.completedTargets ?? 0}/{run.targetCount} ·{" "}
            </>
          )}
          已读取 {run.pagesFetched} 页 · 新增 {run.candidatesCreated} 项候选 ·
          原图 {run.mediaStored} 张
        </p>
        {run.nextRetryAt && <p>下次重试 {when(run.nextRetryAt)}</p>}
      </div>
    );
  }
  return (
    <div
      className="source-sync-control"
      ref={anchor}
      role="group"
      aria-label="图源同步"
      aria-describedby={open ? tooltipId : undefined}
      tabIndex={disabled ? 0 : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch" && !event.buttons) inspect();
      }}
      onPointerLeave={dismiss}
      onFocus={inspect}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) dismiss();
      }}
    >
      <Button
        variant="secondary"
        leadingIcon={
          <RefreshCw
            size={16}
            className={active && !active.waitingReason ? "ui-spin" : undefined}
          />
        }
        loading={busy}
        disabled={disabled}
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => void synchronize()}
      >
        同步图源
      </Button>
      {open &&
        createPortal(
          <div
            id={tooltipId}
            ref={tooltip}
            role="tooltip"
            className="ui-marker-tooltip source-sync-tooltip"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {progress.isPending && <p>正在读取同步状态…</p>}
            {progress.isError && (
              <p role="alert">同步状态读取失败，请稍后再试</p>
            )}
            {submitError && <p role="alert">{submitError}</p>}
            {active &&
              summary(
                active,
                active.trigger === "manual" ? "手动同步" : "定时同步",
              )}
            {lastManual &&
              lastManual.id !== active?.id &&
              summary(
                lastManual,
                ["queued", "running"].includes(lastManual.status)
                  ? "最近手动同步"
                  : "上次手动同步",
              )}
            {!progress.isPending &&
              !progress.isError &&
              !active &&
              !lastManual && <p>暂无手动同步记录</p>}
          </div>,
          document.body,
        )}
    </div>
  );
}
