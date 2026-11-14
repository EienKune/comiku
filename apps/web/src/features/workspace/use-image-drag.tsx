import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { GripVertical } from "lucide-react";
import type { ImageDragGroup } from "./image-drag-model";
import "./image-drag.css";
export type ImageDragTarget = {
  groupId: string;
  slot: number;
  before?: string;
  after?: string;
};
export type ImageDrag = {
  id: string | null;
  target: ImageDragTarget | null;
  start: (event: PointerEvent<HTMLElement>, id: string) => void;
  cancel: () => void;
};
type Session = {
  id: string;
  snapshot: string;
  pointerId: number;
  capture: HTMLElement;
  root: HTMLElement;
  scroll: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};
type Visual = {
  id: string;
  target: ImageDragTarget | null;
};
export function useImageDrag(options: {
  groups: readonly ImageDragGroup[];
  validIds: readonly string[];
  snapshot: string;
  rootRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  onDrop: (id: string, groupId: string, slot: number, snapshot: string) => void;
  caption: (id: string) => string;
  disabled?: boolean;
  onDraggingChange?: (dragging: boolean) => void;
}): { drag: ImageDrag; feedback: ReactNode } {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | null>(null),
    frame = useRef<number | undefined>(undefined);
  const feedbackElement = useRef<HTMLDivElement | null>(null),
    visualRef = useRef<Visual | null>(null);
  // Releasing capture on cancel can retarget the gesture's compatibility click
  // to the dialog/common ancestor, including its padding or backdrop. Bind the
  // token to the editor, and clear it on every new press so deliberate X and
  // checkbox clicks still work.
  const clickToken = useRef<{
    root: HTMLElement;
    pointerId: number;
    expires: number;
  } | null>(null);
  const [visual, setVisual] = useState<Visual | null>(null),
    [announcement, setAnnouncement] = useState("");
  function hit(current: Session): ImageDragTarget | null {
    const element = document.elementFromPoint(current.x, current.y);
    const group = element?.closest<HTMLElement>("[data-image-drag-group]");
    if (!group || !current.root.contains(group)) return null;
    const model = latest.current.groups.find(
      (item) => item.id === group.dataset.imageDragGroup,
    );
    if (!model) return null;
    const list = group.matches("[data-image-drag-list]")
      ? group
      : group.querySelector<HTMLElement>("[data-image-drag-list]");
    const rows = list
      ? [...list.querySelectorAll<HTMLElement>("[data-media-id]")].filter(
          (row) => row.dataset.mediaId !== current.id,
        )
      : [];
    const bounds = list?.getBoundingClientRect();
    const remaining = model.mediaIds.filter((id) => id !== current.id);
    const insideList =
      bounds && current.y >= bounds.top && current.y <= bounds.bottom;
    const slot = insideList
      ? rows.filter((row) => {
          const r = row.getBoundingClientRect();
          return current.y > r.top + r.height / 2;
        }).length
      : remaining.length;
    return {
      groupId: model.id,
      slot,
      before: insideList ? rows[slot]?.dataset.mediaId : undefined,
      after:
        slot === remaining.length ? rows.at(-1)?.dataset.mediaId : undefined,
    };
  }
  function positionFeedback(current: Session) {
    const element = feedbackElement.current;
    if (element) {
      const x = Math.max(12, Math.min(current.x + 14, window.innerWidth - 240)),
        y = Math.max(12, Math.min(current.y + 14, window.innerHeight - 48));
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }
  function show(current: Session) {
    const target = hit(current),
      previous = visualRef.current;
    // Pointer coordinates only move the floating DOM element. React owns the
    // active media and insertion marker, so an unchanged slot never rerenders
    // the editor's potentially thousands of source/order thumbnails.
    positionFeedback(current);
    if (
      previous &&
      previous.id === current.id &&
      previous.target?.groupId === target?.groupId &&
      previous.target?.slot === target?.slot &&
      previous.target?.before === target?.before &&
      previous.target?.after === target?.after
    )
      return;
    const next = { id: current.id, target };
    visualRef.current = next;
    setVisual(next);
  }
  function autoScroll() {
    const current = session.current;
    if (!current?.active) return;
    const bounds = current.scroll.getBoundingClientRect(),
      edge = 44;
    const inside =
      current.x >= bounds.left &&
      current.x <= bounds.right &&
      current.y >= bounds.top &&
      current.y <= bounds.bottom;
    const speed = !inside
      ? 0
      : current.y < bounds.top + edge
        ? -Math.min(12, (bounds.top + edge - current.y) / 3)
        : current.y > bounds.bottom - edge
          ? Math.min(12, (current.y - bounds.bottom + edge) / 3)
          : 0;
    if (speed) {
      const previous = current.scroll.scrollTop;
      current.scroll.scrollTop = Math.max(
        0,
        Math.min(
          current.scroll.scrollHeight - current.scroll.clientHeight,
          previous + speed,
        ),
      );
      if (current.scroll.scrollTop !== previous) show(current);
    }
    frame.current = requestAnimationFrame(autoScroll);
  }
  function finish(commit: boolean) {
    const current = session.current;
    if (!current) return;
    session.current = null;
    if (frame.current !== undefined) {
      cancelAnimationFrame(frame.current);
      frame.current = undefined;
    }
    if (current.capture.hasPointerCapture?.(current.pointerId))
      current.capture.releasePointerCapture(current.pointerId);
    // A cancelled press must not become a click even before the drag threshold.
    // Ordinary short presses still commit without suppressing their preview.
    if (current.active || !commit) {
      clickToken.current = {
        root: current.root,
        pointerId: current.pointerId,
        expires: commit ? performance.now() + 600 : Infinity,
      };
    }
    if (current.active) {
      const target = commit ? hit(current) : null;
      if (
        target &&
        current.snapshot === latest.current.snapshot &&
        !latest.current.disabled &&
        latest.current.validIds.includes(current.id)
      ) {
        latest.current.onDrop(
          current.id,
          target.groupId,
          target.slot,
          current.snapshot,
        );
        setAnnouncement(
          `${latest.current.caption(current.id)} 已移到第 ${target.slot + 1} 页`,
        );
      } else setAnnouncement("拖动已取消，图片归属和顺序未更改");
      latest.current.onDraggingChange?.(false);
    }
    visualRef.current = null;
    setVisual(null);
  }
  const actions = useRef({ finish, show, autoScroll });
  actions.current = { finish, show, autoScroll };
  useLayoutEffect(() => {
    if (
      session.current &&
      (session.current.snapshot !== options.snapshot || options.disabled)
    )
      actions.current.finish(false);
  }, [options.snapshot, options.disabled]);
  useEffect(() => {
    const down = () => {
      clickToken.current = null;
    };
    const move = (event: globalThis.PointerEvent) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (
        !current.active &&
        Math.hypot(current.x - current.startX, current.y - current.startY) >= 5
      ) {
        current.active = true;
        window.getSelection()?.removeAllRanges();
        latest.current.onDraggingChange?.(true);
        frame.current = requestAnimationFrame(() =>
          actions.current.autoScroll(),
        );
      }
      if (current.active) {
        event.preventDefault();
        actions.current.show(current);
      }
    };
    const up = (event: globalThis.PointerEvent) => {
      if (clickToken.current?.pointerId === event.pointerId)
        clickToken.current.expires = performance.now() + 600;
      const current = session.current;
      if (!current || current.pointerId !== event.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      actions.current.finish(true);
    };
    const cancel = () => actions.current.finish(false);
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (session.current?.pointerId === event.pointerId) cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && session.current) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const click = (event: MouseEvent) => {
      const token = clickToken.current;
      if (
        token &&
        event.detail > 0 &&
        performance.now() < token.expires &&
        event.target instanceof Node &&
        (token.root.contains(event.target) || event.target.contains(token.root))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clickToken.current = null;
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancelPointer, true);
    window.addEventListener("lostpointercapture", cancelPointer, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancelPointer, true);
      window.removeEventListener("lostpointercapture", cancelPointer, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("click", click, true);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      const current = session.current;
      session.current = null;
      if (current?.capture.hasPointerCapture?.(current.pointerId))
        current.capture.releasePointerCapture(current.pointerId);
    };
  }, []);
  function start(event: PointerEvent<HTMLElement>, id: string) {
    const element = event.target instanceof Element ? event.target : null;
    if (
      !element ||
      element.closest("input,select,textarea,a,label,[data-no-drag]")
    )
      return;
    const button = element.closest("button");
    if (
      button &&
      !button.matches("[data-image-drag-preview],[data-image-drag-grip]")
    )
      return;
    const { rootRef, scrollRef, disabled, validIds, snapshot } = latest.current,
      root = rootRef.current,
      scroll = scrollRef.current;
    if (
      disabled ||
      !event.isPrimary ||
      event.button !== 0 ||
      session.current ||
      !root ||
      !scroll ||
      !root.contains(event.currentTarget) ||
      !validIds.includes(id)
    )
      return;
    const capture = button ?? event.currentTarget;
    capture.setPointerCapture?.(event.pointerId);
    session.current = {
      id,
      snapshot,
      pointerId: event.pointerId,
      capture,
      root,
      scroll,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
  }
  const drag: ImageDrag = {
    id: visual?.id ?? null,
    target: visual?.target ?? null,
    start,
    cancel: () => finish(false),
  };
  return {
    drag,
    feedback: (
      <>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
        {visual && (
          <div
            ref={(element) => {
              feedbackElement.current = element;
              if (element && session.current) positionFeedback(session.current);
            }}
            className="image-drag-feedback"
            data-testid="image-drag-feedback"
            style={{ left: 0, top: 0 }}
          >
            <GripVertical size={16} />
            {options.caption(visual.id)}
          </div>
        )}
      </>
    ),
  };
}
