import {
  useId,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { GripVertical } from "lucide-react";
import { IconButton } from "../../components/ui";
import {
  useImageDrag,
  type ImageDragSemantics,
} from "../workspace/use-image-drag";
import "./marker-reorder.css";

const groupId = "translation-markers";
const semantics: ImageDragSemantics = {
  groupSelector: "[data-marker-reorder-list]",
  listSelector: "[data-marker-reorder-list]",
  itemSelector: "[data-marker-reorder-id]",
  groupId: () => groupId,
  itemId: (element) => element.dataset.markerReorderId,
  allowedButtonSelector: "[data-marker-reorder-grip]",
  feedbackClassName: "image-drag-feedback marker-reorder-feedback",
  feedbackTestId: "marker-reorder-feedback",
  announceDrop: (caption, slot) => `已请求将${caption}移到第 ${slot + 1} 条`,
  announceCancel: "拖动已取消，标记顺序未更改",
};

/** One mounted image/list, using stable marker IDs rather than display numbers.
 * Include work/image/epoch and access identity in scope; order is fenced here.
 * The parent performs its own current-scope and revision checks before saving.
 */
export function useMarkerReorder(options: {
  ids: readonly string[];
  scope: string;
  listRef: RefObject<HTMLElement | null>;
  disabled?: boolean;
  caption: (id: string) => string;
  onReorder: (id: string, beforeId: string | null) => void;
}) {
  const instructionId = useId();
  const latest = useRef(options);
  latest.current = options;
  const snapshot = JSON.stringify([
    options.scope,
    options.ids,
    !!options.disabled,
  ]);
  const dragActiveRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  function request(id: string, slot: number, expectedSnapshot: string) {
    const current = latest.current;
    const currentSnapshot = JSON.stringify([
      current.scope,
      current.ids,
      !!current.disabled,
    ]);
    if (
      current.disabled ||
      expectedSnapshot !== currentSnapshot ||
      !current.ids.includes(id)
    )
      return;
    const remaining = current.ids.filter((item) => item !== id);
    if (slot < 0 || slot > remaining.length) return;
    // Releasing in the original slot is a no-op, including a single-item list.
    if (current.ids.indexOf(id) === slot) return;
    current.onReorder(id, remaining[slot] ?? null);
  }

  const { drag, feedback } = useImageDrag({
    groups: [{ id: groupId, mediaIds: options.ids }],
    validIds: options.ids,
    snapshot,
    rootRef: options.listRef,
    scrollRef: options.listRef,
    disabled: options.disabled,
    caption: options.caption,
    semantics,
    onDrop: (id, _group, slot, expectedSnapshot) =>
      request(id, slot, expectedSnapshot),
    onDraggingChange: (active) => {
      dragActiveRef.current = active;
    },
  });

  function move(id: string, delta: -1 | 1) {
    const index = options.ids.indexOf(id);
    if (
      options.disabled ||
      dragActiveRef.current ||
      index < 0 ||
      index + delta < 0 ||
      index + delta >= options.ids.length
    )
      return;
    request(id, index + delta, snapshot);
    setAnnouncement(semantics.announceDrop(options.caption(id), index + delta));
  }

  return {
    dragActiveRef,
    listProps: {
      "data-marker-reorder-list": "",
      "data-marker-reorder-active": drag.id ? "true" : undefined,
    },
    rowProps: (id: string) => ({
      "data-marker-reorder-id": id,
      "data-marker-reorder-moving": drag.id === id ? "true" : undefined,
      "data-marker-reorder-before":
        drag.target?.before === id ? "true" : undefined,
      "data-marker-reorder-after":
        drag.target?.after === id ? "true" : undefined,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (
          target?.closest(
            '[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-no-drag]',
          )
        )
          return;
        drag.start(event, id);
      },
    }),
    controls: (id: string) => {
      const index = options.ids.indexOf(id);
      const caption = options.caption(id);
      const disabled = !!options.disabled || index < 0;
      return (
        <div className="marker-reorder-controls">
          <IconButton
            type="button"
            className="marker-reorder-grip"
            size="sm"
            label={`拖动${caption}调整顺序`}
            title="拖动调整顺序；也可按上下方向键；Escape 取消"
            aria-describedby={instructionId}
            data-marker-reorder-grip
            aria-disabled={disabled}
            onKeyDown={(event) => {
              if (
                event.isDefaultPrevented() ||
                event.nativeEvent.isComposing ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                (event.key !== "ArrowUp" && event.key !== "ArrowDown")
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              move(id, event.key === "ArrowUp" ? -1 : 1);
            }}
          >
            <GripVertical size={15} />
          </IconButton>
        </div>
      );
    },
    feedback: (
      <>
        <span className="sr-only" id={instructionId}>
          拖动调整顺序，或聚焦拖动按钮后按上下方向键移动。拖动时按 Escape 取消。
        </span>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
        {feedback}
      </>
    ),
  };
}
