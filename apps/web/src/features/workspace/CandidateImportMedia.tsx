import { CandidateImageSimilarityAction } from "./CandidateImageSimilarity";
import { useEffect, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import { ImageLightbox } from "../../components/ImageLightbox";
import { isDisplayableImageUrl } from "../../components/media-url";
import { useImageUrl } from "../../components/use-image-url";
import { client, unwrap } from "../account/api";

const visibilityCallbacks = new Map<Element, (visible: boolean) => void>();
let visibilityObserver: IntersectionObserver | undefined;
function observeVisibility(
  element: Element,
  callback: (visible: boolean) => void,
) {
  if (typeof IntersectionObserver === "undefined") {
    callback(true);
    return () => {};
  }
  visibilityObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        visibilityCallbacks.get(entry.target)?.(entry.isIntersecting);
    },
    { threshold: 0 },
  );
  visibilityCallbacks.set(element, callback);
  visibilityObserver.observe(element);
  return () => {
    visibilityObserver?.unobserve(element);
    visibilityCallbacks.delete(element);
    if (!visibilityCallbacks.size) {
      visibilityObserver?.disconnect();
      visibilityObserver = undefined;
    }
  };
}
function useCandidateImportUrl(
  candidateId: string,
  mediaId: string,
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
          params: { path: { candidateId, mediaId }, query: { variant } },
        }),
      ),
    enabled,
  );
}
export function CandidateImportThumbnail({
  candidateId,
  mediaId,
}: {
  candidateId: string;
  mediaId: string;
}) {
  const ref = useRef<HTMLSpanElement>(null),
    [visible, setVisible] = useState(false);
  useEffect(
    () =>
      ref.current ? observeVisibility(ref.current, setVisible) : undefined,
    [],
  );
  const query = useCandidateImportUrl(
    candidateId,
    mediaId,
    "thumbnail",
    visible,
  );
  return (
    <span className="candidate-import-thumb" ref={ref}>
      {isDisplayableImageUrl(query.data?.url) ? (
        <img src={query.data.url} alt="" loading="lazy" draggable={false} />
      ) : (
        <ImageIcon size={22} aria-hidden="true" />
      )}
    </span>
  );
}
export function CandidateImportPreview({
  candidateId,
  mediaIds,
  sourceMediaIds,
  initialMediaId,
  authorName,
  portalContainer,
  onClose,
  ordered = false,
}: {
  candidateId: string;
  mediaIds: readonly string[];
  sourceMediaIds: readonly string[];
  initialMediaId: string;
  authorName: string;
  portalContainer: HTMLElement | null;
  onClose: () => void;
  ordered?: boolean;
}) {
  const [mediaId, setMediaId] = useState(initialMediaId);
  const index = mediaIds.indexOf(mediaId),
    originalIndex = sourceMediaIds.indexOf(mediaId);
  const original = useCandidateImportUrl(
    candidateId,
    mediaId,
    "original",
    index >= 0,
  );
  const thumbnail = useCandidateImportUrl(
    candidateId,
    mediaId,
    "thumbnail",
    index >= 0,
  );
  if (index < 0) return null;
  return (
    <ImageLightbox
      src={original.data?.url ?? undefined}
      thumbnailSrc={thumbnail.data?.url ?? undefined}
      footer={
        <CandidateImageSimilarityAction
          key={mediaId}
          candidateId={candidateId}
          mediaId={mediaId}
          authorName={authorName}
          index={originalIndex}
          sourceUrl={original.data?.url ?? thumbnail.data?.url ?? undefined}
        />
      }
      loading={original.isPending}
      portalContainer={portalContainer}
      alt={`${authorName} · ${ordered ? `入库第 ${index + 1} 页（原图 ${originalIndex + 1}）` : `原图 ${originalIndex + 1}`}${original.isError ? " · 原图暂不可用" : ""}`}
      index={index}
      count={mediaIds.length}
      onClose={onClose}
      onPrevious={index > 0 ? () => setMediaId(mediaIds[index - 1]) : undefined}
      onNext={
        index < mediaIds.length - 1
          ? () => setMediaId(mediaIds[index + 1])
          : undefined
      }
    />
  );
}
