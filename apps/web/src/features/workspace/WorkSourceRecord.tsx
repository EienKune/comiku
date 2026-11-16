import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { ChevronDown, ExternalLink, ImageIcon } from "lucide-react";
import { Badge, Button } from "../../components/ui";
import { ImageLightbox } from "../../components/ImageLightbox";
import { isDisplayableImageUrl } from "../../components/media-url";
import { useImageUrl } from "../../components/use-image-url";
import { useAccount } from "../account/account-context";
import { client, unwrap } from "../account/api";
import "./work-source-record.css";

type Source = components["schemas"]["WorkSourceDto"];
type SourceMedia = components["schemas"]["WorkSourceMediaDto"];

function useSourceImageUrl(
  workId: string,
  media: SourceMedia,
  variant: "thumbnail" | "original",
  enabled: boolean,
) {
  return useImageUrl(
    ["work-source-media", workId, media.id, variant],
    async () =>
      unwrap(
        await client.GET("/api/works/{workId}/source/media/{mediaId}/url", {
          params: { path: { workId, mediaId: media.id }, query: { variant } },
        }),
      ),
    enabled && media.available,
  );
}

function SourceThumbnail({
  workId,
  media,
  visible,
  onOpen,
}: {
  workId: string;
  media: SourceMedia;
  visible: boolean;
  onOpen: () => void;
}) {
  const image = useSourceImageUrl(workId, media, "thumbnail", visible);
  return (
    <div
      className={`work-source-record__tile${media.adopted === false ? " is-unselected" : ""}`}
    >
      <button
        type="button"
        className="work-source-record__image"
        data-media-id={media.id}
        aria-label={`查看来源原图 ${media.orderIndex + 1}`}
        disabled={!media.available}
        onClick={onOpen}
      >
        {isDisplayableImageUrl(image.data?.url) ? (
          <img src={image.data.url} alt="" loading="lazy" />
        ) : (
          <ImageIcon aria-hidden="true" />
        )}
      </button>
      <strong>原图 {media.orderIndex + 1}</strong>
      <Badge tone={media.adopted === true ? "success" : "neutral"}>
        {media.disposition === "other_work"
          ? "用于另一作品"
          : media.adopted === null
            ? "采用情况未知"
            : media.adopted
              ? media.workOrderIndex === null
                ? "已采用"
                : `采用 · 第 ${media.workOrderIndex + 1} 页`
              : "未采用"}
      </Badge>
      {media.disposition === "other_work" && media.adoptedByWork && (
        <a
          className="work-source-record__work"
          href={`/works/${media.adoptedByWork.id}`}
          target="_blank"
          rel="noreferrer"
        >
          #{media.adoptedByWork.workNumber}
          {media.adoptedByWork.title ? ` · ${media.adoptedByWork.title}` : ""}
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
      {!media.available && <span>原图不可用</span>}
      {image.isError && (
        <Button variant="ghost" size="sm" onClick={() => void image.refetch()}>
          重试缩略图
        </Button>
      )}
    </div>
  );
}

function SourceImages({
  workId,
  media,
  portalContainer,
}: {
  workId: string;
  media: SourceMedia[];
  portalContainer: HTMLElement | null;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<number | null>(null);
  const mediaIds = media.map((item) => item.id).join(",");
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const targets = element.querySelectorAll<HTMLElement>("[data-media-id]");
    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        setVisible((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.mediaId!;
            if (entry.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      });
      targets.forEach((target) => observer.observe(target));
      return () => observer.disconnect();
    }
    const measure = () => {
      const next = new Set<string>();
      targets.forEach((target) => {
        const rect = target.getBoundingClientRect();
        if (
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        )
          next.add(target.dataset.mediaId!);
      });
      setVisible(next);
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [mediaIds]);
  return (
    <>
      <div className="work-source-record__grid" ref={grid}>
        {media.map((item, index) => (
          <SourceThumbnail
            key={item.id}
            workId={workId}
            media={item}
            visible={visible.has(item.id)}
            onOpen={() => setPreview(index)}
          />
        ))}
      </div>
      {preview !== null && media[preview] && (
        <SourcePreview
          workId={workId}
          media={media}
          index={preview}
          onNavigate={setPreview}
          onClose={() => setPreview(null)}
          portalContainer={portalContainer}
        />
      )}
    </>
  );
}

function SourcePreview({
  workId,
  media,
  index,
  onNavigate,
  onClose,
  portalContainer,
}: {
  workId: string;
  media: SourceMedia[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
  portalContainer: HTMLElement | null;
}) {
  const current = media[index];
  const original = useSourceImageUrl(workId, current, "original", true);
  const thumbnail = useSourceImageUrl(workId, current, "thumbnail", false);
  return (
    <ImageLightbox
      src={
        isDisplayableImageUrl(original.data?.url)
          ? original.data.url
          : undefined
      }
      thumbnailSrc={
        isDisplayableImageUrl(thumbnail.data?.url)
          ? thumbnail.data.url
          : undefined
      }
      loading={current.available && original.isPending}
      alt={`来源原图 ${current.orderIndex + 1}`}
      index={index}
      count={media.length}
      onClose={onClose}
      onPrevious={index > 0 ? () => onNavigate(index - 1) : undefined}
      onNext={
        index < media.length - 1 ? () => onNavigate(index + 1) : undefined
      }
      portalContainer={portalContainer}
    />
  );
}

function sourceLink(value: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function WorkSourceRecord({ workId }: { workId: string }) {
  return <SourceRecord key={workId} workId={workId} />;
}

function SourceRecord({ workId }: { workId: string }) {
  const user = useAccount();
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLDetailsElement>(null);
  const query = useQuery({
    queryKey: ["work-source", workId, user.id],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/works/{id}/source", {
          params: { path: { id: workId } },
          signal,
        }),
      ),
    enabled: open,
  });
  const source: Source | undefined = query.isError ? undefined : query.data;
  const sources = source
    ? source.sources?.length
      ? source.sources
      : [source]
    : [];
  const allMedia = sources.flatMap((item) => item.media);
  const adopted = allMedia.filter((media) => media.adopted === true).length;
  const unselected = allMedia.filter((media) => media.adopted === false).length;
  const usedElsewhere = allMedia.filter(
    (media) => media.disposition === "other_work",
  ).length;
  const unknown = allMedia.filter(
    (media) => media.adopted === null && media.disposition !== "other_work",
  ).length;
  return (
    <details
      ref={section}
      className="work-source-record"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <div>
          <strong>来源记录</strong>
          {source && (
            <span>
              {sources.length > 1 ? `${sources.length} 个来源 · ` : ""}原帖{" "}
              {allMedia.length} 张 · 采用 {adopted} 张 · 未采用 {unselected} 张
              {usedElsewhere > 0 ? ` · 另一作品 ${usedElsewhere} 张` : ""}
              {unknown > 0 ? ` · 未知 ${unknown} 张` : ""}
            </span>
          )}
        </div>
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      {open && (
        <div className="work-source-record__body">
          {query.isPending && <p role="status">正在读取来源记录…</p>}
          {query.isError && (
            <div className="work-source-record__error">
              <p role="alert">{query.error.message}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void query.refetch()}
              >
                重试
              </Button>
            </div>
          )}
          {sources.map((post) => {
            const url = sourceLink(post.sourceUrl);
            return (
              <section
                key={post.candidateId}
                className="work-source-record__post"
              >
                <div className="work-source-record__origin">
                  <span>
                    {post.platform.toUpperCase()} · {post.externalPostId}
                  </span>
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer">
                      查看原帖
                      <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  )}
                </div>
                {post.media.length ? (
                  <SourceImages
                    workId={workId}
                    media={post.media}
                    portalContainer={
                      section.current?.closest("dialog[open]") ?? null
                    }
                  />
                ) : (
                  <p>没有来源图片</p>
                )}
                {post.sourceText && (
                  <section className="work-source-record__text">
                    <h3>原帖文字</h3>
                    <p>{post.sourceText}</p>
                  </section>
                )}
                {post.importedSourceText &&
                  post.importedSourceText !== post.sourceText && (
                    <section className="work-source-record__text">
                      <h3>入库时的文字</h3>
                      <p>{post.importedSourceText}</p>
                    </section>
                  )}
              </section>
            );
          })}
        </div>
      )}
    </details>
  );
}
