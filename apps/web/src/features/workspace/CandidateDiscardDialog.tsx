import { useEffect, useId, useRef } from "react";
import { Button } from "../../components/ui";

export function CandidateDiscardDialog({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
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
  return (
    <dialog
      ref={dialog}
      className="candidate-discard-dialog"
      aria-labelledby={heading}
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <h2 id={heading}>忽略所选 {count} 个帖子？</h2>
      <p id={description}>将移到“已忽略”，可在那里批量恢复。</p>
      <footer>
        <Button type="button" variant="secondary" onClick={onCancel}>
          取消
        </Button>
        <Button type="button" variant="danger" onClick={onConfirm}>
          忽略 {count} 个帖子
        </Button>
      </footer>
    </dialog>
  );
}
