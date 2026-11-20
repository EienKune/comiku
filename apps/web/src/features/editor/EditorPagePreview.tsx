import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button, IconButton } from "../../components/ui";
import { SeriesImage } from "../workspace/SeriesImage";
import "../workspace/page-workflow-dialog.css";
import "./editor-page-preview.css";

export function EditorPagePreview({
  workId,
  images,
  currentIndex,
  onClose,
  onNavigate,
}: {
  workId: string;
  images: readonly { id: string }[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (index: number) => Promise<void>;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const heading = useId(),
    field = useId();
  const [page, setPage] = useState(String(currentIndex + 1));
  const [pending, setPending] = useState(false);
  const navigating = useRef(false);
  useEffect(() => {
    const dialog = panel.current!;
    const trigger = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const active = dialog.querySelector<HTMLButtonElement>(
      '[aria-current="page"]',
    );
    active?.focus({ preventScroll: true });
    active?.scrollIntoView?.({ block: "nearest" });
    return () => {
      if (typeof dialog.close === "function") dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  async function jump(index: number) {
    if (navigating.current || index < 0 || index >= images.length) return;
    navigating.current = true;
    setPending(true);
    try {
      if (index !== currentIndex) await onNavigate(index);
    } finally {
      onClose();
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const n = Number(page);
    if (Number.isInteger(n) && n >= 1 && n <= images.length) void jump(n - 1);
  }
  return createPortal(
    <dialog
      ref={panel}
      className="workspace-business-dialog page-workflow-dialog editor-page-preview"
      aria-labelledby={heading}
      onCancel={(e) => {
        e.preventDefault();
        if (!navigating.current) onClose();
      }}
    >
      <header className="page-workflow-dialog__header">
        <h2 id={heading}>页面预览</h2>
        <IconButton label="关闭页面预览" disabled={pending} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="page-workflow-dialog__body">
        <ol className="page-workflow-grid">
          {images.map((image, index) => (
            <li
              key={image.id}
              className={index === currentIndex ? "is-selected" : undefined}
            >
              <button
                type="button"
                className="editor-page-preview__page"
                aria-label={`第 ${index + 1} 页`}
                aria-current={index === currentIndex ? "page" : undefined}
                disabled={pending}
                onClick={() => void jump(index)}
              >
                <span className="page-workflow-thumb">
                  <SeriesImage workId={workId} imageId={image.id} />
                </span>
                <span className="editor-page-preview__caption">
                  <strong>第 {index + 1} 页</strong>
                  {index === currentIndex && <small>当前页</small>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <form
        className="page-workflow-dialog__footer editor-page-preview__jump"
        onSubmit={submit}
      >
        <label htmlFor={field}>页码</label>
        <input
          id={field}
          type="number"
          inputMode="numeric"
          required
          min={1}
          max={images.length}
          value={page}
          onChange={(e) => setPage(e.target.value)}
          aria-label={`跳转页码，共 ${images.length} 页`}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={
            pending ||
            !Number.isInteger(Number(page)) ||
            Number(page) < 1 ||
            Number(page) > images.length
          }
        >
          跳转
        </Button>
      </form>
    </dialog>,
    document.body,
  );
}
