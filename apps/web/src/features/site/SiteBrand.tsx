import { useState } from "react";
import { BookOpen, Sparkles } from "lucide-react";
import { useSite } from "./site-context";
import { siteIconUrl } from "./site-config";
import "./site.css";
export function SiteBrand({
  variant = "auth",
}: {
  variant?: "auth" | "sidebar";
}) {
  const { settings } = useSite();
  const [failedVersion, setFailedVersion] = useState<string>();
  const showImage =
    settings.iconVersion && settings.iconVersion !== failedVersion;
  const image = showImage ? (
    <img
      className="site-brand-image"
      src={siteIconUrl(settings.iconVersion!)}
      alt=""
      onError={() => setFailedVersion(settings.iconVersion!)}
    />
  ) : null;
  if (variant === "auth")
    return (
      <>
        {image ?? <BookOpen aria-hidden="true" />}
        <span className="site-brand-name">{settings.name}</span>
      </>
    );
  return (
    <>
      <span className="workspace-brand-mark" aria-hidden="true">
        {image ?? (
          <>
            <span>C</span>
            <Sparkles size={10} />
          </>
        )}
      </span>
      <span className="workspace-brand-copy">
        <strong>{settings.name}</strong>
        <small>Workspace</small>
      </span>
    </>
  );
}
