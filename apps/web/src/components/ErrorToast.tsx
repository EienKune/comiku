import { useCallback, useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import "./error-toast.css";

export function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
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
    if (!toast || !message) {
      hovered.current = false;
      return;
    }
    // A nonmodal top-layer popover remains visible above the author dialog.
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
  }, [message, pause, resume]);

  if (!message) return null;
  return (
    <div
      ref={ref}
      popover="manual"
      className="ui-error-toast"
      role="alert"
      onPointerEnter={() => {
        hovered.current = true;
        pause();
      }}
      onPointerLeave={() => {
        hovered.current = false;
        resume();
      }}
    >
      <TriangleAlert size={18} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
