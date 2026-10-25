import { IconButton } from "./ui";
import "./platform-links.css";

type Account = {
  platform: string;
  handle: string | null;
  externalUserId: string;
};
type Platform = "x" | "pixiv";

function PlatformIcon({ platform }: { platform: Platform }) {
  return platform === "x" ? (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.9 2h3.1l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.4l8.2-9.4L2 2h6.5l4.5 6.8L18.9 2Zm-1.1 18h1.7L7.5 4H5.7l12.1 16Z"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M5 3h7a7 7 0 0 1 0 14H9v5H5V3Zm4 4v6h3a3 3 0 0 0 0-6H9Z"
      />
    </svg>
  );
}

function PlatformEntry({
  platform,
  accounts,
}: {
  platform: Platform;
  accounts: Account[];
}) {
  const name = platform === "x" ? "X" : "Pixiv";
  const links = accounts.flatMap((account) => {
    const identity =
      platform === "x"
        ? account.handle?.replace(/^@/, "").trim()
        : account.externalUserId;
    return identity
      ? [
          {
            label: platform === "x" ? `@${identity}` : identity,
            href:
              platform === "x"
                ? `https://x.com/${encodeURIComponent(identity)}`
                : `https://www.pixiv.net/users/${encodeURIComponent(identity)}`,
          },
        ]
      : [];
  });
  const className = `platform-link platform-link--${platform}`;
  if (links.length)
    return (
      <a
        className={`ui-icon-button ui-icon-button--sm ${className}`}
        href={links[0].href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`打开 ${name} ${links[0].label}`}
        title={`打开 ${name} ${links[0].label}`}
      >
        <PlatformIcon platform={platform} />
      </a>
    );
  if (!links.length)
    return (
      <IconButton
        size="sm"
        className={className}
        disabled
        label={
          accounts.length
            ? `${name} 已关联，缺少生成链接的账号信息`
            : `未关联 ${name}`
        }
      >
        <PlatformIcon platform={platform} />
      </IconButton>
    );
}

export function PlatformLinks({ accounts }: { accounts: Account[] }) {
  return (
    <span className="platform-links" aria-label="作者平台主页">
      {(["x", "pixiv"] as const).map((platform) => (
        <PlatformEntry
          key={platform}
          platform={platform}
          accounts={accounts.filter((account) => account.platform === platform)}
        />
      ))}
    </span>
  );
}
