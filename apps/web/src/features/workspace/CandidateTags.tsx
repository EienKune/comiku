import {
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { components } from "@comiku/api-client";
import { Badge } from "../../components/ui";
import "./candidates.css";

type Match = components["schemas"]["CandidateDto"]["tagRuleMatches"][number];
const normalized = (value: string) =>
  value.normalize("NFKC").trim().replace(/^#+/, "").toLocaleLowerCase();
const ruleName = (match: Match) =>
  `${match.direction === "priority" ? "优先标签" : "降级标签"} · ${match.groupName}`;

export function CandidateTags({
  hashtags,
  matches,
  model,
}: {
  hashtags: string[];
  matches: Match[];
  model?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const suppressFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [ordinaryLimit, setOrdinaryLimit] = useState(2);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const id = useId();
  // Source order is preserved; normalization only deduplicates presentation.
  const tags = [
    ...new Map(hashtags.map((value) => [normalized(value), value])).entries(),
  ].map(([key, value]) => ({
    key,
    value: value.replace(/^#+/, ""),
    matches: matches.filter((match) => match.normalizedValue === key),
  }));
  const matched = tags.filter((tag) => tag.matches.length);
  const positive = matched.find((tag) =>
    tag.matches.some((match) => match.direction === "priority"),
  );
  const negative = matched.find((tag) =>
    tag.matches.some((match) => match.direction === "deprioritize"),
  );
  const featured =
    positive && negative && positive.key !== negative.key
      ? [positive, negative]
      : matched.slice(0, 2);
  const ordinary = tags
    .filter((tag) => !tag.matches.length)
    .slice(0, ordinaryLimit);
  const hidden = tags.length - featured.length - ordinary.length;
  const hasContent = tags.length > 0 || Boolean(model);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setOrdinaryLimit(entry.contentRect.width < 300 ? 1 : 2),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasContent]);
  const cancelClose = useCallback(() => {
    clearTimeout(timer.current);
  }, []);
  const close = useCallback(
    (restore = false) => {
      cancelClose();
      setOpen(false);
      setPosition(null);
      if (restore) {
        suppressFocus.current = true;
        trigger.current?.focus();
        suppressFocus.current = false;
      }
    },
    [cancelClose],
  );
  function show(button: HTMLButtonElement) {
    cancelClose();
    trigger.current = button;
    if (!suppressFocus.current) setOpen(true);
  }
  function later() {
    cancelClose();
    timer.current = setTimeout(() => {
      if (
        document.activeElement !== trigger.current &&
        !popup.current?.contains(document.activeElement)
      )
        close();
    }, 160);
  }
  const reposition = useRef(() => {});
  reposition.current = () => {
    if (!trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const rect = popup.current.getBoundingClientRect();
    const next = {
      left: Math.max(
        12,
        Math.min(anchor.left, window.innerWidth - rect.width - 12),
      ),
      top:
        anchor.bottom + 8 + rect.height <= window.innerHeight - 12
          ? anchor.bottom + 8
          : Math.max(12, anchor.top - rect.height - 8),
    };
    setPosition((old) =>
      old?.left === next.left && old.top === next.top ? old : next,
    );
  };
  useLayoutEffect(() => {
    if (open) reposition.current();
  }, [open, hashtags, matches]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const update = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) reposition.current();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, close]);
  function buttonProps() {
    return {
      type: "button" as const,
      "aria-haspopup": "dialog" as const,
      "aria-expanded": open,
      "aria-controls": open ? id : undefined,
      onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType !== "touch" && !event.buttons)
          show(event.currentTarget);
      },
      onPointerLeave: later,
      onFocus: (event: React.FocusEvent<HTMLButtonElement>) =>
        show(event.currentTarget),
      onBlur: later,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) =>
        show(event.currentTarget),
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (
          open &&
          (event.key === "ArrowDown" ||
            (event.key === "Tab" && !event.shiftKey))
        ) {
          event.preventDefault();
          cancelClose();
          popup.current?.focus();
        }
      },
    };
  }
  if (!tags.length && !model) return null;
  return (
    <div ref={root} className="candidate-tags">
      {(model || featured.length > 0) && (
        <div className="candidate-tags__featured">
          {model}
          {featured.map((tag) => {
            const priority = tag.matches.some(
              (match) => match.direction === "priority",
            );
            const deprioritize = tag.matches.some(
              (match) => match.direction === "deprioritize",
            );
            return (
              <button
                key={tag.key}
                {...buttonProps()}
                className="candidate-tags__trigger"
                title={tag.matches.map(ruleName).join("；")}
              >
                <Badge tone={deprioritize ? "warning" : "success"}>
                  {priority ? "↑" : ""}
                  {deprioritize ? "↓" : ""} #{tag.value}
                </Badge>
              </button>
            );
          })}
        </div>
      )}
      {(ordinary.length > 0 || hidden > 0) && (
        <div className="candidate-tags__ordinary">
          {ordinary.map((tag) => (
            <span
              className="candidate-tags__ordinary-tag"
              key={tag.key}
              title={`#${tag.value}`}
            >
              #{tag.value}
            </span>
          ))}
          {hidden > 0 && (
            <button
              {...buttonProps()}
              className="candidate-tags__more"
              aria-label={`+${hidden}，查看全部原帖标签`}
            >
              +{hidden}
            </button>
          )}
        </div>
      )}
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="dialog"
            tabIndex={0}
            aria-label="全部原帖标签"
            className="candidate-tag-overview"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
            onPointerEnter={cancelClose}
            onPointerLeave={later}
            onFocus={cancelClose}
            onBlur={later}
          >
            <strong>全部原帖标签</strong>
            <ul>
              {tags.map((tag) => (
                <li key={tag.key}>
                  <span>#{tag.value}</span>
                  {tag.matches.map((match) => (
                    <small key={`${match.groupId}:${match.direction}`}>
                      {ruleName(match)}
                    </small>
                  ))}
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
