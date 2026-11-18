import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../components/ui";
import {
  captureShortcut,
  defaultEditorShortcuts,
  shortcutActions,
  shortcutLabel,
  validateEditorShortcuts,
  type EditorShortcuts,
} from "./editor-shortcuts";
import "./editor-shortcuts.css";

export function EditorShortcutDialog({
  bindings,
  notice,
  onSave,
  onClose,
  helpText = "聚焦下方按键框后按下新快捷键。仅在画布或标记列表聚焦时导航；工具键也可在工具栏使用。设置保存在当前账号的此浏览器。",
}: {
  bindings: EditorShortcuts;
  notice: string | null;
  onSave: (bindings: EditorShortcuts) => string | null;
  onClose: () => void;
  helpText?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const help = useId();
  const errorId = useId();
  const [draft, setDraft] = useState({ ...bindings });
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [status, setStatus] = useState(notice);
  const validation = validateEditorShortcuts(draft);
  const error = captureError ?? validation;

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      className="editor-shortcut-dialog"
      aria-labelledby={title}
      aria-describedby={help}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2 id={title}>快捷键设置</h2>
        <Button size="sm" variant="secondary" onClick={onClose}>
          关闭
        </Button>
      </header>
      <p id={help}>{helpText}</p>
      <div className="editor-shortcut-fields">
        {shortcutActions.map(({ id, label }) => (
          <label key={id}>
            <span>{label}</span>
            <input
              aria-label={`${label}快捷键`}
              value={shortcutLabel(draft[id])}
              readOnly
              aria-describedby={error ? errorId : help}
              aria-invalid={Boolean(validation)}
              onKeyDown={(event) => {
                if (
                  event.key === "Tab" ||
                  event.key === "Escape" ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                const captured = captureShortcut(event.nativeEvent);
                if (!captured) return;
                if ("error" in captured) {
                  setCaptureError(`${label}：${captured.error}`);
                  return;
                }
                setCaptureError(null);
                setStatus(null);
                setDraft((previous) => ({
                  ...previous,
                  [id]: captured.shortcut,
                }));
              }}
            />
          </label>
        ))}
      </div>
      <div className="editor-shortcut-feedback">
        {error && (
          <p id={errorId} role="alert">
            {error}
          </p>
        )}
        {status && <p role="status">{status}</p>}
      </div>
      <footer>
        <Button
          variant="secondary"
          onClick={() => {
            setDraft({ ...defaultEditorShortcuts });
            setCaptureError(null);
            setStatus(null);
          }}
        >
          恢复默认
        </Button>
        <Button
          disabled={Boolean(error)}
          onClick={() => {
            const result = onSave(draft);
            if (result) setStatus(result);
            else onClose();
          }}
        >
          保存快捷键
        </Button>
      </footer>
    </dialog>,
    document.body,
  );
}
