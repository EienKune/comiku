import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Badge } from "../../components/ui";
import { client, unwrap } from "../account/api";
import "./CandidateClassificationScores.css";

type Category = components["schemas"]["CandidateClassificationTagDto"];
const stateLabels = {
  pending: "识别中",
  failed: "识别失败",
  unavailable: "暂无有效分数",
};

function ScoreTable({
  candidateId,
  onResize,
}: {
  candidateId: string;
  onResize: () => void;
}) {
  const query = useQuery({
    queryKey: ["candidate-classification-scores", candidateId],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/candidates/{id}/classification-scores", {
          params: { path: { id: candidateId } },
          signal,
        }),
      ),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.images.some((image) => image.state === "pending")
        ? 5000
        : false,
    refetchIntervalInBackground: false,
  });
  useLayoutEffect(onResize, [
    onResize,
    query.data,
    query.isFetching,
    query.isError,
  ]);
  // The observer's per-mount update counter resets on each opening, including
  // cached or deduplicated reads. Hide old cached vectors until this opening's
  // first fresh success; preserve the mounted table during later polling so
  // inspection does not lose its scroll position. Errors always hide scores.
  if (query.isError)
    return <p role="alert">分类分数读取失败，请重新打开重试</p>;
  if (query.isPending || !query.isFetchedAfterMount)
    return <p role="status">正在读取分类分数…</p>;
  const data = query.data;
  if (!data.modelKey) return <p>图片识别未启用</p>;
  if (!data.images.length) return <p>暂无图片</p>;
  return (
    <table aria-label="逐图分类分数">
      <thead>
        <tr>
          <th scope="col">图片</th>
          {data.columns.map((column) => (
            <th key={column.label} scope="col">
              {column.text}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.images.map((image) => (
          <tr key={image.mediaId}>
            <th scope="row">{image.index}</th>
            {image.state === "succeeded" && image.scores ? (
              image.scores.map((score, index) => (
                <td
                  key={data.columns[index].label}
                  className={
                    image.winner === index
                      ? `candidate-scores__winner candidate-scores__winner--${data.columns[index].tone}`
                      : undefined
                  }
                >
                  {(score * 100).toFixed(1)}%
                  {image.winner === index && (
                    <span className="sr-only">（最高）</span>
                  )}
                </td>
              ))
            ) : (
              <td
                className="candidate-scores__state"
                colSpan={data.columns.length}
              >
                {stateLabels[image.state as keyof typeof stateLabels] ??
                  "暂无有效分数"}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CandidateClassificationScores({
  candidateId,
  category,
}: {
  candidateId: string;
  category: Category;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressFocus = useRef(false);
  const id = useId();
  const cancelClose = useCallback(() => {
    clearTimeout(timer.current);
  }, []);
  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
    setPosition(null);
  }, [cancelClose]);
  function show() {
    cancelClose();
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
  // Stable callback keeps the table's resize effect independent of parent renders.
  const reposition = useRef(() => {});
  reposition.current = () => {
    if (!trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const rect = popup.current.getBoundingClientRect();
    const left = Math.max(
      12,
      Math.min(anchor.left, window.innerWidth - rect.width - 12),
    );
    const below = anchor.bottom + 8;
    const top =
      below + rect.height <= window.innerHeight - 12
        ? below
        : Math.max(12, anchor.top - rect.height - 8);
    setPosition((old) =>
      old?.left === left && old.top === top ? old : { left, top },
    );
  };
  const [onResize] = useState(() => () => reposition.current());
  useLayoutEffect(() => {
    if (open) onResize();
  }, [open, onResize]);
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
      if (event.key !== "Escape") return;
      const restore = popup.current?.contains(document.activeElement);
      close();
      if (restore) {
        suppressFocus.current = true;
        trigger.current?.focus();
        suppressFocus.current = false;
      }
    };
    const update = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !popup.current?.contains(event.target)
      )
        onResize();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, onResize, close]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="candidate-scores-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch" && !event.buttons) show();
        }}
        onPointerLeave={later}
        onFocus={show}
        onBlur={later}
        onClick={show}
        onKeyDown={(event) => {
          if (
            open &&
            (event.key === "ArrowDown" ||
              (event.key === "Tab" && !event.shiftKey))
          ) {
            event.preventDefault();
            cancelClose();
            scroll.current?.focus();
          }
        }}
      >
        <Badge tone={category.tone}>{category.text}</Badge>
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="dialog"
            aria-label="所有图片的分类分数"
            className="candidate-scores"
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
            <div
              ref={scroll}
              tabIndex={0}
              className="candidate-scores__scroll"
              aria-label="分类分数，可滚动"
            >
              <ScoreTable candidateId={candidateId} onResize={onResize} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
