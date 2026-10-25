import { useState } from "react";
import "./avatar.css";

export function Avatar({
  name,
  src,
  size = "md",
  onError,
}: {
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  onError?: () => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span
      className={`ui-avatar ui-avatar--${size}`}
      aria-label={`${name}的头像`}
      role="img"
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          onError={() => {
            setFailedSrc(src);
            onError?.();
          }}
        />
      ) : (
        name.trim().slice(0, 1) || "?"
      )}
    </span>
  );
}
