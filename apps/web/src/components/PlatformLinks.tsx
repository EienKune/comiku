import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Power } from "lucide-react";
import { IconButton } from "./ui";
import { PlatformIcon, type Platform } from "./PlatformIcon";
import "./platform-links.css";

export type PlatformAccount = {
  id?: string;
  platform: string;
  handle: string | null;
  externalUserId: string;
  fetchEnabled?: boolean;
  deletedAt?: string | null;
};
const platformName = (platform: Platform) => (platform === "x" ? "X" : "Pixiv");
function identity(account: PlatformAccount) {
  const value =
    account.platform === "x"
      ? account.handle?.replace(/^@/, "").trim()
      : account.externalUserId.trim();
  return {
    label: value
      ? account.platform === "x"
        ? `@${value}`
        : value
      : account.externalUserId || "缺少账号信息",
    href: value
      ? account.platform === "x"
        ? `https://x.com/${encodeURIComponent(value)}`
        : `https://www.pixiv.net/users/${encodeURIComponent(value)}`
      : null,
  };
}
function AccountChip({
  account,
  blocked,
  measure = false,
}: {
  account: PlatformAccount;
  blocked?: string;
  measure?: boolean;
}) {
  const { label, href } = identity(account);
  const name = platformName(account.platform as Platform);
  const state =
    account.fetchEnabled === true
      ? "采集已开启"
      : account.fetchEnabled === false
        ? "采集已关闭"
        : "采集状态未知";
  const accessible = [
    href ? `打开 ${name} ${label}` : `${name} 已关联，缺少生成链接的账号信息`,
    state,
    account.fetchEnabled ? blocked : null,
  ]
    .filter(Boolean)
    .join("；");
  const content = (
    <>
      <span
        className="platform-account-identity"
        data-measure-label={measure ? label : undefined}
      >
        {measure ? null : label}
      </span>
      {account.fetchEnabled !== undefined && (
        <span
          className={`platform-collection-mark is-${account.fetchEnabled ? "enabled" : "disabled"}`}
          aria-hidden="true"
        >
          {account.fetchEnabled ? <Power size={12} /> : <Pause size={12} />}
        </span>
      )}
    </>
  );
  if (measure) return <span className="platform-account-link">{content}</span>;
  return href ? (
    <a
      className="platform-account-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={accessible}
      title={accessible}
    >
      {content}
    </a>
  ) : (
    <button
      type="button"
      disabled
      className="platform-account-link"
      aria-label={accessible}
      title={accessible}
    >
      {content}
    </button>
  );
}
function PlatformEntry({
  platform,
  accounts,
  variant,
  collectionBlockedReason,
}: {
  platform: Platform;
  accounts: PlatformAccount[];
  variant: "icons" | "accounts";
  collectionBlockedReason?: string;
}) {
  const name = platformName(platform);
  const root = useRef<HTMLSpanElement>(null);
  const rail = useRef<HTMLSpanElement>(null);
  const measurement = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const [count, setCount] = useState(3);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (variant !== "accounts") return;
    const measure = () => {
      const width = rail.current?.getBoundingClientRect().width ?? 0;
      if (!width || !measurement.current) return;
      const gap =
        Number.parseFloat(getComputedStyle(rail.current!).columnGap) || 4;
      const moreWidth =
        measurement.current
          .querySelector<HTMLElement>("[data-more-measure]")
          ?.getBoundingClientRect().width ?? 36;
      const chipMax = Math.max(
        32,
        Math.min(160, width - (accounts.length > 1 ? moreWidth + gap + 1 : 0)),
      );
      root.current?.style.setProperty("--platform-account-max", `${chipMax}px`);
      const widths = Array.from(
        measurement.current.querySelectorAll<HTMLElement>(
          "[data-account-measure]",
        ),
        (node) => Math.min(node.getBoundingClientRect().width, chipMax),
      );
      let used = 0,
        next = 0;
      for (let i = 0; i < widths.length; i++) {
        const extra = i < widths.length - 1 ? moreWidth + gap : 0;
        if (used + widths[i] + extra > width) break;
        used += widths[i] + gap;
        next++;
      }
      setCount(next);
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (rail.current) observer?.observe(rail.current);
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [accounts, variant]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect(),
        rect = popup.current?.getBoundingClientRect();
      if (!anchor || !rect) return;
      setPosition({
        left: Math.max(
          12,
          Math.min(anchor.left, window.innerWidth - rect.width - 12),
        ),
        top:
          anchor.bottom + rect.height + 8 <= window.innerHeight - 12
            ? anchor.bottom + 8
            : Math.max(12, anchor.top - rect.height - 8),
      });
    };
    update();
    popup.current
      ?.querySelector<HTMLElement>("a, button:not(:disabled)")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);
  const className = `platform-link platform-link--${platform}`;
  const toggle = (content: React.ReactNode, icon = false) => (
    <button
      ref={trigger}
      type="button"
      className={
        icon
          ? `ui-icon-button ui-icon-button--sm ${className}`
          : "platform-account-more"
      }
      aria-label={`查看全部 ${name} 账号（${accounts.length}）`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      {content}
    </button>
  );
  const single = accounts[0] && identity(accounts[0]);
  return (
    <span
      ref={root}
      className={`platform-account-entry ${className}${!accounts.length ? " is-missing" : ""}`}
    >
      {variant === "icons" ? (
        accounts.length > 1 ? (
          toggle(<PlatformIcon platform={platform} />, true)
        ) : single?.href ? (
          <a
            className={`ui-icon-button ui-icon-button--sm ${className}`}
            href={single.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`打开 ${name} ${single.label}`}
            title={`打开 ${name} ${single.label}`}
          >
            <PlatformIcon platform={platform} />
          </a>
        ) : (
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
        )
      ) : (
        <>
          <span className="platform-account-glyph" aria-hidden="true">
            <PlatformIcon platform={platform} />
          </span>
          <span ref={rail} className="platform-account-rail">
            {!accounts.length ? (
              <button
                type="button"
                disabled
                className="platform-account-link"
                aria-label={`未关联 ${name}`}
              >
                未关联
              </button>
            ) : (
              accounts
                .slice(0, count)
                .map((account, i) => (
                  <AccountChip
                    key={account.id ?? i}
                    account={account}
                    blocked={collectionBlockedReason}
                  />
                ))
            )}
            {accounts.length > count && toggle(`+${accounts.length - count}`)}
          </span>
          <span
            ref={measurement}
            className="platform-account-measure"
            aria-hidden="true"
            inert
          >
            {accounts.map((account, i) => (
              <span key={account.id ?? i} data-account-measure>
                <AccountChip account={account} measure />
              </span>
            ))}
            <span data-more-measure className="platform-account-more">
              +{accounts.length}
            </span>
          </span>
        </>
      )}
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="dialog"
            aria-label={`${name} 账号`}
            className={`platform-account-popover ${className}`}
            style={position}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                !root.current?.contains(event.relatedTarget as Node)
              )
                close();
            }}
          >
            <header>
              <strong>{name} 账号</strong>
              <button
                type="button"
                className="platform-account-more"
                onClick={() => close(true)}
              >
                关闭
              </button>
            </header>
            <ul>
              {accounts.map((account, i) => (
                <li key={account.id ?? i}>
                  <AccountChip
                    account={account}
                    blocked={collectionBlockedReason}
                  />
                </li>
              ))}
            </ul>
            {collectionBlockedReason && <p>{collectionBlockedReason}</p>}
          </div>,
          document.body,
        )}
    </span>
  );
}
export function PlatformLinks({
  accounts,
  variant = "icons",
  collectionBlockedReason,
}: {
  accounts: PlatformAccount[];
  variant?: "icons" | "accounts";
  collectionBlockedReason?: string;
}) {
  return (
    <span
      className={`platform-links ${variant === "accounts" ? "platform-links--accounts" : ""}`}
      aria-label="作者平台主页"
    >
      {(["x", "pixiv"] as const).map((platform) => (
        <PlatformEntry
          key={platform}
          platform={platform}
          accounts={accounts.filter(
            (account) => account.platform === platform && !account.deletedAt,
          )}
          variant={variant}
          collectionBlockedReason={collectionBlockedReason}
        />
      ))}
    </span>
  );
}
