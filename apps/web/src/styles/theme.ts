export type ThemeStyle = "soft" | "minimal";
export interface ThemePreference {
  brand: string;
  style: ThemeStyle;
}
export const defaultTheme: ThemePreference = {
  brand: "#33ccbb",
  style: "soft",
};
export const themePresets = [
  { name: "青绿", brand: "#33ccbb", style: "soft" },
  { name: "晴蓝", brand: "#5599ff", style: "soft" },
  { name: "淡紫", brand: "#a78bfa", style: "soft" },
  { name: "樱粉", brand: "#ff6699", style: "soft" },
  { name: "琥珀", brand: "#f6ba4c", style: "soft" },
  { name: "黑白极简", brand: "#171717", style: "minimal" },
] satisfies (ThemePreference & { name: string })[];

export const themeStorageKey = "comiku.playground.theme.v1";
export const isHexColor = (value: string) => /^#[a-f\d]{6}$/i.test(value);
export function readTheme(value: string | null): ThemePreference {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (
      parsed &&
      typeof parsed === "object" &&
      "brand" in parsed &&
      "style" in parsed &&
      typeof parsed.brand === "string" &&
      isHexColor(parsed.brand) &&
      (parsed.style === "soft" || parsed.style === "minimal")
    ) {
      return { brand: parsed.brand.toLowerCase(), style: parsed.style };
    }
  } catch {
    /* Invalid local preferences fall back to the default. */
  }
  return { ...defaultTheme };
}
type RGB = readonly [number, number, number];
function rgb(hex: string): RGB {
  if (!isHexColor(hex))
    throw new Error("Expected an opaque six-digit HEX color");
  return [1, 3, 5].map((i) =>
    parseInt(hex.slice(i, i + 2), 16),
  ) as unknown as RGB;
}
function luminance(color: RGB) {
  const values = color
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function ratio(a: RGB, b: RGB) {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}
function foreground(bg: RGB) {
  const black = ratio(bg, [0, 0, 0]);
  const white = ratio(bg, [255, 255, 255]);
  return black >= white
    ? { color: "#000000", contrast: black }
    : { color: "#ffffff", contrast: white };
}
export function brandReadability(brand: string) {
  const base = rgb(brand);
  // Match the CSS sRGB brand-400 mix without rounding channel values.
  const hover = base.map(
    (channel) => channel * 0.82 + 255 * 0.18,
  ) as unknown as RGB;
  return { normal: foreground(base), hover: foreground(hover) };
}

export function applyTheme(theme: ThemePreference) {
  const root = document.documentElement;
  const contrast = brandReadability(theme.brand);
  root.style.setProperty("--color-brand", theme.brand);
  root.style.setProperty("--color-on-brand", contrast.normal.color);
  root.style.setProperty("--color-on-brand-hover", contrast.hover.color);
  root.dataset.themeStyle = theme.style;
  try {
    localStorage.setItem(themeStorageKey, JSON.stringify(theme));
  } catch {
    /* The active theme remains usable when browser storage is unavailable. */
  }
}
