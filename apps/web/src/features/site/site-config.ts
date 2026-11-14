import type { components } from "@comiku/api-client";
import { apiBaseUrl, client, unwrap, publicSiteQueryKey } from "../account/api";
import { themePresets } from "../../styles/theme";
export type SiteSettings = components["schemas"]["SiteSettingsDto"];
export const defaultSite: SiteSettings = {
  name: "Comiku",
  themePresetId: "teal",
  iconVersion: null,
  revision: 0,
};
export const siteQueryKey = publicSiteQueryKey;
export const siteCacheKey = "comiku.site.v1";
export function validSite(value: unknown): value is SiteSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as SiteSettings;
  return (
    typeof v.name === "string" &&
    !!v.name.trim() &&
    [...v.name].length <= 64 &&
    !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(v.name) &&
    themePresets.some((p) => p.id === v.themePresetId) &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    (v.iconVersion === null ||
      (typeof v.iconVersion === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          v.iconVersion,
        )))
  );
}
export function readCachedSite(): SiteSettings | undefined {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(siteCacheKey) ?? "null",
    );
    return validSite(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}
export async function fetchSite(signal: AbortSignal): Promise<SiteSettings> {
  const timeout = AbortSignal.timeout(10_000);
  const value = await unwrap(
    await client.GET("/api/site", {
      signal: AbortSignal.any([signal, timeout]),
    }),
  );
  if (!validSite(value)) throw new Error("站点设置暂不可用");
  return value;
}
export const siteIconUrl = (version: string, size: 32 | 256 = 256) =>
  `${apiBaseUrl}/api/site/icon/${encodeURIComponent(version)}/${size}`;
