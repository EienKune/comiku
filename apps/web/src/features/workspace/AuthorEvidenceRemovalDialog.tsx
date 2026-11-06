import { useEffect, useId, useRef } from "react";
import { Button } from "../../components/ui";
export function AuthorEvidenceRemovalDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const prior = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      element?.close();
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="candidate-discard-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={title}>移除这张授权凭证？</h2>
      <p>作者的授权状态保持不变。</p>
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      <footer>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={busy}
          onClick={onConfirm}
        >
          确认移除
        </Button>
      </footer>
    </dialog>
  );
}
