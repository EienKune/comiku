import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { components } from "@comiku/api-client";
import { Badge, Button, Surface } from "../../components/ui";
import { PlatformIcon } from "../../components/PlatformIcon";
import { client, unwrap } from "../account/api";
import {
  SourceCredentialDialog,
  type CredentialIntent,
} from "./SourceCredentialDialog";
import "../../components/platform-links.css";
import "./system.css";

type PlatformState = components["schemas"]["SourcePlatformStateDto"];
const adapters: Record<string, string> = {
  x_gallery_dl: "gallery-dl",
  pixiv_gallery_dl: "gallery-dl",
  x_web_session: "网页会话",
  x_official_v2: "官方 API",
};
const statuses = {
  healthy: { label: "正常", tone: "success" },
  auth_paused: { label: "认证暂停", tone: "danger" },
  cooling_down: { label: "冷却中", tone: "warning" },
  unverified: { label: "待验证", tone: "neutral" },
} as const;
function statusOf(
  state: PlatformState | undefined,
  configured: boolean,
  available: boolean,
  failed: boolean,
  loading: boolean,
) {
  if (failed) return { label: "状态读取失败", tone: "warning" } as const;
  if (loading) return { label: "读取中", tone: "neutral" } as const;
  if (state?.maintenancePaused)
    return { label: "维护中", tone: "warning" } as const;
  if (!configured) return { label: "未配置", tone: "neutral" } as const;
  if (!available) return { label: "接入不可用", tone: "warning" } as const;
  if (!state) return statuses.unverified;
  return (
    statuses[state.status as keyof typeof statuses] ??
    ({ label: "状态未知", tone: "neutral" } as const)
  );
}
function stateDetail(state: PlatformState | undefined) {
  if (state?.maintenancePaused) return "平台已暂停，关闭凭据窗口后仍保持维护。";
  if (state?.status === "auth_paused")
    return state.errorCode === "challenge_required"
      ? "平台要求验证登录，请处理后重新验证。"
      : "平台认证未通过，请更新凭据后验证。";
  if (state?.status === "unverified") return "等待下次同步验证凭据。";
  if (state?.status !== "cooling_down") return null;
  const until = state.cooldownUntil && new Date(state.cooldownUntil);
  if (!until || !Number.isFinite(until.getTime()))
    return "平台请求受限，等待恢复。";
  return until.getTime() > Date.now() ? (
    <>
      请求受限，预计{" "}
      <time dateTime={state.cooldownUntil!}>{until.toLocaleString()}</time>{" "}
      后恢复。
    </>
  ) : (
    "冷却已结束，等待下次同步恢复。"
  );
}

export function SourceConnections({ enabled = true }: { enabled?: boolean }) {
  const [selected, setSelected] = useState<"x" | "pixiv" | null>(null);
  // Only opaque recovery intent survives a dialog close; credentials never leave it.
  const intents = useRef<Partial<Record<"x" | "pixiv", CredentialIntent>>>({});
  const sources = useQuery({
    queryKey: ["source-capabilities"],
    enabled,
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/authors/sources", { signal })),
  });
  const platforms = useQuery({
    queryKey: ["source-platforms"],
    enabled,
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/source-fetch/platforms", { signal })),
    refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
  return (
    <Surface className="system-connections">
      <header className="system-history-heading">
        <h2>图源接入</h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="刷新平台状态"
          leadingIcon={<RefreshCw size={15} />}
          disabled={!enabled}
          loading={sources.isFetching || platforms.isFetching}
          onClick={() =>
            void Promise.allSettled([sources.refetch(), platforms.refetch()])
          }
        >
          刷新
        </Button>
      </header>
      {sources.isPending ? (
        <p role="status">正在读取接入配置…</p>
      ) : sources.isError ? (
        <p className="system-connections-error" role="alert">
          接入配置读取失败，请刷新重试。
        </p>
      ) : null}
      {platforms.isError && (
        <p className="system-connections-error" role="alert">
          平台状态读取失败，请刷新重试。
        </p>
      )}
      <div className="system-connection-grid">
        {(["x", "pixiv"] as const).map((platform) => {
          const name = platform === "x" ? "X" : "Pixiv";
          const source =
            sources.data?.find(
              (item) => item.platform === platform && item.available,
            ) ?? sources.data?.find((item) => item.platform === platform);
          const state = platforms.data?.find(
            (item) => item.platform === platform,
          );
          const badge = statusOf(
            state,
            !!source,
            !!source?.available,
            sources.isError || platforms.isError,
            sources.isPending || platforms.isPending,
          );
          const detail =
            source?.available &&
            !sources.isError &&
            !platforms.isError &&
            !platforms.isPending
              ? stateDetail(state)
              : null;
          return (
            <article
              className="system-connection-card"
              aria-label={`${name} 图源接入`}
              key={platform}
            >
              <div className="system-connection-card-header">
                <span
                  className={`system-connection-icon platform-link--${platform}`}
                >
                  <PlatformIcon platform={platform} size={26} />
                </span>
                <div className="system-connection-identity">
                  <h3>{name}</h3>
                  {source && (
                    <span>
                      {adapters[source.adapterKey] ?? source.adapterKey}
                    </span>
                  )}
                </div>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </div>
              {detail && <p className="system-connection-detail">{detail}</p>}
              <div className="source-connection-actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!enabled}
                  aria-label={`管理 ${name} 凭据`}
                  onClick={() => setSelected(platform)}
                >
                  管理凭据
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {selected && enabled && (
        <SourceCredentialDialog
          key={selected}
          platform={selected}
          recoveryIntent={intents.current[selected]}
          onIntentChange={(intent) => {
            intents.current[selected] = intent ?? undefined;
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </Surface>
  );
}
