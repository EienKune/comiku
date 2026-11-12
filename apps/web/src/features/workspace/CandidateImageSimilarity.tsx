import { useEffect, useRef, useState } from "react";
import type { components } from "@comiku/api-client";
import { Link } from "react-router";
import { ArrowLeft, ExternalLink, Search, X } from "lucide-react";
import { Badge, Button, IconButton } from "../../components/ui";
import { Feedback } from "../account/forms";
import { client, unwrap } from "../account/api";
import { useCandidateDialog } from "./use-candidate-dialog";
import { SeriesImage } from "./SeriesImage";
import { useWorkImageUrl } from "./use-work-image-url";
import { isDisplayableImageUrl } from "../../components/media-url";
import { reviewLabels, workflowLabels } from "./work-status";
import "./candidate-image-similarity.css";
type Match = components["schemas"]["ImageSimilarityMatchDto"];
type Result = components["schemas"]["ImageSimilarityResultDto"];
const fingerprintErrorLabels: Record<string, string> = {
  invalid_image: "当前图片无法解码，暂时只能检查文件是否相同。",
  unsupported_format: "当前图片格式不支持画面相似查询，仍可检查文件是否相同。",
  empty_image: "当前图片内容为空，无法建立画面相似指纹。",
  byte_limit: "当前图片超过相似图处理上限，暂时只能检查文件是否相同。",
  checksum_mismatch: "当前图片文件校验未通过，无法建立画面相似指纹。",
  fingerprint_read_failed: "当前图片暂时无法读取，未能建立画面相似指纹。",
  fingerprint_interrupted:
    "当前图片的指纹准备已中断，暂时只能检查文件是否相同。",
};
export function CandidateImageSimilarityAction({
  candidateId,
  mediaId,
  authorName,
  index,
  sourceUrl,
}: {
  candidateId: string;
  mediaId: string;
  authorName: string;
  index: number;
  sourceUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        leadingIcon={<Search size={16} />}
        onClick={() => setOpen(true)}
      >
        查找相似图
      </Button>
      {open && (
        <SimilarityDialog
          key={`${candidateId}:${mediaId}`}
          {...{ candidateId, mediaId, authorName, index, sourceUrl }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function SimilarityDialog({
  candidateId,
  mediaId,
  authorName,
  index,
  sourceUrl,
  onClose,
}: {
  candidateId: string;
  mediaId: string;
  authorName: string;
  index: number;
  sourceUrl?: string;
  onClose: () => void;
}) {
  const ref = useCandidateDialog(),
    [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [compare, setCompare] = useState<Match | null>(null),
    [retry, setRetry] = useState(0),
    prepared = useRef(false),
    scroll = useRef<HTMLDivElement>(null),
    savedScroll = useRef(0),
    resultRef = useRef<Result | null>(null),
    handledRetry = useRef(0);
  resultRef.current = result;
  useEffect(() => {
    if (compare) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const options = {
          params: { path: { candidateId, mediaId } },
          signal: controller.signal,
        };
        const next = await unwrap(
          prepared.current
            ? await client.GET(
                "/api/image-similarity/candidates/{candidateId}/media/{mediaId}/search",
                options,
              )
            : await client.POST(
                "/api/image-similarity/candidates/{candidateId}/media/{mediaId}/search",
                options,
              ),
        );
        if (controller.signal.aborted) return;
        prepared.current = true;
        setResult(next);
        setError("");
        if (next.state === "preparing")
          timer = setTimeout(() => void load(), 2000);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "相似图查询失败");
      }
    }
    if (
      !resultRef.current ||
      resultRef.current.state === "preparing" ||
      retry !== handledRetry.current
    ) {
      handledRetry.current = retry;
      void load();
    }
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [candidateId, mediaId, compare, retry]);
  useEffect(() => {
    if (!compare && scroll.current)
      scroll.current.scrollTop = savedScroll.current;
  }, [compare]);
  const comparison = useWorkImageUrl(
    compare?.workId ?? "",
    compare?.imageId,
    "original",
    Boolean(compare),
  );
  return (
    <dialog
      ref={ref}
      className="similarity-dialog"
      aria-label={compare ? "对照图片" : "查找相似图"}
      onCancel={(e) => {
        e.preventDefault();
        if (compare) setCompare(null);
        else onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="similarity-header">
        <div>
          <h2>{compare ? "对照图片" : "查找相似图"}</h2>
          <p>
            {authorName} · 当前第 {index + 1} 张 · 全部已入库作品
          </p>
        </div>
        <IconButton label="关闭相似图查询" onClick={onClose}>
          <X size={21} />
        </IconButton>
      </header>
      <div className="similarity-scroll" ref={scroll}>
        {compare ? (
          <div className="similarity-comparison">
            <figure>
              <figcaption>当前候选 · 第 {index + 1} 张</figcaption>
              {sourceUrl ? (
                <img src={sourceUrl} alt="当前候选原图" />
              ) : (
                <p>当前候选图片暂不可用</p>
              )}
            </figure>
            <figure>
              <figcaption>
                {compare.workTitle || `作品 #${compare.workNumber}`} · 第{" "}
                {compare.index + 1} 页
              </figcaption>
              {isDisplayableImageUrl(comparison.data?.url) ? (
                <img src={comparison.data.url} alt="历史作品原图" />
              ) : (
                <SeriesImage
                  workId={compare.workId}
                  imageId={compare.imageId}
                />
              )}
            </figure>
          </div>
        ) : (
          <div className="similarity-layout">
            <aside className="similarity-source">
              {sourceUrl && (
                <img src={sourceUrl} alt={`当前候选第 ${index + 1} 张`} />
              )}
              <strong>当前图片 · 第 {index + 1} 张</strong>
              <span>{authorName}</span>
            </aside>
            <section>
              <Feedback error={error} />
              {error && (
                <Button
                  variant="secondary"
                  onClick={() => setRetry((x) => x + 1)}
                >
                  重试查询
                </Button>
              )}
              {(!result || result.state === "preparing") && !error && (
                <p role="status">正在准备当前图片指纹…</p>
              )}
              {result && (
                <>
                  <div className="similarity-summary">
                    <strong>
                      {result.state === "failed"
                        ? "画面相似查询不可用"
                        : `找到 ${result.matches.length} 个相似结果`}
                    </strong>
                    <span>
                      已检索 {result.coverage.ready} / {result.coverage.total}{" "}
                      张
                    </span>
                  </div>
                  {result.state === "failed" && (
                    <p role="alert">
                      {fingerprintErrorLabels[result.error ?? ""] ||
                        "当前图片的指纹准备失败，暂时只能检查文件是否相同。"}
                    </p>
                  )}
                  {result.state === "partial" && (
                    <p className="similarity-hint" role="status">
                      部分图片尚未建立指纹，当前结果未覆盖全部作品（待处理{" "}
                      {result.coverage.pending} 张，失败{" "}
                      {result.coverage.failed} 张）。
                    </p>
                  )}
                  {(result.matches.length > 0 ||
                    (result.state !== "failed" &&
                      result.state !== "preparing")) && (
                    <>
                      <p className="similarity-hint">
                        画面相近仍可能是对白差分，请对照确认。
                      </p>
                      <div className="similarity-matches">
                        {result.matches.map((match) => (
                          <article
                            className="similarity-match"
                            key={`${match.workId}:${match.imageId}`}
                          >
                            <button
                              type="button"
                              className="similarity-match-image"
                              aria-label={`对照 ${match.workTitle || `作品 #${match.workNumber}`} 第 ${match.index + 1} 页`}
                              onClick={() => {
                                savedScroll.current =
                                  scroll.current?.scrollTop ?? 0;
                                setCompare(match);
                              }}
                            >
                              <SeriesImage
                                workId={match.workId}
                                imageId={match.imageId}
                              />
                            </button>
                            <div>
                              <Link
                                to={`/works/${match.workId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {match.workTitle || `作品 #${match.workNumber}`}
                              </Link>
                              <span>
                                #{match.workNumber} · 第 {match.index + 1} /{" "}
                                {match.imageCount} 页
                              </span>
                              <span>{match.authorName}</span>
                              <div className="similarity-badges">
                                <Badge
                                  tone={
                                    match.matchKind === "exact"
                                      ? "success"
                                      : "info"
                                  }
                                >
                                  {match.matchKind === "exact"
                                    ? "文件相同"
                                    : "画面相近"}
                                </Badge>
                                <Badge>
                                  {workflowLabels[match.workflowStatus]}
                                </Badge>
                                {match.reviewStatus !== "normal" && (
                                  <Badge tone="warning">
                                    {reviewLabels[match.reviewStatus]}
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                      {!result.matches.length && (
                        <p>
                          {result.state === "partial"
                            ? "已覆盖的图片中未找到相似结果。"
                            : "未找到相似图片。"}
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
      <footer className="similarity-footer">
        <Button
          type="button"
          variant="secondary"
          leadingIcon={<ArrowLeft size={16} />}
          onClick={() => (compare ? setCompare(null) : onClose())}
        >
          {compare ? "返回相似结果" : "返回图片"}
        </Button>
        {compare ? (
          <Link
            className="account-link"
            to={`/works/${compare.workId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看作品 <ExternalLink size={15} />
          </Link>
        ) : (
          <span>查询不会修改候选状态或选图。</span>
        )}
      </footer>
    </dialog>
  );
}
