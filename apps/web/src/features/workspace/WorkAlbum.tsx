import { groupAlbumImages } from "./work-album-data";
import { useMemo, useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Link } from "react-router";
import { Button, EmptyState } from "../../components/ui";
import { ImageLightbox } from "../../components/ImageLightbox";
import { isDisplayableImageUrl } from "../../components/media-url";
import { Feedback } from "../account/forms";
import { client, unwrap } from "../account/api";
import { SeriesImage } from "./SeriesImage";
import { useWorkImageUrl } from "./use-work-image-url";
import { ImageIcon } from "lucide-react";
import "./work-album.css";
export type AlbumImage = components["schemas"]["WorkAlbumImageDto"];
export function WorkAlbum({
  phase,
  language,
  mine,
  search,
  toolbar,
}: {
  phase?: components["schemas"]["WorkPhase"];
  language?: components["schemas"]["SourceLanguage"];
  mine: boolean;
  search: string;
  toolbar?: (workTotal?: number, imageTotal?: number) => ReactNode;
}) {
  const query = useInfiniteQuery({
    queryKey: ["works", "album", phase, language, mine, search],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      return unwrap(
        await client.GET("/api/works/album", {
          params: {
            query: {
              limit: 60,
              phase,
              sourceLanguage: language,
              mine: mine || undefined,
              search: search || undefined,
              cursor: pageParam,
            },
          },
          signal,
        }),
      );
    },
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const items = useMemo(
      () => query.data?.pages.flatMap((p) => p.items) ?? [],
      [query.data],
    ),
    groups = useMemo(() => groupAlbumImages(items), [items]),
    [preview, setPreview] = useState<string | null>(null),
    index = items.findIndex((i) => i.id === preview),
    current = items[index],
    original = useWorkImageUrl(
      current?.workId ?? "",
      current?.id,
      "original",
      Boolean(current),
    ),
    thumbnail = useWorkImageUrl(
      current?.workId ?? "",
      current?.id,
      "thumbnail",
      Boolean(current),
    );
  return (
    <>
      {toolbar?.(query.data?.pages[0]?.workTotal, query.data?.pages[0]?.total)}
      <Feedback error={query.error?.message} />
      {query.isPending && <p role="status">正在读取相册…</p>}
      {query.isSuccess && !items.length && (
        <EmptyState
          icon={<ImageIcon />}
          title="当前筛选中没有图片"
          description="调整筛选条件后再试。"
        />
      )}
      {groups.map(([date, entries]) => (
        <section className="work-album-day" key={date}>
          <div className="work-album-day-heading">
            <h3>{date}</h3>
            <span>{entries.length} 张</span>
          </div>
          <div className="work-album-grid">
            {entries.map((image) => (
              <button
                type="button"
                className="work-album-tile"
                key={image.id}
                aria-label={`${image.authorName} 作品 #${image.workNumber} 第 ${image.orderIndex + 1} / ${image.imageCount} 页`}
                onClick={() => setPreview(image.id)}
              >
                <SeriesImage workId={image.workId} imageId={image.id} />
              </button>
            ))}
          </div>
        </section>
      ))}
      {query.hasNextPage && (
        <div className="workspace-pagination">
          <Button
            variant="secondary"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            再加载 60 张图片
          </Button>
        </div>
      )}
      {current && (
        <ImageLightbox
          key={`${phase}:${language}:${mine}:${search}`}
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
          alt={`${current.workTitle || `作品 #${current.workNumber}`} 第 ${current.orderIndex + 1} 页`}
          index={index}
          count={items.length}
          loading={original.isPending}
          onClose={() => setPreview(null)}
          onPrevious={
            index > 0 ? () => setPreview(items[index - 1].id) : undefined
          }
          onNext={
            index < items.length - 1
              ? () => setPreview(items[index + 1].id)
              : undefined
          }
          footer={
            <>
              <Link to={`/works/${current.workId}`}>
                {current.workTitle || `作品 #${current.workNumber}`}
              </Link>
              <span>
                #{current.workNumber} · {current.authorName} · 第{" "}
                {current.orderIndex + 1} / {current.imageCount} 页
              </span>
            </>
          }
        />
      )}
    </>
  );
}
