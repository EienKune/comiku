import "./series-image.css";
import { useEffect, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import { useWorkImageUrl } from "./use-work-image-url";
import { isDisplayableImageUrl } from "../../components/media-url";
export function SeriesImage({
  workId,
  imageId,
}: {
  workId: string;
  imageId: string | null | undefined;
}) {
  const ref = useRef<HTMLSpanElement>(null),
    [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "100px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const q = useWorkImageUrl(workId, imageId ?? undefined, "thumbnail", visible);
  return (
    <span ref={ref} className="series-image">
      {isDisplayableImageUrl(q.data?.url) ? (
        <img src={q.data.url} alt="" loading="lazy" />
      ) : (
        <ImageIcon aria-hidden="true" />
      )}
    </span>
  );
}
