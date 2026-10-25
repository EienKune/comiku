import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

export function MarkerTooltip({
  text,
  children,
}: {
  text: string;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const id = useId();
  const suppressFocus = useRef(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  function hide() {
    setAnchor(null);
    setPosition(null);
  }

  useLayoutEffect(() => {
    if (!anchor || !tooltip.current) return;
    const trigger = anchor.getBoundingClientRect();
    const box = tooltip.current.getBoundingClientRect();
    const margin = 16;
    const gap = 8;
    const below = trigger.bottom + gap;
    const above = trigger.top - box.height - gap;
    setPosition({
      left: Math.max(
        margin,
        Math.min(
          trigger.left + trigger.width / 2 - box.width / 2,
          window.innerWidth - box.width - margin,
        ),
      ),
      top: Math.max(
        margin,
        Math.min(
          below + box.height <= window.innerHeight - margin ? below : above,
          window.innerHeight - box.height - margin,
        ),
      ),
    });
  }, [anchor, text]);

  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => {
      setAnchor(null);
      setPosition(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("wheel", dismiss, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("wheel", dismiss, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor]);

  return (
    <>
      {cloneElement(children, {
        "aria-describedby": anchor
          ? [children.props["aria-describedby"], id].filter(Boolean).join(" ")
          : children.props["aria-describedby"],
        onPointerEnter: (event) => {
          children.props.onPointerEnter?.(event);
          if (event.pointerType === "touch" || event.buttons) return;
          hide();
          suppressFocus.current = false;
          setAnchor(event.currentTarget);
        },
        onPointerLeave: (event) => {
          children.props.onPointerLeave?.(event);
          hide();
        },
        onPointerDown: (event) => {
          suppressFocus.current = true;
          hide();
          children.props.onPointerDown?.(event);
        },
        onFocus: (event) => {
          children.props.onFocus?.(event);
          if (!suppressFocus.current) {
            hide();
            setAnchor(event.currentTarget);
          }
        },
        onBlur: (event) => {
          children.props.onBlur?.(event);
          suppressFocus.current = false;
          hide();
        },
      })}
      {anchor &&
        createPortal(
          <div
            id={id}
            ref={tooltip}
            role="tooltip"
            className="ui-marker-tooltip"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {text.trim() || "尚未填写译文"}
          </div>,
          document.body,
        )}
    </>
  );
}
