import type { components } from "@comiku/api-client";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ImageIcon } from "lucide-react";
import { ImageLightbox } from "../../components/ImageLightbox";
import { isDisplayableImageUrl } from "../../components/media-url";
import { useImageUrl } from "../../components/use-image-url";
import { client, unwrap } from "../account/api";
import "./CandidateMediaPreview.css";

type Candidate = Pick<
  components["schemas"]["CandidateDto"],
  "id" | "authorName" | "media"
>;

function useCandidateImageUrl(
  candidateId: string,
  mediaId: string | undefined,
  variant: "thumbnail" | "original",
  enabled: boolean,
) {
  return useImageUrl(
    variant === "thumbnail"
      ? ["thumbnail", "candidate-media", candidateId, mediaId]
      : ["candidate-media", candidateId, mediaId],
    async () =>
      unwrap(
        await client.GET("/api/candidates/{candidateId}/media/{mediaId}/url", {
          params: {
            path: { candidateId, mediaId: mediaId! },
            query: { variant },
          },
        }),
      ),
    Boolean(mediaId) && enabled,
  );
}

function Thumbnail({
  candidateId,
  mediaId,
  index,
  visible,
  onOpen,
}: {
  candidateId: string;
  mediaId: string;
  index: number;
  visible: boolean;
  onOpen: (mediaId: string) => void;
}) {
  const query = useCandidateImageUrl(
    candidateId,
    mediaId,
    "thumbnail",
    visible,
  );
  return (
    <button
      type="button"
      className="candidate-media-preview__thumbnail"
      data-media-id={mediaId}
      aria-label={`查看第 ${index + 1} 张图片`}
      onClick={() => onOpen(mediaId)}
    >
      {isDisplayableImageUrl(query.data?.url) ? (
        <img src={query.data.url} alt="" loading="lazy" />
      ) : (
        <ImageIcon aria-hidden="true" />
      )}
      <span>{index + 1}</span>
    </button>
  );
}

function ThumbnailGrid({
  candidate,
  root,
  onOpen,
}: {
  candidate: Candidate;
  root: RefObject<HTMLDivElement | null>;
  onOpen: (mediaId: string) => void;
}) {
  const mediaIds = candidate.media.map((media) => media.id).join(",");
  const visibilityKey = `${candidate.id}:${mediaIds}`;
  const [visible, setVisible] = useState<{
    key: string;
    ids: ReadonlySet<string>;
  }>({ key: visibilityKey, ids: new Set() });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const targets = element.querySelectorAll<HTMLElement>("[data-media-id]");
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          setVisible((previous) => {
            const next = new Set(
              previous.key === visibilityKey ? previous.ids : [],
            );
            for (const entry of entries) {
              const id = (entry.target as HTMLElement).dataset.mediaId!;
              if (entry.isIntersecting) next.add(id);
              else next.delete(id);
            }
            return { key: visibilityKey, ids: next };
          });
        },
        { root: element, threshold: 0 },
      );
      targets.forEach((target) => observer.observe(target));
      return () => observer.disconnect();
    }
    // Older browsers still sign only items intersecting the scroll viewport.
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const next = new Set<string>();
      targets.forEach((target) => {
        const rect = target.getBoundingClientRect();
        if (
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          rect.right > bounds.left &&
          rect.left < bounds.right
        )
          next.add(target.dataset.mediaId!);
      });
      setVisible({ key: visibilityKey, ids: next });
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [root, visibilityKey]);
  return candidate.media.map((media, index) => (
    <Thumbnail
      key={media.id}
      candidateId={candidate.id}
      mediaId={media.id}
      index={index}
      visible={visible.key === visibilityKey && visible.ids.has(media.id)}
      onOpen={onOpen}
    />
  ));
}

export function CandidateMediaPreview({ candidate }: { candidate: Candidate }) {
  const coverMedia = candidate.media[0];
  const coverQuery = useCandidateImageUrl(
    candidate.id,
    coverMedia?.id,
    "thumbnail",
    true,
  );
  const [overviewFor, setOverviewFor] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{
    candidateId: string;
    mediaId: string;
    origin: "cover" | "overview";
  } | null>(null);
  const viewerIndex =
    viewer?.candidateId === candidate.id
      ? candidate.media.findIndex((media) => media.id === viewer.mediaId)
      : -1;
  const viewerMedia =
    viewerIndex >= 0 ? candidate.media[viewerIndex] : undefined;
  const originalQuery = useCandidateImageUrl(
    candidate.id,
    viewerMedia?.id,
    "original",
    Boolean(viewerMedia),
  );
  const viewerThumbnail = useCandidateImageUrl(
    candidate.id,
    viewerMedia?.id,
    "thumbnail",
    false,
  );
  const open = overviewFor === candidate.id && candidate.media.length > 1;
  const cover = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressFocus = useRef(false);
  const previousViewer = useRef<{ origin: "cover" | "overview" } | null>(null);
  const id = useId();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const cancelClose = useCallback(() => clearTimeout(timer.current), []);
  const restoreFocus = useCallback((origin: "cover" | "overview") => {
    suppressFocus.current = true;
    const target =
      origin === "overview"
        ? (trigger.current ?? cover.current)
        : cover.current;
    target?.focus();
    suppressFocus.current = false;
  }, []);
  const close = useCallback(
    (restore = false) => {
      cancelClose();
      setOverviewFor(null);
      setPosition(null);
      if (restore) restoreFocus("overview");
    },
    [cancelClose, restoreFocus],
  );
  const show = () => {
    cancelClose();
    if (!suppressFocus.current) setOverviewFor(candidate.id);
  };
  const later = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (
        document.activeElement !== trigger.current &&
        !popup.current?.contains(document.activeElement)
      )
        close();
    }, 160);
  };
  function openViewer(mediaId: string, origin: "cover" | "overview") {
    close();
    setViewer({ candidateId: candidate.id, mediaId, origin });
  }
  const reposition = useCallback(() => {
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
    setPosition((previous) =>
      previous?.left === left && previous.top === top
        ? previous
        : { left, top },
    );
  }, []);
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, candidate.media.length, reposition]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (viewerMedia && viewer)
      previousViewer.current = { origin: viewer.origin };
    else if (previousViewer.current) {
      restoreFocus(previousViewer.current.origin);
      previousViewer.current = null;
    }
    if (viewer && !viewerMedia) setViewer(null);
    if (
      overviewFor &&
      (overviewFor !== candidate.id || candidate.media.length < 2)
    )
      close(document.activeElement === document.body);
  }, [
    viewer,
    viewerMedia,
    overviewFor,
    candidate.id,
    candidate.media.length,
    close,
    restoreFocus,
  ]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        close(Boolean(popup.current?.contains(document.activeElement)));
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const scroll = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !popup.current?.contains(event.target)
      )
        reposition();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, close, reposition]);
  return (
    <>
      <div className="candidate-media-preview">
        <button
          ref={cover}
          type="button"
          className="workspace-cover workspace-cover-button"
          aria-label={`查看 ${candidate.authorName} 的图片组大图`}
          disabled={!coverMedia}
          onClick={() => coverMedia && openViewer(coverMedia.id, "cover")}
        >
          {isDisplayableImageUrl(coverQuery.data?.url) ? (
            <img src={coverQuery.data.url} alt="" loading="lazy" />
          ) : (
            <ImageIcon aria-hidden="true" />
          )}
        </button>
        {candidate.media.length > 1 && (
          <button
            ref={trigger}
            type="button"
            className="candidate-media-preview__count"
            aria-label={`查看 ${candidate.media.length} 张图片总览`}
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
                popup.current
                  ?.querySelector<HTMLButtonElement>("button")
                  ?.focus();
              }
            }}
          >
            {candidate.media.length} 张
          </button>
        )}
      </div>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="dialog"
            aria-label={`${candidate.authorName} 的图片总览`}
            className="candidate-media-preview__grid"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
            onPointerEnter={cancelClose}
            onPointerLeave={later}
            onFocus={cancelClose}
            onBlur={later}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const buttons = popup.current?.querySelectorAll("button");
              if (!buttons?.length) return;
              if (
                (event.shiftKey && event.target === buttons[0]) ||
                (!event.shiftKey &&
                  event.target === buttons[buttons.length - 1])
              ) {
                event.preventDefault();
                close(true);
              }
            }}
          >
            <ThumbnailGrid
              candidate={candidate}
              root={popup}
              onOpen={(mediaId) => openViewer(mediaId, "overview")}
            />
          </div>,
          document.body,
        )}
      {viewerMedia && (
        <ImageLightbox
          src={
            isDisplayableImageUrl(originalQuery.data?.url)
              ? originalQuery.data.url
              : undefined
          }
          thumbnailSrc={
            isDisplayableImageUrl(viewerThumbnail.data?.url)
              ? viewerThumbnail.data.url
              : undefined
          }
          alt={`${candidate.authorName} 的候选图片第 ${viewerIndex + 1} 页`}
          index={viewerIndex}
          count={candidate.media.length}
          loading={originalQuery.isPending}
          onClose={() => setViewer(null)}
          onPrevious={
            viewerIndex > 0
              ? () =>
                  setViewer(
                    (current) =>
                      current && {
                        ...current,
                        mediaId: candidate.media[viewerIndex - 1].id,
                      },
                  )
              : undefined
          }
          onNext={
            viewerIndex < candidate.media.length - 1
              ? () =>
                  setViewer(
                    (current) =>
                      current && {
                        ...current,
                        mediaId: candidate.media[viewerIndex + 1].id,
                      },
                  )
              : undefined
          }
        />
      )}
    </>
  );
}
