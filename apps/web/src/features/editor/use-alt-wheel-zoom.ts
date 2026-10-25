import { useEffect, type RefObject } from "react";

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

export function useAltWheelZoom({
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
  useEffect(() => {
    const element = canvas.current;
    if (!element || !ready) return;
    function wheel(event: WheelEvent) {
      if (!event.altKey || event.ctrlKey || !image.current) return;
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,select,.translation-page-controls",
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
      onChange(
        zoomAtPointer(
          zoom,
          offset,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          { x: event.clientX, y: event.clientY },
          delta,
        ),
      );
    }
    // Native non-passive listener lets Alt zoom consume the wheel without changing normal scrolling.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [canvas, image, zoom, offset, ready, onChange]);
}
