import {
  baThemeStyles,
  isBAThemeStyle,
  themeProfileTokens,
  type BAThemeStyle,
} from "./theme-profiles";
export type ThemeStyle = "soft" | "minimal" | BAThemeStyle;
export function isThemeStyle(value: unknown): value is ThemeStyle {
  return value === "soft" || value === "minimal" || isBAThemeStyle(value);
}
export interface ThemePreference {
  brand: string;
  style: ThemeStyle;
}
export const defaultTheme: ThemePreference = {
  brand: "#33ccbb",
  style: "soft",
};
export const themePresets = [
  { id: "teal", name: "青绿", brand: "#33ccbb", style: "soft" },
  { id: "sky", name: "晴蓝", brand: "#5599ff", style: "soft" },
  { id: "lavender", name: "淡紫", brand: "#a78bfa", style: "soft" },
  { id: "pink", name: "樱粉", brand: "#ff6699", style: "soft" },
  { id: "amber", name: "琥珀", brand: "#f6ba4c", style: "soft" },
  { id: "minimal", name: "黑白极简", brand: "#171717", style: "minimal" },
  { id: "schale", name: "夏莱终端", brand: "#128afa", style: "schale" },
  { id: "archive", name: "古书馆图册", brand: "#263473", style: "archive" },
  { id: "shittim", name: "什亭工作台", brand: "#2b95f0", style: "shittim" },
  { id: "arona", name: "阿罗娜", brand: "#82cbe8", style: "arona" },
  { id: "plana", name: "普拉娜", brand: "#dd79a7", style: "plana" },
  {
    id: "shittim-duo",
    name: "什亭双人",
    brand: "#82cbe8",
    style: "shittim-duo",
  },
  { id: "ba-cyan", name: "BA 青蓝白", brand: "#00d7fb", style: "ba-cyan" },
  { id: "ba-azure", name: "BA 亮蓝炭灰", brand: "#128afa", style: "ba-azure" },
] satisfies (ThemePreference & { name: string; id: string })[];

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
      isThemeStyle(parsed.style)
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

export function themeReadability(theme: ThemePreference) {
  if (!isBAThemeStyle(theme.style)) return brandReadability(theme.brand);
  const tokens = themeProfileTokens[theme.style];
  return {
    normal: {
      color: tokens["--ba-action-text"],
      contrast: ratio(
        rgb(tokens["--ba-action-bg"]),
        rgb(tokens["--ba-action-text"]),
      ),
    },
    hover: {
      color: tokens["--ba-action-text-hover"],
      contrast: ratio(
        rgb(tokens["--ba-action-hover"]),
        rgb(tokens["--ba-action-text-hover"]),
      ),
    },
  };
}
const ownedKeys = [
  ...new Set([
    "--color-brand",
    "--color-on-brand",
    "--color-on-brand-hover",
    ...baThemeStyles.flatMap((style) => Object.keys(themeProfileTokens[style])),
  ]),
];
function applyRoot(root: HTMLElement, theme: ThemePreference) {
  const contrast = brandReadability(theme.brand);
  const values: Record<string, string> = {
    "--color-brand": theme.brand,
    "--color-on-brand": contrast.normal.color,
    "--color-on-brand-hover": contrast.hover.color,
    ...(isBAThemeStyle(theme.style) ? themeProfileTokens[theme.style] : {}),
  };
  for (const key of ownedKeys) {
    if (key in values) root.style.setProperty(key, values[key]);
    else root.style.removeProperty(key);
  }
  root.dataset.themeStyle = theme.style;
}
export function mountTheme(root: HTMLElement, theme: ThemePreference) {
  const before = ownedKeys.map((key) => ({
    key,
    value: root.style.getPropertyValue(key),
    priority: root.style.getPropertyPriority(key),
  }));
  const previousStyle = root.getAttribute("data-theme-style");
  const hadStyle = root.hasAttribute("style");
  applyRoot(root, theme);
  return () => {
    for (const { key, value, priority } of before) {
      if (value) root.style.setProperty(key, value, priority);
      else root.style.removeProperty(key);
    }
    if (previousStyle === null) root.removeAttribute("data-theme-style");
    else root.setAttribute("data-theme-style", previousStyle);
    if (!hadStyle && !root.style.length) root.removeAttribute("style");
  };
}
export function applyTheme(
  theme: ThemePreference,
  options: { persist?: boolean } = {},
) {
  applyRoot(document.documentElement, theme);
  try {
    if (options.persist !== false)
      localStorage.setItem(themeStorageKey, JSON.stringify(theme));
  } catch {
    /* The active theme remains usable when storage is unavailable. */
  }
}
