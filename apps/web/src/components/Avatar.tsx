import { useState } from "react";
import "./avatar.css";

const initials = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function Avatar({
  name,
  src,
  size = "md",
  onError,
  className = "",
  loading,
}: {
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  onError?: () => void;
  className?: string;
  loading?: "eager" | "lazy";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span
      className={`ui-avatar ui-avatar--${size} ${className}`}
      aria-label={name.trim() ? `${name}的头像` : "头像"}
      role="img"
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          loading={loading}
          onError={() => {
            setFailedSrc(src);
            onError?.();
          }}
        />
      ) : (
        initials.segment(name.trim())[Symbol.iterator]().next().value
          ?.segment || "?"
      )}
    </span>
  );
}
