import { SeriesImportSelector } from "./WorkSeriesAssociation";
import type { SeriesImportIntent } from "./work-series-api";
import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button, IconButton } from "../../components/ui";
import {
  CandidateImportPreview,
  CandidateImportThumbnail,
} from "./CandidateImportMedia";
import type { CandidateImportEntry } from "./candidate-import-state";
import { useCandidateDialog } from "./use-candidate-dialog";
import "./candidate-image-editor.css";

export type CandidateImportResult = {
  id: string;
  outcome: string;
  message?: string | null;
  workId?: string | null;
};
export type CandidateImportPhase =
  "review" | "submitting" | "uncertain" | "result";
export function CandidateImportConfirmation({
  entries,
  phase,
  results,
  error,
  onEdit,
  seriesIntent = null,
  onSeriesIntentChange,
  onConfirm,
  onClose,
}: {
  entries: readonly CandidateImportEntry[];
  phase: CandidateImportPhase;
  results?: readonly CandidateImportResult[];
  error?: string | null;
  onEdit: (entry: CandidateImportEntry) => void;
  seriesIntent?: SeriesImportIntent | null;
  onSeriesIntentChange?: (value: SeriesImportIntent | null) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useCandidateDialog(),
    [preview, setPreview] = useState<{
      entry: CandidateImportEntry;
      id: string;
    } | null>(null);
  const changed = (entry: CandidateImportEntry) =>
    entry.mediaIds.length !== entry.candidate.media.length ||
    entry.mediaIds.some((id, index) => id !== entry.candidate.media[index]?.id);
  const [expanded, setExpanded] = useState(
    () => new Set(entries.filter(changed).map((entry) => entry.id)),
  );
  const total = entries.reduce((n, entry) => n + entry.mediaIds.length, 0),
    sourceTotal = entries.reduce(
      (n, entry) => n + entry.candidate.media.length,
      0,
    );
  const busy = phase === "submitting",
    frozen = busy || phase === "uncertain",
    resById = new Map(results?.map((result) => [result.id, result]));
  return (
    <dialog
      ref={dialog}
      className="candidate-import-dialog"
      aria-label="确认入库"
      onCancel={(event) => {
        event.preventDefault();
        if (!preview && !busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !preview && !busy)
          onClose();
      }}
    >
      <header className="candidate-image-dialog-header">
        <div>
          <h2>确认入库</h2>
          <p>每个帖子创建一部独立作品</p>
        </div>
        <IconButton label="关闭入库确认" disabled={busy} onClick={onClose}>
          <X size={21} />
        </IconButton>
      </header>
      <div className="candidate-import-dialog-scroll">
        <div className="candidate-import-totals">
          <div>
            <strong>{entries.length}</strong>
            <span>部作品</span>
          </div>
          <div>
            <strong>{total}</strong>
            <span>张入库</span>
          </div>
          <div>
            <strong>{sourceTotal - total}</strong>
            <span>张保留在来源</span>
          </div>
        </div>
        {error && (
          <p className="candidate-image-editor-alert" role="alert">
            {error}
          </p>
        )}
        {phase === "uncertain" && (
          <p className="candidate-image-editor-alert" role="status">
            尚未确认本次入库结果。重试会使用相同的图片与顺序，已完成的作品不会重复创建。
          </p>
        )}
        <div className="candidate-import-list">
          {entries.map((entry) => {
            const candidate = entry.candidate,
              result = resById.get(entry.id);
            return (
              <section className="candidate-import-row" key={entry.id}>
                <div className="candidate-import-row-header">
                  <CandidateImportThumbnail
                    candidateId={candidate.id}
                    mediaId={candidate.media[0].id}
                  />
                  <div className="candidate-import-identity">
                    <strong>{candidate.authorName}</strong>
                    <span>
                      {candidate.platform} ·{" "}
                      {candidate.authorHandle ?? candidate.externalPostId}
                    </span>
                  </div>
                  <div className="candidate-import-count">
                    <span>
                      入库 {entry.mediaIds.length} / {candidate.media.length} 张
                    </span>
                    {changed(entry) && (
                      <small>
                        {entry.mediaIds.length !== candidate.media.length
                          ? "部分图片入库"
                          : "已调整顺序"}
                      </small>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={frozen || phase === "result"}
                    onClick={() => onEdit(entry)}
                  >
                    调整
                  </Button>
                </div>
                <details
                  open={expanded.has(entry.id)}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setExpanded((current) => {
                      if (current.has(entry.id) === open) return current;
                      const next = new Set(current);
                      if (open) next.add(entry.id);
                      else next.delete(entry.id);
                      return next;
                    });
                  }}
                >
                  <summary>
                    {changed(entry)
                      ? "查看入库图片与页序"
                      : "全部入库 · 查看图片"}
                    <ChevronDown size={15} />
                  </summary>
                  {expanded.has(entry.id) && (
                    <div className="candidate-import-thumbs">
                      {entry.mediaIds.map((id, index) => (
                        <button
                          type="button"
                          key={id}
                          aria-label={`预览 ${candidate.authorName} 入库第 ${index + 1} 页`}
                          onClick={() => setPreview({ entry, id })}
                        >
                          <CandidateImportThumbnail
                            candidateId={candidate.id}
                            mediaId={id}
                          />
                          <span>
                            第 {index + 1} 页{" "}
                            <small>
                              ← 原图{" "}
                              {candidate.media.findIndex(
                                (media) => media.id === id,
                              ) + 1}
                            </small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </details>
                {result &&
                  !["succeeded", "unchanged"].includes(result.outcome) && (
                    <p className="candidate-import-item-result" role="alert">
                      {result.message ?? "此帖未完成，请重新检查后再入库。"}
                    </p>
                  )}
              </section>
            );
          })}
        </div>
        {entries.length === 1 && onSeriesIntentChange && (
          <SeriesImportSelector
            authorId={entries[0].candidate.authorId}
            value={seriesIntent}
            onChange={onSeriesIntentChange}
            disabled={frozen || phase === "result"}
          />
        )}
        <p className="candidate-import-note">
          其余图片不进入作品，原帖图片仍完整保留。
        </p>
      </div>
      <footer className="candidate-image-dialog-footer">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onClose}
        >
          {phase === "result" ? "返回检查未完成项" : "返回候选池"}
        </Button>
        {phase !== "result" && (
          <Button
            type="button"
            loading={busy}
            leadingIcon={<Check size={17} />}
            disabled={
              !entries.length ||
              Boolean(
                seriesIntent &&
                "createTitle" in seriesIntent &&
                !seriesIntent.createTitle.trim(),
              )
            }
            onClick={onConfirm}
          >
            {phase === "uncertain"
              ? "重试本次入库"
              : `确认创建 ${entries.length} 部作品`}
          </Button>
        )}
      </footer>
      {preview && (
        <CandidateImportPreview
          candidateId={preview.entry.candidate.id}
          mediaIds={preview.entry.mediaIds}
          sourceMediaIds={preview.entry.candidate.media.map(
            (media) => media.id,
          )}
          initialMediaId={preview.id}
          authorName={preview.entry.candidate.authorName}
          ordered
          portalContainer={dialog.current}
          onClose={() => setPreview(null)}
        />
      )}
    </dialog>
  );
}
