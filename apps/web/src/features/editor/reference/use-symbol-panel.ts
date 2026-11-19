import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";

const margin = 12;
const gap = 8;
type Position = { left: number; top: number; maxHeight: number };
const clamp = (value: number, maximum: number) =>
  Math.max(margin, Math.min(value, maximum));

export function symbolPanelPosition(
  anchor: Pick<DOMRect, "right" | "top" | "bottom">,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): Position {
  const below = Math.max(0, viewport.height - margin - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - margin);
  const usable = Math.min(panel.height, 180);
  const useBelow = below >= usable || below >= above;
  // In a very short viewport, use all available height so the header remains reachable.
  const room = useBelow ? below : above;
  const maxHeight =
    room >= 140 ? room : Math.max(0, viewport.height - margin * 2);
  const height = Math.min(panel.height, maxHeight);
  return {
    left: clamp(
      anchor.right - panel.width,
      viewport.width - panel.width - margin,
    ),
    top: clamp(
      useBelow ? anchor.bottom + gap : anchor.top - gap - height,
      viewport.height - height - margin,
    ),
    maxHeight,
  };
}

export function useSymbolPanel(
  open: boolean,
  opener: RefObject<HTMLDivElement | null>,
) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const updatePosition = useCallback((next: Position) => {
    setPosition((previous) =>
      previous?.left === next.left &&
      previous.top === next.top &&
      previous.maxHeight === next.maxHeight
        ? previous
        : next,
    );
  }, []);
  const dragged = useRef(false);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      drag.current = null;
      dragged.current = false;
      return;
    }
    const node = panel.current;
    const button =
      opener.current?.querySelector<HTMLButtonElement>("[aria-controls]");
    if (!node || !button) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (dragged.current) {
        updatePosition({
          left: clamp(rect.left, window.innerWidth - rect.width - margin),
          top: clamp(rect.top, window.innerHeight - rect.height - margin),
          maxHeight: Math.max(0, window.innerHeight - margin * 2),
        });
      } else {
        const grid = node.querySelector<HTMLElement>(".editor-symbol-buttons");
        const height =
          rect.height + (grid ? grid.scrollHeight - grid.clientHeight : 0);
        updatePosition(
          symbolPanelPosition(
            button.getBoundingClientRect(),
            { width: rect.width, height },
            { width: window.innerWidth, height: window.innerHeight },
          ),
        );
      }
    };
    update();
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(node);
    const scroll = (event: Event) => {
      if (
        event.target !== event.currentTarget &&
        !(event.currentTarget === window && event.target === document)
      )
        return;
      if (!dragged.current) update();
    };
    window.addEventListener("resize", update);
    // Scroll does not bubble: only listen to the opener's own ancestors and viewport.
    // Sibling entry-list and palette-grid scrolling never measure or rerender the panel.
    const ancestors: Element[] = [];
    for (
      let ancestor = button.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      ancestors.push(ancestor);
      ancestor.addEventListener("scroll", scroll);
    }
    window.addEventListener("scroll", scroll);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", scroll);
      ancestors.forEach((ancestor) =>
        ancestor.removeEventListener("scroll", scroll),
      );
    };
  }, [open, opener, updatePosition]);

  function start(event: PointerEvent<HTMLElement>) {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      (event.target instanceof Element &&
        event.target.closest("button, input, textarea, select, a"))
    )
      return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    // Keep the current textarea selection and do not start native text selection.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = true;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const saved = drag.current;
    const rect = panel.current?.getBoundingClientRect();
    if (!saved || saved.id !== event.pointerId || !rect) return;
    event.preventDefault();
    updatePosition({
      left: clamp(
        saved.left + event.clientX - saved.x,
        window.innerWidth - rect.width - margin,
      ),
      top: clamp(
        saved.top + event.clientY - saved.y,
        window.innerHeight - rect.height - margin,
      ),
      maxHeight: Math.max(0, window.innerHeight - margin * 2),
    });
  }
  function end(event: PointerEvent<HTMLElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return {
    panel,
    style: position ?? undefined,
    headerProps: {
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: () => {
        drag.current = null;
      },
    },
  };
}
