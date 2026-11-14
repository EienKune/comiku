import {
  defaultTheme,
  isHexColor,
  readTheme,
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
    (value.style === "soft" || value.style === "minimal")
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
      return { mode: "custom", theme: readTheme(JSON.stringify(parsed.theme)) };
  } catch {
    /* Try the legacy value. */
  }
  try {
    if (valid(JSON.parse(v1 ?? "null")))
      return { mode: "custom", theme: readTheme(v1) };
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
) => (selection.mode === "custom" ? selection.theme : site);
export function siteTheme(id: string): ThemePreference {
  const preset = themePresets.find((p) => p.id === id) ?? defaultTheme;
  return { brand: preset.brand, style: preset.style };
}
