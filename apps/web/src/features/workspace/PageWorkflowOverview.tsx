import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Expand, X } from "lucide-react";
import type { components } from "@comiku/api-client";
import { Button, IconButton } from "../../components/ui";
import { ImageLightbox } from "../../components/ImageLightbox";
import { isDisplayableImageUrl } from "../../components/media-url";
import { SeriesImage } from "./SeriesImage";
import { useWorkImageUrl } from "./use-work-image-url";
import { useCandidateDialog } from "./use-candidate-dialog";
import { workPageAssignments } from "./page-workflow";
import "./page-workflow-dialog.css";

type Work = components["schemas"]["WorkDetailDto"];
type Selection = {
  ids: readonly string[];
  available: ReadonlySet<string>;
  toggle: (id: string) => void;
};
export function PageWorkflowDialog({
  work,
  stage,
  title,
  onClose,
  selection,
  busy = false,
  footer,
  children,
  toolbar,
}: {
  work: Work;
  stage: "translate" | "typeset";
  title: string;
  onClose: () => void;
  selection?: Selection;
  busy?: boolean;
  footer?: ReactNode;
  children?: ReactNode;
  toolbar?: ReactNode;
}) {
  const dialog = useCandidateDialog();
  const heading = useId();
  const [zoom, setZoom] = useState<number | null>(null);
  const active = zoom === null ? undefined : work.images[zoom];
  const original = useWorkImageUrl(work.id, active?.id, "original", !!active);
  const thumbnail = useWorkImageUrl(work.id, active?.id, "thumbnail", !!active);
  const assignments = new Map(
    workPageAssignments(work)
      .filter((p) => p.stage === stage)
      .map((p) => [p.workImageId, p]),
  );
  const people = new Map(work.participants.map((p) => [p.id, p.displayName]));
  const checked = new Set(selection?.ids);
  const activeCanSelect = !!active && !!selection?.available.has(active.id);
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-business-dialog page-workflow-dialog"
      aria-labelledby={heading}
      onCancel={(e) => {
        e.preventDefault();
        if (zoom !== null) setZoom(null);
        else if (!busy) onClose();
      }}
    >
      <header className="page-workflow-dialog__header">
        <h2 id={heading}>{title}</h2>
        <IconButton label="关闭分工窗口" disabled={busy} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      {toolbar && (
        <div className="page-workflow-dialog__toolbar">{toolbar}</div>
      )}
      <div className="page-workflow-dialog__body">
        <ol className="page-workflow-grid">
          {work.images.map((im, i) => {
            const a = assignments.get(im.id),
              owner = a?.participantId ? people.get(a.participantId) : null;
            const status = a ? (a.submittedAt ? "已提交" : "已认领") : "未分配";
            return (
              <li
                key={im.id}
                className={checked.has(im.id) ? "is-selected" : ""}
              >
                <button
                  type="button"
                  className="page-workflow-thumb"
                  aria-label={`放大第 ${i + 1} 页原图`}
                  onClick={() => setZoom(i)}
                >
                  <SeriesImage workId={work.id} imageId={im.id} />
                  <Expand size={15} aria-hidden="true" />
                </button>
                <div className="page-workflow-caption">
                  {selection && selection.available.has(im.id) ? (
                    <label>
                      <input
                        type="checkbox"
                        disabled={busy}
                        aria-label={`选择第 ${i + 1} 页`}
                        checked={checked.has(im.id)}
                        onChange={() => selection.toggle(im.id)}
                      />
                      第 {i + 1} 页
                    </label>
                  ) : (
                    <strong>第 {i + 1} 页</strong>
                  )}
                  <span>{owner ? `${owner} · ${status}` : status}</span>
                </div>
              </li>
            );
          })}
        </ol>
        {children}
      </div>
      {footer && (
        <footer className="page-workflow-dialog__footer">{footer}</footer>
      )}
      {active && zoom !== null && (
        <ImageLightbox
          portalContainer={dialog.current}
          src={
            isDisplayableImageUrl(original.data?.url)
              ? original.data.url
              : undefined
          }
          thumbnailSrc={
            isDisplayableImageUrl(thumbnail.data?.url)
              ? thumbnail.data.url
              : undefined
          }
          loading={original.isPending}
          alt={`第 ${zoom + 1} 页原图`}
          index={zoom}
          count={work.images.length}
          onPrevious={zoom > 0 ? () => setZoom(zoom - 1) : undefined}
          onNext={
            zoom < work.images.length - 1 ? () => setZoom(zoom + 1) : undefined
          }
          onClose={() => setZoom(null)}
          footer={
            selection && activeCanSelect ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => selection.toggle(active.id)}
              >
                {checked.has(active.id) ? "取消选择此页" : "选择此页"}
              </Button>
            ) : undefined
          }
        />
      )}
    </dialog>,
    document.body,
  );
}
