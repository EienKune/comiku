import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Maximize,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { IconButton } from "./ui";

export function ImageLightbox({
  src,
  alt,
  index,
  count,
  loading = false,
  thumbnailSrc,
  onClose,
  onPrevious,
  onNext,
}: {
  src?: string;
  alt: string;
  index: number;
  count: number;
  loading?: boolean;
  thumbnailSrc?: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onPrevious, onNext });
  callbacks.current = { onClose, onPrevious, onNext };
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        callbacks.current.onClose();
      }
      if (event.key === "ArrowLeft") callbacks.current.onPrevious?.();
      if (event.key === "ArrowRight") callbacks.current.onNext?.();
    };
    document.addEventListener("keydown", onKeyDown);
    document.documentElement.classList.add("has-lightbox");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.documentElement.classList.remove("has-lightbox");
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="ui-lightbox"
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`${alt}，第 ${index + 1} 张，共 ${count} 张`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <LightboxContent
        key={index}
        {...{
          src,
          alt,
          index,
          count,
          loading,
          thumbnailSrc,
          onClose,
          onPrevious,
          onNext,
        }}
      />
    </div>,
    document.body,
  );
}

type LightboxProps = Parameters<typeof ImageLightbox>[0];
type Viewport = { scale: number; x: number; y: number };
const fitted: Viewport = { scale: 1, x: 0, y: 0 };

function LightboxContent({
  src,
  alt,
  index,
  count,
  loading,
  thumbnailSrc,
  onClose,
  onPrevious,
  onNext,
}: LightboxProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(fitted);
  const viewportValue = useRef(fitted);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    view: Viewport;
    swipe: boolean;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const hasImage = Boolean(src || thumbnailSrc);

  function update(next: Viewport) {
    viewportValue.current = next;
    setViewport(next);
  }
  function zoom(factor: number, point = { x: 0, y: 0 }) {
    const previous = viewportValue.current;
    const scale = Math.min(3, Math.max(0.4, previous.scale * factor));
    const ratio = scale / previous.scale;
    update({
      scale,
      x: point.x - (point.x - previous.x) * ratio,
      y: point.y - (point.y - previous.y) * ratio,
    });
  }
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !hasImage) return;
    const wheel = (event: WheelEvent) => {
      if (!event.altKey || drag.current) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const previous = viewportValue.current;
      const scale = Math.min(
        3,
        Math.max(
          0.4,
          previous.scale *
            Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002),
        ),
      );
      const ratio = scale / previous.scale;
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const next = {
        scale,
        x: x - (x - previous.x) * ratio,
        y: y - (y - previous.y) * ratio,
      };
      viewportValue.current = next;
      setViewport(next);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [hasImage]);

  return (
    <>
      <div
        className="ui-lightbox__bar"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <span>
          {index + 1} / {count}
        </span>
        <div className="ui-lightbox__zoom" role="group" aria-label="图片缩放">
          <IconButton
            label="缩小图片"
            disabled={!hasImage || viewport.scale <= 0.4}
            onClick={() => zoom(1 / 1.2)}
          >
            <ZoomOut size={20} />
          </IconButton>
          <output aria-label="图片缩放比例">
            {Math.round(viewport.scale * 100)}%
          </output>
          <IconButton
            label="放大图片"
            disabled={!hasImage || viewport.scale >= 3}
            onClick={() => zoom(1.2)}
          >
            <ZoomIn size={20} />
          </IconButton>
          <IconButton
            label="复位图片"
            disabled={!hasImage}
            onClick={() => update(fitted)}
          >
            <Maximize size={20} />
          </IconButton>
        </div>
        <IconButton label="关闭大图" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      <div className="ui-lightbox__stage">
        {onPrevious && (
          <IconButton
            className="ui-lightbox__previous"
            label="上一张"
            onClick={onPrevious}
          >
            <ChevronLeft size={24} />
          </IconButton>
        )}
        <div
          className="ui-lightbox__viewport"
          ref={viewportRef}
          onPointerDownCapture={() => {
            suppressClick.current = false;
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget && !suppressClick.current)
              onClose();
          }}
        >
          {loading && !thumbnailSrc && !src ? (
            <LoaderCircle
              className="ui-lightbox__loading"
              aria-label="加载中"
            />
          ) : src || thumbnailSrc ? (
            <img
              src={src || thumbnailSrc}
              alt={alt}
              draggable={false}
              className={dragging ? "is-dragging" : undefined}
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || drag.current) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  id: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  view: viewportValue.current,
                  swipe:
                    event.pointerType === "touch" &&
                    viewportValue.current.scale <= 1,
                  moved: false,
                };
                setDragging(true);
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (!current || current.id !== event.pointerId) return;
                const dx = event.clientX - current.startX;
                const dy = event.clientY - current.startY;
                if (Math.hypot(dx, dy) > 4) current.moved = true;
                if (!current.swipe)
                  update({
                    ...current.view,
                    x: current.view.x + dx,
                    y: current.view.y + dy,
                  });
              }}
              onPointerUp={(event) => {
                const current = drag.current;
                if (!current || current.id !== event.pointerId) return;
                const dx = event.clientX - current.startX;
                const dy = event.clientY - current.startY;
                suppressClick.current = current.moved || Math.hypot(dx, dy) > 4;
                drag.current = null;
                setDragging(false);
                event.currentTarget.releasePointerCapture(event.pointerId);
                if (
                  current.swipe &&
                  Math.abs(dx) >= 48 &&
                  Math.abs(dx) > Math.abs(dy)
                ) {
                  if (dx > 0) onPrevious?.();
                  else onNext?.();
                }
              }}
              onPointerCancel={() => {
                drag.current = null;
                suppressClick.current = true;
                setDragging(false);
              }}
              onLostPointerCapture={() => {
                drag.current = null;
                setDragging(false);
              }}
            />
          ) : (
            <p role="alert">图片暂时无法显示</p>
          )}
        </div>
        {onNext && (
          <IconButton
            className="ui-lightbox__next"
            label="下一张"
            onClick={onNext}
          >
            <ChevronRight size={24} />
          </IconButton>
        )}
      </div>
    </>
  );
}
