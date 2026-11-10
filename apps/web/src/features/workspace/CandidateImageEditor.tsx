import { useRef, useState } from "react";
import { Expand, X } from "lucide-react";
import type { components } from "@comiku/api-client";
import { Button, IconButton } from "../../components/ui";
import { CandidateAdoptionOrder } from "./CandidateAdoptionOrder";
import {
  CandidateImportPreview,
  CandidateImportThumbnail,
} from "./CandidateImportMedia";
import {
  candidateImageDraft,
  candidateImageDraftConflict,
  validateCandidateImageIds,
  type CandidateImageDraft,
} from "./candidate-image-drafts";
import { useCandidateDialog } from "./use-candidate-dialog";
import "./candidate-image-editor.css";

export function CandidateImageEditor({
  candidate,
  draft,
  selectionRevision,
  onApply,
  onClose,
  onResetSource,
  reloading = false,
  error,
}: {
  candidate: components["schemas"]["CandidateDto"];
  draft?: CandidateImageDraft;
  selectionRevision?: number;
  onApply: (ids: string[]) => void;
  onClose: () => void;
  onResetSource: () => void;
  reloading?: boolean;
  error?: string | null;
}) {
  const baseline = candidateImageDraft(draft, candidate),
    [ids, setIds] = useState([...baseline.mediaIds]);
  const [preview, setPreview] = useState<{
      id: string;
      ordered: boolean;
      sequence: string[];
    } | null>(null),
    [dragging, setDragging] = useState(false);
  const dialog = useCandidateDialog(),
    scroll = useRef<HTMLDivElement>(null);
  const sourceIds = candidate.media.map((media) => media.id),
    conflict =
      candidate.status !== "pending" ||
      candidateImageDraftConflict(baseline, candidate) ||
      (selectionRevision !== undefined &&
        selectionRevision !== candidate.revision);
  const disabled = reloading || conflict;
  function openPreview(id: string, ordered: boolean) {
    setPreview({ id, ordered, sequence: ordered ? [...ids] : sourceIds });
  }
  return (
    <dialog
      ref={dialog}
      className="candidate-image-editor"
      aria-label="整理入库图片"
      onCancel={(event) => {
        event.preventDefault();
        if (!preview && !dragging) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !preview && !dragging)
          onClose();
      }}
    >
      <header className="candidate-image-dialog-header">
        <div>
          <h2>整理入库图片</h2>
          <p>
            {candidate.authorName} · 原帖 {sourceIds.length} 张
          </p>
        </div>
        <IconButton label="关闭整理图片" disabled={dragging} onClick={onClose}>
          <X size={21} />
        </IconButton>
      </header>
      <div className="candidate-image-editor-scroll" ref={scroll}>
        {(conflict || error) && (
          <div className="candidate-image-editor-alert" role="alert">
            <p>{error ?? "帖子图片或版本已变化，当前调整仍保留。"}</p>
            <Button
              size="sm"
              variant="secondary"
              disabled={reloading}
              onClick={onResetSource}
            >
              放弃调整并加载最新图片
            </Button>
          </div>
        )}
        <div className="candidate-image-editor-grid">
          <section>
            <div className="candidate-image-heading">
              <h3>原帖图片</h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || dragging}
                onClick={() =>
                  setIds((current) => [
                    ...current,
                    ...sourceIds.filter((id) => !current.includes(id)),
                  ])
                }
              >
                恢复全选
              </Button>
            </div>
            <div className="candidate-image-originals">
              {candidate.media.map((media, index) => (
                <article
                  key={media.id}
                  className={`candidate-original-tile ${ids.includes(media.id) ? "is-adopted" : "is-excluded"}`}
                >
                  <div className="candidate-original-picture">
                    <button
                      type="button"
                      aria-label={`查看原图 ${index + 1} 大图`}
                      disabled={dragging}
                      onClick={() => openPreview(media.id, false)}
                    >
                      <CandidateImportThumbnail
                        candidateId={candidate.id}
                        mediaId={media.id}
                      />
                      <span className="candidate-original-expand">
                        <Expand size={16} />
                      </span>
                    </button>
                    <span className="candidate-original-number">
                      原图 {index + 1}
                    </span>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`选入原图 ${index + 1}`}
                      disabled={disabled || dragging}
                      checked={ids.includes(media.id)}
                      onChange={() =>
                        setIds((current) =>
                          current.includes(media.id)
                            ? current.filter((id) => id !== media.id)
                            : [...current, media.id],
                        )
                      }
                    />
                    <span>{ids.includes(media.id) ? "选入" : "不入库"}</span>
                    {ids.includes(media.id) && (
                      <small>作品第 {ids.indexOf(media.id) + 1} 页</small>
                    )}
                  </label>
                </article>
              ))}
            </div>
          </section>
          <CandidateAdoptionOrder
            candidateId={candidate.id}
            sourceIds={sourceIds}
            ids={ids}
            onChange={setIds}
            onPreview={(id) => openPreview(id, true)}
            scrollContainer={scroll}
            onDraggingChange={setDragging}
            disabled={disabled}
          />
        </div>
      </div>
      <footer className="candidate-image-dialog-footer">
        <div className="candidate-image-editor-summary">
          <strong>
            入库图片 {ids.length} / {sourceIds.length} 张
          </strong>
          <span>其余图片保留在来源记录中</span>
        </div>
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={dragging}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={
              disabled || dragging || !validateCandidateImageIds(ids, sourceIds)
            }
            onClick={() => onApply([...ids])}
          >
            应用调整
          </Button>
        </div>
      </footer>
      {preview && (
        <CandidateImportPreview
          key={`${candidate.id}:${preview.id}`}
          candidateId={candidate.id}
          mediaIds={preview.sequence}
          sourceMediaIds={sourceIds}
          initialMediaId={preview.id}
          authorName={candidate.authorName}
          ordered={preview.ordered}
          portalContainer={dialog.current}
          onClose={() => setPreview(null)}
        />
      )}
    </dialog>
  );
}
