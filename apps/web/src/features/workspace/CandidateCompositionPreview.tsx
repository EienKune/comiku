import { useState } from "react";
import { ImageLightbox } from "../../components/ImageLightbox";
import { useImageUrl } from "../../components/use-image-url";
import { client, unwrap } from "../account/api";
import { CandidateImageSimilarityAction } from "./CandidateImageSimilarity";
import {
  compositionMediaDetails,
  type CompositionDraft,
} from "./candidate-composition-model";
export function CandidateCompositionPreview({
  draft,
  ids,
  initialId,
  portalContainer,
  onClose,
}: {
  draft: CompositionDraft;
  ids: readonly string[];
  initialId: string;
  portalContainer: HTMLElement | null;
  onClose: () => void;
}) {
  const [id, setId] = useState(initialId);
  const detail = compositionMediaDetails(draft).get(id),
    index = ids.indexOf(id);
  const candidateId = detail?.candidate.id ?? "";
  const original = useImageUrl(
    ["candidate-media", candidateId, id],
    async () =>
      unwrap(
        await client.GET("/api/candidates/{candidateId}/media/{mediaId}/url", {
          params: {
            path: { candidateId, mediaId: id },
            query: { variant: "original" },
          },
        }),
      ),
    Boolean(detail) && index >= 0,
  );
  const thumbnail = useImageUrl(
    ["thumbnail", "candidate-media", candidateId, id],
    async () =>
      unwrap(
        await client.GET("/api/candidates/{candidateId}/media/{mediaId}/url", {
          params: {
            path: { candidateId, mediaId: id },
            query: { variant: "thumbnail" },
          },
        }),
      ),
    Boolean(detail) && index >= 0,
  );
  if (!detail || index < 0) return null;
  return (
    <ImageLightbox
      src={original.data?.url ?? undefined}
      thumbnailSrc={thumbnail.data?.url ?? undefined}
      loading={original.isPending}
      portalContainer={portalContainer}
      alt={`${detail.candidate.authorName} · 来源帖 ${detail.sourceIndex + 1} · 原图 ${detail.mediaIndex + 1}`}
      index={index}
      count={ids.length}
      onClose={onClose}
      onPrevious={index > 0 ? () => setId(ids[index - 1]) : undefined}
      onNext={index < ids.length - 1 ? () => setId(ids[index + 1]) : undefined}
      footer={
        <CandidateImageSimilarityAction
          key={id}
          candidateId={candidateId}
          mediaId={id}
          authorName={detail.candidate.authorName}
          index={detail.mediaIndex}
          sourceUrl={original.data?.url ?? thumbnail.data?.url ?? undefined}
        />
      }
    />
  );
}
