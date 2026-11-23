import { useRef, type ReactNode } from "react";

export function TypesetZoom({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  return (
    <label className="typeset-zoom">
      缩放
      <input
        aria-label={label}
        aria-valuetext={`${Math.round(value * 100)}%`}
        type="range"
        min={0.5}
        max={3}
        step={0.25}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
      <output>{Math.round(value * 100)}%</output>
    </label>
  );
}

export function TypesetComparePane({
  side,
  children,
}: {
  side: "source" | "output";
  children: ReactNode;
}) {
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  return (
    <div
      className={`typeset-compare-${side}`}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        const pane = event.currentTarget;
        if (
          event.pointerType === "touch" ||
          event.button !== 0 ||
          !event.isPrimary ||
          (pane.scrollWidth <= pane.clientWidth &&
            pane.scrollHeight <= pane.clientHeight)
        )
          return;
        event.preventDefault();
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: pane.scrollLeft,
          top: pane.scrollTop,
        };
        pane.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
        event.currentTarget.scrollTop = start.top + start.y - event.clientY;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    >
      {children}
    </div>
  );
}
