import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";
import "./confirmation-dialog.css";

export type Confirmation = {
  title: string;
  description: string;
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
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="ui-confirmation-dialog"
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
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const first = buttons[0];
        const last = buttons.at(-1);
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
      <footer>
        <Button
          type="button"
          variant="secondary"
          onClick={() => onClose(false)}
        >
          取消
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
