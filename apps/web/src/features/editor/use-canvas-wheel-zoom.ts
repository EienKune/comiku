import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export function zoomAtPointer(
  zoom: number,
  offset: { x: number; y: number },
  center: { x: number; y: number },
  pointer: { x: number; y: number },
  delta: number,
) {
  const next = Math.min(3, Math.max(0.4, zoom * Math.exp(-delta * 0.002)));
  const ratio = next / zoom;
  return {
    zoom: next,
    offset: {
      x: offset.x + (pointer.x - center.x) * (1 - ratio),
      y: offset.y + (pointer.y - center.y) * (1 - ratio),
    },
  };
}

export function useCanvasWheelZoom({
  canvas,
  image,
  zoom,
  offset,
  ready,
  onChange,
}: {
  canvas: RefObject<HTMLElement | null>;
  image: RefObject<HTMLElement | null>;
  zoom: number;
  offset: { x: number; y: number };
  ready: boolean;
  onChange: (next: ReturnType<typeof zoomAtPointer>) => void;
}) {
  const rendered = useRef({ zoom, offset });
  const current = useRef({ zoom, offset });
  const change = useRef(onChange);
  useLayoutEffect(() => {
    change.current = onChange;
  });
  useLayoutEffect(() => {
    rendered.current = { zoom, offset };
    current.current = { zoom, offset };
  }, [zoom, offset]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !ready) return;
    function wheel(event: WheelEvent) {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.buttons ||
        !event.deltaY ||
        !image.current
      )
        return;
      if (
        (event.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"]),.translation-page-controls',
        )
      )
        return;
      const rect = image.current.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element!.clientHeight
            : 1);
      const pending = current.current;
      const next = zoomAtPointer(
        pending.zoom,
        pending.offset,
        {
          x:
            rect.left +
            rect.width / 2 +
            pending.offset.x -
            rendered.current.offset.x,
          y:
            rect.top +
            rect.height / 2 +
            pending.offset.y -
            rendered.current.offset.y,
        },
        { x: event.clientX, y: event.clientY },
        delta,
      );
      // Wheel bursts can precede the next render. Advance the model immediately,
      // adjusting the measured center for the pan not yet committed to the DOM.
      current.current = next;
      change.current(next);
    }
    // Consume only preview wheel gestures; controls and browser zoom remain native.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [canvas, image, ready]);
}
