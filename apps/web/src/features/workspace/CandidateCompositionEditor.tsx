import { useRef, useState } from "react";
import {
  ChevronDown,
  Expand,
  ExternalLink,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button, IconButton, TextField } from "../../components/ui";
import { CandidateImportThumbnail } from "./CandidateImportMedia";
import { CandidateCompositionPreview } from "./CandidateCompositionPreview";
import {
  assignCompositionImages,
  compositionMedia,
  compositionMediaDetails,
  compositionProblem,
  compositionSources,
  compositionUnadopted,
  excludeCompositionSource,
  removeCompositionGroup,
  type CompositionDraft,
} from "./candidate-composition-model";
import { imageDragSnapshot, moveImage } from "./image-drag-model";
import { useImageDrag } from "./use-image-drag";
import { ImageOrderList } from "./ImageOrderList";
import { useCandidateDialog } from "./use-candidate-dialog";
import "./candidate-composition.css";

export function CandidateCompositionEditor({
  draft,
  onChange,
  onReview,
  onClose,
}: {
  draft: CompositionDraft;
  onChange: (change: (draft: CompositionDraft) => CompositionDraft) => void;
  onReview: () => void;
  onClose: () => void;
}) {
  const dialog = useCandidateDialog(),
    scroll = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [collapsed, setCollapsed] = useState(new Set<string>()),
    [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ id: string; ids: string[] } | null>(
    null,
  );
  const details = compositionMediaDetails(draft),
    groups = draft.groups,
    validIds = compositionMedia(draft),
    snapshot = imageDragSnapshot(groups, validIds, String(draft.version));
  const caption = (id: string) => {
    const detail = details.get(id);
    return detail
      ? `来源帖 ${detail.sourceIndex + 1} · 原图 ${detail.mediaIndex + 1}`
      : "来源图片";
  };
  const { drag, feedback } = useImageDrag({
    groups,
    validIds,
    snapshot,
    rootRef: dialog,
    scrollRef: scroll,
    caption,
    disabled: Boolean(preview),
    onDraggingChange: setDragging,
    onDrop: (id, target, slot, expected) =>
      onChange((current) => {
        const valid = compositionMedia(current);
        const next = moveImage(
          current.groups,
          id,
          target,
          slot,
          expected,
          valid,
          String(current.version),
        );
        return next === current.groups
          ? current
          : {
              ...current,
              version: current.version + 1,
              groups: next.map((group) => ({
                ...group,
                mediaIds: [...group.mediaIds],
              })),
            };
      }),
  });
  const problem = compositionProblem(draft),
    unadopted = compositionUnadopted(draft),
    adopted = groups.flatMap((group) => group.mediaIds);
  function assign(ids: string[], groupId: string | null) {
    onChange((current) => assignCompositionImages(current, ids, groupId));
    setSelected([]);
  }
  function addGroup() {
    const id = `work-${Math.max(0, ...draft.groups.map((group) => Number(group.id.replace("work-", "")) || 0)) + 1}`;
    onChange((current) => {
      if (current.groups.length >= 20) return current;
      const next = {
        ...current,
        version: current.version + 1,
        groups: [...current.groups, { id, title: "", mediaIds: [] }],
      };
      return selected.length
        ? assignCompositionImages(next, selected, id)
        : next;
    });
    setSelected([]);
  }
  function openPreview(id: string, ids: readonly string[]) {
    setPreview({ id, ids: [...ids] });
  }
  function thumbnail(id: string) {
    const detail = details.get(id);
    return detail ? (
      <CandidateImportThumbnail
        candidateId={detail.candidate.id}
        mediaId={id}
      />
    ) : null;
  }
  const title = draft.mode === "merge" ? "合并入库" : "拆分入库";
  return (
    <dialog
      ref={dialog}
      className="candidate-image-editor candidate-composition-editor"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (dragging) drag.cancel();
        else if (!preview) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !preview && !dragging)
          onClose();
      }}
    >
      <header className="candidate-image-dialog-header">
        <div>
          <h2>{title}</h2>
          <p>
            {draft.sources[0].candidate.authorName} · {draft.sources.length}{" "}
            个来源帖
          </p>
        </div>
        <IconButton
          label={`关闭${title}`}
          disabled={dragging}
          onClick={onClose}
        >
          <X size={21} />
        </IconButton>
      </header>
      <div className="candidate-image-editor-scroll" ref={scroll}>
        <div className="candidate-composition-grid">
          <section className="candidate-composition-originals">
            <div className="candidate-image-heading">
              <h3>原帖图片</h3>
              <span>
                {draft.mode === "split" && selected.length
                  ? `已选 ${selected.length} 张`
                  : `${details.size} 张`}
              </span>
            </div>
            {draft.sources.map((source, index) => {
              const candidate = source.candidate,
                excluded = draft.excludedCandidateIds.includes(source.id),
                empty = !candidate.media.some((media) =>
                  adopted.includes(media.id),
                );
              return (
                <section
                  className={`candidate-composition-source${excluded ? " is-removed" : ""}`}
                  key={source.id}
                >
                  <div className="candidate-composition-source-heading">
                    <strong>来源帖 {index + 1}</strong>
                    <time dateTime={candidate.postedAt}>
                      {new Date(candidate.postedAt).toLocaleDateString("zh-CN")}
                    </time>
                    {candidate.externalPostUrl && (
                      <a
                        href={candidate.externalPostUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        原帖 <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  {draft.mode === "merge" && (
                    <p className="candidate-composition-source-note">
                      {excluded
                        ? "已移出本次合并，保留待处理"
                        : source.draftVersion
                          ? "已带入图片草稿"
                          : "按原图顺序采用"}
                    </p>
                  )}
                  {draft.mode === "merge" && !excluded && empty && (
                    <div className="candidate-composition-warning">
                      <p>此帖没有采用图片</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={dragging}
                        onClick={() =>
                          onChange((current) =>
                            excludeCompositionSource(current, source.id, true),
                          )
                        }
                      >
                        移出本次合并并保留待处理
                      </Button>
                    </div>
                  )}
                  {excluded && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={dragging}
                      onClick={() =>
                        onChange((current) =>
                          excludeCompositionSource(current, source.id, false),
                        )
                      }
                    >
                      重新加入此帖
                    </Button>
                  )}
                  <div className="candidate-image-originals">
                    {candidate.media.map((media, mediaIndex) => {
                      const group = groups.find((group) =>
                        group.mediaIds.includes(media.id),
                      );
                      return (
                        <article
                          key={media.id}
                          onPointerDown={
                            excluded
                              ? undefined
                              : (event) => drag.start(event, media.id)
                          }
                          className={`candidate-original-tile ${group ? "is-adopted" : "is-excluded"}`}
                        >
                          <div className="candidate-original-picture">
                            <button
                              type="button"
                              data-image-drag-preview
                              aria-label={`预览 ${caption(media.id)}`}
                              onClick={() =>
                                openPreview(
                                  media.id,
                                  candidate.media.map((media) => media.id),
                                )
                              }
                            >
                              {thumbnail(media.id)}
                              <span className="candidate-original-expand">
                                <Expand size={16} />
                              </span>
                            </button>
                            <span className="candidate-original-number">
                              原图 {mediaIndex + 1}
                            </span>
                          </div>
                          <label>
                            <input
                              type="checkbox"
                              aria-label={`${draft.mode === "split" ? "选择" : "采用"} ${caption(media.id)}`}
                              disabled={excluded || dragging}
                              checked={
                                draft.mode === "split"
                                  ? selected.includes(media.id)
                                  : Boolean(group)
                              }
                              onChange={() =>
                                draft.mode === "split"
                                  ? setSelected((current) =>
                                      current.includes(media.id)
                                        ? current.filter(
                                            (id) => id !== media.id,
                                          )
                                        : [...current, media.id],
                                    )
                                  : assign(
                                      [media.id],
                                      group ? null : groups[0].id,
                                    )
                              }
                            />
                            <span>
                              {draft.mode === "split"
                                ? group
                                  ? `${group.title || `作品 ${groups.indexOf(group) + 1}`} · 第 ${group.mediaIds.indexOf(media.id) + 1} 页`
                                  : "未分配"
                                : group
                                  ? `作品第 ${group.mediaIds.indexOf(media.id) + 1} 页`
                                  : "不入库"}
                            </span>
                          </label>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </section>
          <section className="candidate-composition-groups">
            <div className="candidate-image-heading">
              <h3>{draft.mode === "split" ? "作品分组" : "入库页序"}</h3>
              {draft.mode === "split" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={dragging || groups.length >= 20}
                  leadingIcon={<Plus size={15} />}
                  onClick={addGroup}
                >
                  新建作品
                </Button>
              )}
            </div>
            {groups.map((group, index) => (
              <section
                key={group.id}
                className={`candidate-composition-group${drag.target?.groupId === group.id ? " is-drop-target" : ""}`}
                data-image-drag-group={group.id}
              >
                <TextField
                  label={
                    draft.mode === "split"
                      ? `作品 ${index + 1} 名称 *`
                      : "作品名称（可选）"
                  }
                  value={group.title}
                  maxLength={200}
                  disabled={dragging}
                  placeholder={
                    draft.mode === "split"
                      ? "填写作品名称"
                      : "可稍后在作品中修改"
                  }
                  onChange={(event) => {
                    const title = event.target.value;
                    onChange((current) => ({
                      ...current,
                      version: current.version + 1,
                      groups: current.groups.map((item) =>
                        item.id === group.id ? { ...item, title } : item,
                      ),
                    }));
                  }}
                />
                <div className="candidate-composition-group-heading">
                  <strong>
                    {draft.mode === "split"
                      ? `作品 ${index + 1} · ${group.mediaIds.length} 张`
                      : `${group.mediaIds.length} 页`}
                  </strong>
                  {draft.mode === "split" && (
                    <>
                      <div className="candidate-composition-group-actions">
                        {selected.length > 0 && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={dragging}
                            onClick={() => assign(selected, group.id)}
                          >
                            移入所选（{selected.length}）
                          </Button>
                        )}
                        <IconButton
                          size="sm"
                          label={`${collapsed.has(group.id) ? "展开" : "折叠"}作品 ${index + 1}`}
                          disabled={dragging}
                          onClick={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            })
                          }
                        >
                          <ChevronDown size={16} />
                        </IconButton>
                        <IconButton
                          size="sm"
                          label={`移除作品 ${index + 1}，图片回未分配`}
                          disabled={dragging}
                          onClick={() =>
                            onChange((current) =>
                              removeCompositionGroup(current, group.id),
                            )
                          }
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </>
                  )}
                </div>
                {!collapsed.has(group.id) && (
                  <ImageOrderList
                    groupId={group.id}
                    ids={group.mediaIds}
                    caption={caption}
                    renderThumbnail={thumbnail}
                    onPreview={(id) => openPreview(id, group.mediaIds)}
                    onChange={(ids) =>
                      onChange((current) => ({
                        ...current,
                        version: current.version + 1,
                        groups: current.groups.map((item) =>
                          item.id === group.id
                            ? { ...item, mediaIds: ids }
                            : item,
                        ),
                      }))
                    }
                    onRemove={(id) => assign([id], null)}
                    drag={drag}
                    label={`作品 ${index + 1} 页序`}
                  />
                )}
              </section>
            ))}
            {draft.mode === "split" && (
              <section
                className="candidate-composition-unassigned"
                aria-label="未分配"
              >
                <div className="candidate-image-heading">
                  <h3>未分配</h3>
                  <span>{unadopted.length} 张</span>
                  {selected.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={dragging}
                      onClick={() => assign(selected, null)}
                    >
                      移入所选（{selected.length}）
                    </Button>
                  )}
                </div>
                <div className="candidate-composition-filmstrip">
                  {unadopted.map((id) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={`预览未分配 ${caption(id)}`}
                      onClick={() => openPreview(id, unadopted)}
                    >
                      {thumbnail(id)}
                      <span>{caption(id)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </section>
        </div>
      </div>
      <footer className="candidate-image-dialog-footer">
        <div className="candidate-image-editor-summary">
          <strong>
            {draft.mode === "merge"
              ? `${compositionSources(draft).length} 帖 → 1 部作品`
              : `${groups.filter((group) => group.mediaIds.length).length} 部作品`}{" "}
            · 采用 {adopted.length} /{" "}
            {draft.mode === "split" ? "未分配" : "未采用"} {unadopted.length} 张
          </strong>
          {problem && <span role="status">{problem}</span>}
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
            disabled={dragging || Boolean(problem)}
            onClick={onReview}
          >
            {draft.mode === "merge"
              ? "合并为 1 部作品"
              : `创建 ${groups.filter((group) => group.mediaIds.length).length} 部作品`}
          </Button>
        </div>
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
      {feedback}
    </dialog>
  );
}
