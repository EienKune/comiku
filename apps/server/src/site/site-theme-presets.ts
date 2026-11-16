import { themeCatalog } from "@comiku/theme-catalog";
import { BadRequestException } from "@nestjs/common";

export const siteThemePresetIds = themeCatalog.presetIds;
export type SiteThemePresetId = (typeof siteThemePresetIds)[number];
export function normalizeSiteName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    [...name].length > 64 ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name)
  )
    throw new BadRequestException("站点名称应为 1–64 个字符，不能包含控制字符");
  return name;
}
