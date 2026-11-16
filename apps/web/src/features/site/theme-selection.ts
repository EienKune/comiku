import {
  defaultTheme,
  isHexColor,
  isThemeStyle,
  themePresets,
  themeStorageKey,
  applyTheme,
  type ThemePreference,
} from "../../styles/theme";
export type ThemeSelection =
  { mode: "site" } | { mode: "custom"; theme: ThemePreference };
export const themeSelectionKey = "comiku.theme.selection.v2";
export const previewThemeStorageKey = "comiku.playground.preview.v1";
function valid(value: unknown): value is ThemePreference {
  return (
    !!value &&
    typeof value === "object" &&
    "brand" in value &&
    typeof value.brand === "string" &&
    isHexColor(value.brand) &&
    "style" in value &&
    typeof value.style === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(value.style)
  );
}
export function readThemeSelection(
  v2: string | null,
  v1: string | null,
): ThemeSelection {
  try {
    const parsed = JSON.parse(v2 ?? "null");
    if (parsed?.mode === "site") return { mode: "site" };
    if (parsed?.mode === "custom" && valid(parsed.theme))
      return {
        mode: "custom",
        theme: {
          brand: parsed.theme.brand.toLowerCase(),
          style: parsed.theme.style,
        },
      };
  } catch {
    /* Try the legacy value. */
  }
  try {
    const parsed: unknown = JSON.parse(v1 ?? "null");
    if (valid(parsed))
      return {
        mode: "custom",
        theme: { brand: parsed.brand.toLowerCase(), style: parsed.style },
      };
  } catch {
    /* Follow the site. */
  }
  return { mode: "site" };
}
export function loadThemeSelection(): ThemeSelection {
  try {
    return readThemeSelection(
      localStorage.getItem(themeSelectionKey),
      localStorage.getItem(themeStorageKey),
    );
  } catch {
    return { mode: "site" };
  }
}
export function persistThemeSelection(selection: ThemeSelection) {
  try {
    localStorage.setItem(themeSelectionKey, JSON.stringify(selection));
  } catch {
    /* Session-only selection. */
  }
  if (selection.mode === "custom") applyTheme(selection.theme);
}
export const resolveTheme = (
  selection: ThemeSelection,
  site: ThemePreference,
  hasStyle: (style: unknown) => boolean = isThemeStyle,
) =>
  selection.mode === "custom" && hasStyle(selection.theme.style)
    ? selection.theme
    : site;
export function siteTheme(id: string): ThemePreference {
  const preset = themePresets.find((p) => p.id === id) ?? defaultTheme;
  return { brand: preset.brand, style: preset.style };
}
