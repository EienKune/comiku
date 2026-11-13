import { useState, type ReactNode } from "react";
import { GripVertical, X } from "lucide-react";
import type { ImageDrag } from "./use-image-drag";
import "./image-drag.css";

export function ImageOrderList({
  groupId,
  ids,
  caption,
  renderThumbnail,
  onPreview,
  onChange,
  onRemove,
  drag,
  disabled = false,
  label,
  previewLabel,
}: {
  groupId: string;
  ids: readonly string[];
  caption: (id: string) => string;
  renderThumbnail: (id: string) => ReactNode;
  onPreview: (id: string) => void;
  onChange: (ids: string[]) => void;
  onRemove?: (id: string) => void;
  drag: ImageDrag;
  disabled?: boolean;
  label?: string;
  previewLabel?: (id: string, index: number) => string;
}) {
  const [announcement, setAnnouncement] = useState("");
  const target = drag.target?.groupId === groupId ? drag.target : null;
  return (
    <>
      <ol
        className={`image-order-list ${drag.id ? "is-sorting" : ""} ${target ? "is-drop-target" : ""}`}
        data-image-drag-group={groupId}
        data-image-drag-list
        aria-label={label ?? "图片页序"}
      >
        {ids.map((id, index) => (
          <li
            key={id}
            data-media-id={id}
            onPointerDown={(event) => {
              if (!disabled) drag.start(event, id);
            }}
            onDragStart={(event) => event.preventDefault()}
            className={`image-order-item ${drag.id === id ? "order-moving" : ""} ${target?.before === id ? "order-drop-before" : ""} ${target?.after === id ? "order-drop-after" : ""}`}
          >
            <button
              type="button"
              className="candidate-drag-handle"
              data-image-drag-grip
              disabled={disabled}
              aria-label={`拖动 ${caption(id)} 调整顺序`}
              title="拖动，或按上下方向键调整；Escape 取消拖动"
              onKeyDown={(event) => {
                const delta =
                  event.key === "ArrowUp"
                    ? -1
                    : event.key === "ArrowDown"
                      ? 1
                      : 0;
                if (!delta || disabled || drag.id) return;
                event.preventDefault();
                if (index + delta < 0 || index + delta >= ids.length) return;
                const next = [...ids];
                [next[index], next[index + delta]] = [
                  next[index + delta],
                  next[index],
                ];
                onChange(next);
                setAnnouncement(
                  `${caption(id)} 已移到第 ${index + delta + 1} 页`,
                );
              }}
            >
              <GripVertical size={17} />
            </button>
            <span className="candidate-order-number">{index + 1}</span>
            <button
              type="button"
              className="candidate-order-preview-button"
              data-image-drag-preview
              aria-label={
                previewLabel?.(id, index) ??
                `预览第 ${index + 1} 页，${caption(id)}`
              }
              onClick={() => onPreview(id)}
            >
              {renderThumbnail(id)}
              <span>{caption(id)}</span>
            </button>
            {onRemove && (
              <button
                type="button"
                className="image-order-remove"
                disabled={disabled}
                aria-label={`移出 ${caption(id)}`}
                onClick={() => onRemove(id)}
              >
                <X size={15} />
              </button>
            )}
          </li>
        ))}
        {!ids.length && <li className="image-order-empty">从原图拖入图片</li>}
      </ol>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
