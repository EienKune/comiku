import { useState } from "react";
import { Link } from "react-router";
import { ExternalLink, X } from "lucide-react";
import { Button, IconButton } from "../../components/ui";
import { CandidateImportThumbnail } from "./CandidateImportMedia";
import { CandidateCompositionPreview } from "./CandidateCompositionPreview";
import {
  compositionSources,
  compositionMediaDetails,
  compositionUnadopted,
  type CompositionDraft,
} from "./candidate-composition-model";
import type { CompositionReceipt } from "./candidate-composition-api";
import type { CompositionPhase } from "./use-candidate-composition";
import { useCandidateDialog } from "./use-candidate-dialog";
import "./candidate-composition.css";

export function CandidateCompositionConfirmation({
  draft,
  phase,
  result,
  error,
  onConfirm,
  onLookup,
  onEdit,
  onClose,
}: {
  draft: CompositionDraft;
  phase: CompositionPhase;
  result?: CompositionReceipt;
  error?: string;
  onConfirm: () => void;
  onLookup: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const dialog = useCandidateDialog(),
    [preview, setPreview] = useState<{ id: string; ids: string[] } | null>(
      null,
    );
  const details = compositionMediaDetails(draft),
    unadopted = compositionUnadopted(draft),
    busy = phase === "submitting",
    uncertain = phase === "uncertain";
  const title =
    phase === "result"
      ? "已创建作品"
      : draft.mode === "merge"
        ? "确认合并入库"
        : `确认创建 ${draft.groups.length} 部作品`;
  const caption = (id: string) => {
    const detail = details.get(id);
    return detail
      ? `来源帖 ${detail.sourceIndex + 1} · 原图 ${detail.mediaIndex + 1}`
      : "来源图片";
  };
  function filmstrip(ids: string[], label: string) {
    return (
      <div className="candidate-composition-filmstrip">
        {ids.map((id, index) => {
          const detail = details.get(id);
          return (
            <button
              key={id}
              type="button"
              aria-label={`${label} ${caption(id)}`}
              onClick={() => setPreview({ id, ids: [...ids] })}
            >
              {detail && (
                <CandidateImportThumbnail
                  candidateId={detail.candidate.id}
                  mediaId={id}
                />
              )}
              <span>
                {label === "预览未采用"
                  ? caption(id)
                  : `第 ${index + 1} 页 · ${caption(id)}`}
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <dialog
      ref={dialog}
      className="candidate-import-dialog candidate-composition-confirmation"
      aria-label={title}
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
          <h2>{title}</h2>
          <p>
            {phase === "result"
              ? `${result?.works.length ?? 0} 部作品`
              : `${compositionSources(draft).length} 个来源帖 · ${draft.groups.flatMap((group) => group.mediaIds).length} 张采用`}
          </p>
        </div>
        <IconButton label="关闭拆合入库确认" disabled={busy} onClick={onClose}>
          <X size={21} />
        </IconButton>
      </header>
      <div className="candidate-import-dialog-scroll">
        {error && (
          <p className="candidate-image-editor-alert" role="alert">
            {error}
          </p>
        )}
        {uncertain && (
          <p className="candidate-image-editor-alert" role="status">
            尚未确认本次入库结果。查询或重试会保留相同的图片、分组、名称与操作标识，已创建的作品不会重复创建。
          </p>
        )}
        {phase === "result" && result ? (
          <div className="candidate-composition-results">
            {result.works.map((work) => (
              <Link
                key={work.workId}
                to={`/works/${work.workId}`}
                onClick={onClose}
              >
                <div>
                  <strong>
                    {work.title || `#${work.workNumber} · 待定标题`}
                  </strong>
                  <span>
                    #{work.workNumber} · {work.imageCount} 页 ·{" "}
                    {work.sourceCandidateIds.length} 个来源帖
                  </span>
                </div>
                <ExternalLink size={16} />
              </Link>
            ))}
          </div>
        ) : (
          <>
            <div className="candidate-composition-confirm-groups">
              {draft.groups.map((group, index) => (
                <section key={group.id}>
                  <h3>
                    {group.title.trim() || `作品 ${index + 1} · 待定标题`}
                  </h3>
                  {filmstrip(group.mediaIds, "预览入库")}
                </section>
              ))}
            </div>
            {unadopted.length > 0 && (
              <section className="candidate-composition-warning">
                <h3>
                  {unadopted.length} 张图片未
                  {draft.mode === "split" ? "分配" : "采用"}
                </h3>
                {filmstrip(unadopted, "预览未采用")}
                <p>
                  这些图片不进入任何作品，仍保留在来源记录中。确认后原帖完成处理，不再出现在待处理列表。
                </p>
              </section>
            )}
            {draft.excludedCandidateIds.length > 0 && (
              <p className="candidate-composition-source-note">
                已明确移出的 {draft.excludedCandidateIds.length}{" "}
                个来源帖保留待处理。
              </p>
            )}
          </>
        )}
      </div>
      <footer className="candidate-image-dialog-footer">
        {phase === "result" ? (
          <Button type="button" onClick={onClose}>
            返回候选池
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={uncertain ? onClose : onEdit}
            >
              {uncertain
                ? "返回候选池"
                : draft.mode === "split"
                  ? "返回分配"
                  : "返回调整"}
            </Button>
            <div>
              {uncertain && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={onLookup}
                >
                  查询本次结果
                </Button>
              )}
              <Button type="button" loading={busy} onClick={onConfirm}>
                {uncertain
                  ? "重试本次入库"
                  : draft.mode === "merge"
                    ? "确认合并入库"
                    : `确认创建 ${draft.groups.length} 部作品`}
              </Button>
            </div>
          </>
        )}
      </footer>
      {preview && (
        <CandidateCompositionPreview
          key={preview.id}
          draft={draft}
          ids={preview.ids}
          initialId={preview.id}
          portalContainer={dialog.current}
          onClose={() => setPreview(null)}
        />
      )}
    </dialog>
  );
}
