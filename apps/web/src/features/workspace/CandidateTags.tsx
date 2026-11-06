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
import { fitCandidateTags } from "./candidate-tag-layout";
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
  const measurement = useRef<HTMLDivElement>(null);
  const modelRoot = useRef<HTMLDivElement>(null);
  const measure = useRef(() => {});
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const suppressFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [visibleCount, setVisibleCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const id = useId();
  // Source order is preserved; normalization only deduplicates presentation.
  const matchesByTag = new Map<string, Match[]>();
  for (const match of matches) {
    const group = matchesByTag.get(match.normalizedValue) ?? [];
    group.push(match);
    matchesByTag.set(match.normalizedValue, group);
  }
  const tags = [
    ...new Map(hashtags.map((value) => [normalized(value), value])).entries(),
  ].map(([key, value]) => ({
    key,
    value: value.trim().replace(/^#+/, ""),
    matches: matchesByTag.get(key) ?? [],
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
  const featuredKeys = new Set(featured.map((tag) => tag.key));
  const orderedTags = [
    ...featured,
    ...matched.filter((tag) => !featuredKeys.has(tag.key)),
    ...tags.filter((tag) => !tag.matches.length),
  ];
  const shown = orderedTags.slice(0, visibleCount);
  const hidden = tags.length - shown.length;
  const hasContent = tags.length > 0 || Boolean(model);
  const overflowDigits = String(tags.length).length;
  // Refresh measurements after committed props change, without installing observers
  // against freshly allocated tag arrays or mounting a second model component.
  useLayoutEffect(() => {
    const element = root.current;
    const rail = measurement.current;
    if (!element || !rail) return;
    measure.current = () => {
      const width = element.getBoundingClientRect().width;
      if (width <= 0) return;
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 8;
      const moreWidths = Array.from(
        rail.querySelectorAll<HTMLElement>("[data-candidate-more-measure]"),
        (node) => node.getBoundingClientRect().width,
      );
      // Reserve a shared second row for the two directional clues and +N,
      // even when a source hashtag is much wider than its card.
      const featuredMax = Math.max(
        0,
        (width - Math.max(...moreWidths) - 2 * gap - 1) / 2,
      );
      const rem =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      const ordinaryMax = Math.min(width, 10 * rem);
      element.style.setProperty(
        "--candidate-tags-featured-max",
        `${featuredMax}px`,
      );
      const tagWidths = Array.from(
        rail.querySelectorAll<HTMLElement>("[data-candidate-tag-measure]"),
        (node, index) =>
          Math.min(
            node.getBoundingClientRect().width,
            index < featured.length ? featuredMax : ordinaryMax,
          ),
      );
      const modelWidths = Array.from(
        modelRoot.current?.children ?? [],
        (node) => node.getBoundingClientRect().width,
      );
      const next = fitCandidateTags({
        width,
        gap,
        modelWidths,
        tagWidths,
        moreWidths,
      });
      setVisibleCount((old) => (old === next ? old : next));
    };
    measure.current();
  });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame: number | undefined;
    let disposed = false;
    const schedule = () => {
      if (frame !== undefined || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure.current();
      });
    };
    // Observe the bounded host rather than the measurement rail; the rail never
    // contributes to layout. Defer writes outside the observer delivery cycle.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(element);
    const mutation =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(schedule);
    if (modelRoot.current)
      mutation?.observe(modelRoot.current, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    document.fonts?.addEventListener("loadingerror", schedule);
    void document.fonts?.ready.then(() => {
      if (!disposed) schedule();
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      mutation?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
      document.fonts?.removeEventListener("loadingerror", schedule);
    };
  }, [hasContent]);
  function tagBadge(tag: (typeof tags)[number]) {
    const priority = tag.matches.some(
      (match) => match.direction === "priority",
    );
    const negative = tag.matches.some(
      (match) => match.direction === "deprioritize",
    );
    return (
      <Badge tone={negative ? "warning" : priority ? "success" : "neutral"}>
        {priority ? "↑" : ""}
        {negative ? "↓" : ""}
        {priority || negative ? " " : ""}#{tag.value}
      </Badge>
    );
  }
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
    if (!open) return;
    if (!trigger.current?.isConnected) close();
    else reposition.current();
  }, [open, hashtags, matches, visibleCount, close]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
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
      if (
        !(event.target instanceof Node) ||
        !popup.current?.contains(event.target)
      )
        reposition.current();
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
      <div
        ref={measurement}
        className="candidate-tags__measure"
        aria-hidden="true"
        inert
      >
        {orderedTags.map((tag) => (
          <span key={tag.key} data-candidate-tag-measure>
            {tagBadge(tag)}
          </span>
        ))}
        {Array.from({ length: overflowDigits }, (_, index) => (
          <span key={index} data-candidate-more-measure>
            <Badge tone="neutral">+{"9".repeat(index + 1)}</Badge>
          </span>
        ))}
      </div>
      <div ref={modelRoot} className="candidate-tags__model">
        {model}
      </div>
      {shown.map((tag) => (
        <button
          key={tag.key}
          {...buttonProps()}
          className={`candidate-tags__trigger${featuredKeys.has(tag.key) ? " candidate-tags__trigger--featured" : ""}`}
          title={
            tag.matches.length
              ? tag.matches.map(ruleName).join("；")
              : `#${tag.value}`
          }
        >
          {tagBadge(tag)}
        </button>
      ))}
      {hidden > 0 && (
        <button
          {...buttonProps()}
          className="candidate-tags__trigger candidate-tags__more"
          aria-label={`+${hidden}，查看全部原帖标签`}
        >
          <Badge tone="neutral">+{hidden}</Badge>
        </button>
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
