import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";
import "./confirmation-dialog.css";

export type Confirmation = {
  title: string;
  description: string;
  details?: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  danger?: boolean;
};

export function ConfirmationDialog({
  options,
  onClose,
}: {
  options: Confirmation;
  onClose: (approved: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>("footer button")?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className={`ui-confirmation-dialog${options.details ? " ui-confirmation-dialog--with-details" : ""}`}
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault();
        onClose(false);
      }}
      onClose={(event) => {
        // StrictMode cleanup queues a native close event before reopening.
        if (!event.currentTarget.open) onClose(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            '[tabindex="0"], button:not(:disabled)',
          ),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <h2 id={title}>{options.title}</h2>
      <p id={description}>{options.description}</p>
      {options.details && (
        <div className="ui-confirmation-details">{options.details}</div>
      )}
      <footer>
        <Button
          type="button"
          variant="secondary"
          onClick={() => onClose(false)}
        >
          {options.cancelLabel ?? "取消"}
        </Button>
        <Button
          type="button"
          variant={options.danger ? "danger" : "primary"}
          onClick={() => onClose(true)}
        >
          {options.confirmLabel}
        </Button>
      </footer>
    </dialog>,
    document.body,
  );
}
