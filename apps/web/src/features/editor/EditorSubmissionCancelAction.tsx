import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui";

/** Keeps a valid upstream withdrawal secondary to the current stage's submit. */
export function EditorSubmissionCancelAction({
  label,
  secondary,
  disabled,
  onCancel,
}: {
  label: string;
  secondary: boolean;
  disabled: boolean;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusActionOnOpen = useRef(false);
  const panelId = useId();
  const focusTrigger = () =>
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();

  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const element = panel.current;
      if (!element) return;
      element.style.transform = "none";
      const bounds = element.getBoundingClientRect();
      const shift = Math.max(
        8 - bounds.left,
        Math.min(0, window.innerWidth - 8 - bounds.right),
      );
      element.style.transform = `translateX(${shift}px)`;
    }
    position();
    if (focusActionOnOpen.current) {
      panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
      focusActionOnOpen.current = false;
    }
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const cancelButton = (
    <Button
      size="sm"
      variant="secondary"
      leadingIcon={<RotateCcw size={15} />}
      disabled={disabled}
      onClick={() => {
        if (secondary) {
          focusTrigger();
          setOpen(false);
        }
        onCancel();
      }}
    >
      {label}
    </Button>
  );
  if (!secondary) return cancelButton;

  return (
    <div
      className="editor-submission-more"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          focusTrigger();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          focusActionOnOpen.current = true;
          setOpen(true);
          if (open)
            panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <Button
        size="sm"
        variant="secondary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        更多操作 <ChevronDown size={14} aria-hidden="true" />
      </Button>
      {open && (
        <div id={panelId} className="editor-submission-more__panel" ref={panel}>
          {cancelButton}
        </div>
      )}
    </div>
  );
}
