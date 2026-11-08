import { IconButton } from "./ui";
import { useId } from "react";
import { Pause, Power } from "lucide-react";
import "./platform-links.css";

type Account = {
  platform: string;
  handle: string | null;
  externalUserId: string;
  fetchEnabled?: boolean;
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
  variant,
  collectionBlockedReason,
}: {
  platform: Platform;
  accounts: Account[];
  variant: "icons" | "accounts";
  collectionBlockedReason?: string;
}) {
  const tooltipId = useId();
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
  if (variant === "accounts") {
    const account = accounts[0];
    const state = !account
      ? null
      : account.fetchEnabled === true
        ? "enabled"
        : account.fetchEnabled === false
          ? "disabled"
          : "unknown";
    const stateLabel =
      state === "enabled"
        ? "采集已开启"
        : state === "disabled"
          ? "采集已关闭"
          : "采集状态未知";
    const label = links[0]?.label ?? account?.externalUserId ?? "未关联";
    const warning = state === "enabled" ? collectionBlockedReason : undefined;
    const accessible = [
      links.length
        ? "打开 " + name + " " + label
        : account
          ? name + " 已关联，缺少生成链接的账号信息"
          : "未关联 " + name,
      account ? stateLabel : null,
      warning,
    ]
      .filter(Boolean)
      .join("；");
    const content = (
      <>
        <span className="platform-account-glyph">
          <PlatformIcon platform={platform} />
          {(state === "enabled" || state === "disabled") && (
            <span
              className={"platform-collection-mark is-" + state}
              aria-hidden="true"
            >
              {state === "enabled" ? <Power size={12} /> : <Pause size={12} />}
            </span>
          )}
        </span>
        <span className="platform-account-identity">{label}</span>
      </>
    );
    return (
      <span
        className={"platform-account-entry " + (!account ? "is-missing" : "")}
        tabIndex={!links.length ? 0 : undefined}
        aria-label={!links.length ? accessible : undefined}
        aria-describedby={!links.length ? tooltipId : undefined}
      >
        {links.length ? (
          <a
            className={"platform-account-link " + className}
            href={links[0].href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={accessible}
            aria-describedby={tooltipId}
          >
            {content}
          </a>
        ) : (
          <button
            type="button"
            disabled
            className={"platform-account-link " + className}
            aria-label={accessible}
          >
            {content}
          </button>
        )}
        <span
          className="platform-account-tooltip"
          role="tooltip"
          id={tooltipId}
        >
          <strong>
            {name}
            {account ? " " + label : " · 未关联"}
          </strong>
          {account && <span>{stateLabel}</span>}
          {account && !links.length && <span>缺少生成主页链接的账号信息</span>}
          {warning && (
            <span className="platform-account-warning">{warning}</span>
          )}
        </span>
      </span>
    );
  }
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

export function PlatformLinks({
  accounts,
  variant = "icons",
  collectionBlockedReason,
}: {
  accounts: Account[];
  variant?: "icons" | "accounts";
  collectionBlockedReason?: string;
}) {
  return (
    <span
      className={
        "platform-links " +
        (variant === "accounts" ? "platform-links--accounts" : "")
      }
      aria-label="作者平台主页"
    >
      {(["x", "pixiv"] as const).map((platform) => (
        <PlatformEntry
          key={platform}
          platform={platform}
          accounts={accounts.filter((account) => account.platform === platform)}
          variant={variant}
          collectionBlockedReason={collectionBlockedReason}
        />
      ))}
    </span>
  );
}
