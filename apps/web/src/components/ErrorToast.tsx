import { useCallback, useEffect, useMemo, useRef } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import "./error-toast.css";

export type ToastNotice = {
  tone: "success" | "warning" | "error";
  message: string;
};

export function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const notice = useMemo<ToastNotice | null>(
    () => (message ? { tone: "error", message } : null),
    [message],
  );
  return <FeedbackToast notice={notice} onDismiss={onDismiss} />;
}

export function FeedbackToast({
  notice,
  onDismiss,
}: {
  notice: ToastNotice | null;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const hovered = useRef(false);
  const pause = useCallback(() => window.clearTimeout(timer.current), []);
  const resume = useCallback(() => {
    window.clearTimeout(timer.current);
    if (hovered.current) return;
    timer.current = window.setTimeout(onDismiss, 5000);
  }, [onDismiss]);

  useEffect(() => {
    const toast = ref.current;
    if (!toast || !notice) {
      hovered.current = false;
      return;
    }
    // A nonmodal popover keeps feedback visible above an open workflow dialog.
    toast.showPopover?.();
    resume();
    return () => {
      pause();
      if (
        toast.isConnected &&
        toast.hidePopover &&
        toast.matches(":popover-open")
      )
        toast.hidePopover();
    };
  }, [notice, pause, resume]);

  if (!notice) return null;
  const Icon = notice.tone === "success" ? CircleCheck : TriangleAlert;
  return (
    <div
      ref={ref}
      popover="manual"
      className="ui-feedback-toast"
      data-tone={notice.tone}
      role={notice.tone === "error" ? "alert" : "status"}
      onPointerEnter={() => {
        hovered.current = true;
        pause();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        resume();
      }}
    >
      <Icon size={18} aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}
