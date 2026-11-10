import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { ArrowUp, ArrowDown, GripVertical, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui";
import { CandidateImportThumbnail } from "./CandidateImportMedia";

type DragSession = {
  id: string;
  handle: HTMLButtonElement;
  pointerId: number;
  startY: number;
  y: number;
  startScroll: number;
  rowTop: number;
  rowHeight: number;
  slot: number;
  active: boolean;
};
export function CandidateAdoptionOrder({
  candidateId,
  sourceIds,
  ids,
  onChange,
  onPreview,
  scrollContainer,
  onDraggingChange,
  disabled = false,
}: {
  candidateId: string;
  sourceIds: readonly string[];
  ids: readonly string[];
  onChange: (ids: string[]) => void;
  onPreview: (id: string) => void;
  scrollContainer: RefObject<HTMLDivElement | null>;
  onDraggingChange: (dragging: boolean) => void;
  disabled?: boolean;
}) {
  const list = useRef<HTMLOListElement>(null),
    session = useRef<DragSession | null>(null),
    frame = useRef<number | undefined>(undefined);
  const [drag, setDrag] = useState<{
      id: string;
      slot: number;
      offset: number;
    } | null>(null),
    [announcement, setAnnouncement] = useState("");
  const callbacks = useRef({ onChange, onDraggingChange, ids });
  callbacks.current = { onChange, onDraggingChange, ids };
  function updateTarget() {
    const current = session.current,
      root = list.current,
      scroll = scrollContainer.current;
    if (!current || !root || !scroll) return;
    const rows = [...root.children].filter(
      (row) => (row as HTMLElement).dataset.mediaId !== current.id,
    );
    current.slot = rows.filter((row) => {
      const r = row.getBoundingClientRect();
      return current.y > r.top + r.height / 2;
    }).length;
    const bounds = root.getBoundingClientRect(),
      rowTop = current.rowTop - (scroll.scrollTop - current.startScroll),
      desired = current.rowTop + current.y - current.startY;
    setDrag({
      id: current.id,
      slot: current.slot,
      offset:
        Math.max(
          bounds.top,
          Math.min(bounds.bottom - current.rowHeight, desired),
        ) - rowTop,
    });
  }
  function autoScroll() {
    const current = session.current,
      scroll = scrollContainer.current;
    if (!current?.active || !scroll) return;
    const r = scroll.getBoundingClientRect(),
      edge = 44;
    const speed =
      current.y < r.top + edge
        ? -Math.min(12, (r.top + edge - current.y) / 3)
        : current.y > r.bottom - edge
          ? Math.min(12, (current.y - r.bottom + edge) / 3)
          : 0;
    if (speed) {
      scroll.scrollTop += speed;
      updateTarget();
    }
    frame.current = requestAnimationFrame(autoScroll);
  }
  function finish(commit: boolean) {
    const current = session.current;
    if (!current) return;
    session.current = null;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    if (current.handle.hasPointerCapture?.(current.pointerId))
      current.handle.releasePointerCapture(current.pointerId);
    if (commit && current.active) {
      const next = callbacks.current.ids.filter((id) => id !== current.id);
      next.splice(current.slot, 0, current.id);
      callbacks.current.onChange(next);
      setAnnouncement(
        `原图 ${sourceIds.indexOf(current.id) + 1} 已移到第 ${current.slot + 1} 页`,
      );
    } else setAnnouncement("顺序未更改");
    callbacks.current.onDraggingChange(false);
    setDrag(null);
  }
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const cancel = () => finishRef.current(false);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, []);
  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (
      disabled ||
      !event.isPrimary ||
      event.button !== 0 ||
      ids.length < 2 ||
      session.current ||
      !scrollContainer.current
    )
      return;
    event.preventDefault();
    const handle = event.currentTarget,
      row = handle.closest("li")!.getBoundingClientRect();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    session.current = {
      id,
      handle,
      pointerId: event.pointerId,
      startY: event.clientY,
      y: event.clientY,
      startScroll: scrollContainer.current.scrollTop,
      rowTop: row.top,
      rowHeight: row.height,
      slot: ids.indexOf(id),
      active: false,
    };
    callbacks.current.onDraggingChange(true);
  }
  function movePointer(event: PointerEvent<HTMLButtonElement>) {
    const current = session.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.y = event.clientY;
    if (!current.active && Math.abs(current.y - current.startY) >= 5) {
      current.active = true;
      frame.current = requestAnimationFrame(autoScroll);
    }
    if (current.active) {
      event.preventDefault();
      updateTarget();
    }
  }
  function move(index: number, delta: number) {
    const next = [...ids];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
    setAnnouncement(
      `原图 ${sourceIds.indexOf(ids[index]) + 1} 已移到第 ${index + delta + 1} 页`,
    );
  }
  const remaining = drag ? ids.filter((id) => id !== drag.id) : [];
  return (
    <aside className="candidate-adoption-order">
      <div className="candidate-image-heading">
        <h3>入库顺序</h3>
        <span>{ids.length} 张</span>
      </div>
      <p className="candidate-image-hint">拖动排序 · 点击图片预览</p>
      {ids.length ? (
        <ol ref={list} className={drag ? "is-sorting" : ""}>
          {ids.map((id, index) => {
            const original = sourceIds.indexOf(id) + 1,
              moving = drag?.id === id,
              before = drag && drag.id !== id && remaining[drag.slot] === id,
              after =
                drag &&
                drag.slot === remaining.length &&
                remaining.at(-1) === id;
            return (
              <li
                key={id}
                data-media-id={id}
                className={`${moving ? "order-moving" : ""} ${before ? "order-drop-before" : ""} ${after ? "order-drop-after" : ""}`}
                style={
                  moving
                    ? { transform: `translateY(${drag.offset}px)` }
                    : undefined
                }
              >
                <button
                  type="button"
                  className="candidate-drag-handle"
                  disabled={disabled || ids.length < 2}
                  aria-label={`拖动原图 ${original} 调整顺序`}
                  title="拖动，或按上下方向键调整"
                  onPointerDown={(e) => start(e, id)}
                  onPointerMove={movePointer}
                  onPointerUp={(e) => {
                    if (session.current?.pointerId === e.pointerId)
                      finish(true);
                  }}
                  onPointerCancel={() => finish(false)}
                  onLostPointerCapture={() => finish(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && session.current) {
                      e.preventDefault();
                      e.stopPropagation();
                      finish(false);
                    } else if (
                      !session.current &&
                      !disabled &&
                      ((e.key === "ArrowUp" && index > 0) ||
                        (e.key === "ArrowDown" && index < ids.length - 1))
                    ) {
                      e.preventDefault();
                      move(index, e.key === "ArrowUp" ? -1 : 1);
                    }
                  }}
                >
                  <GripVertical size={16} />
                </button>
                <span className="candidate-order-number">{index + 1}</span>
                <button
                  type="button"
                  className="candidate-order-preview-button"
                  disabled={disabled || !!drag}
                  aria-label={`预览入库第 ${index + 1} 页，原图 ${original}`}
                  onClick={() => onPreview(id)}
                >
                  <CandidateImportThumbnail
                    candidateId={candidateId}
                    mediaId={id}
                  />
                  <span>原图 {original}</span>
                </button>
                <div className="candidate-order-nudge">
                  <button
                    type="button"
                    aria-label={`上移原图 ${original}`}
                    disabled={disabled || !!drag || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`下移原图 ${original}`}
                    disabled={disabled || !!drag || index === ids.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="candidate-image-warning">至少选入一张图片</p>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        leadingIcon={<RotateCcw size={14} />}
        disabled={disabled || !!drag || ids.length < 2}
        onClick={() => onChange(sourceIds.filter((id) => ids.includes(id)))}
      >
        恢复原帖顺序
      </Button>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </aside>
  );
}
