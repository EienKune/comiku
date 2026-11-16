import type { components } from "@comiku/api-client";
import { apiBaseUrl, client, unwrap, publicSiteQueryKey } from "../account/api";
import { themeCatalog, type ThemeCatalog } from "@comiku/theme-catalog";
export type SiteSettings = components["schemas"]["SiteSettingsDto"];
export const defaultSite: SiteSettings = {
  name: "Comiku",
  themePresetId: "teal",
  iconVersion: null,
  revision: 0,
};
export const siteQueryKey = publicSiteQueryKey;
export const siteCacheKey = "comiku.site.v1";
type SitePayload = Omit<SiteSettings, "themePresetId"> & {
  themePresetId: string;
};
export function validSite(value: unknown): value is SitePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as SitePayload;
  return (
    typeof v.name === "string" &&
    !!v.name.trim() &&
    [...v.name].length <= 64 &&
    !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(v.name) &&
    typeof v.themePresetId === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(v.themePresetId) &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    (v.iconVersion === null ||
      (typeof v.iconVersion === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          v.iconVersion,
        )))
  );
}
export function presentSite(
  value: unknown,
  catalog: ThemeCatalog = themeCatalog,
): SiteSettings | undefined {
  if (!validSite(value)) return undefined;
  return {
    name: value.name,
    iconVersion: value.iconVersion,
    revision: value.revision,
    themePresetId: catalog.resolvePresetId(
      value.themePresetId,
    ) as SiteSettings["themePresetId"],
  };
}
export function readCachedSite(): SiteSettings | undefined {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(siteCacheKey) ?? "null",
    );
    return presentSite(saved);
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
  const settings = presentSite(value);
  if (!settings) throw new Error("站点设置暂不可用");
  return settings;
}
export const siteIconUrl = (version: string, size: 32 | 256 = 256) =>
  `${apiBaseUrl}/api/site/icon/${encodeURIComponent(version)}/${size}`;
