import { BadRequestException } from "@nestjs/common";

export const siteThemePresetIds = [
  "teal",
  "sky",
  "lavender",
  "pink",
  "amber",
  "minimal",
] as const;
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
