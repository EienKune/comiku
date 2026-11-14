const roundedTokens = {
  "--radius-button": "999px",
  "--radius-sm": "10px",
  "--radius-md": "14px",
  "--radius-lg": "18px",
  "--radius-xl": "24px",
  "--radius-pill": "999px",
  "--ba-marker-text": "#1c2f46",
};

const palette: Record<BAThemeStyle, Record<string, string>> = {
  schale: {
    "--color-canvas": "#f4faff",
    "--color-surface-soft": "#edf8ff",
    "--color-surface-muted": "#e6f2fb",
    "--color-border": "#d7e6f2",
    "--color-border-strong": "#aec5d8",
    "--color-text": "#2c4c72",
    "--color-text-soft": "#48657f",
    "--color-text-muted": "#5a6f83",
    "--color-decor-soft": "#f4faff",
    "--color-decor-tint": "#ddf5ff",
    "--color-decor-accent": "#00b7e5",
    "--color-decor-text": "#0067ad",
    "--color-decor-cool": "#d4f4fc",
    "--color-decor-cool-text": "#006784",
    "--ba-action-bg": "#80d8f5",
    "--ba-action-hover": "#a2e7fa",
    "--ba-action-text": "#173d57",
    "--ba-action-text-hover": "#173d57",
    "--ba-action-border": "#397b98",
    "--page-background": "linear-gradient(125deg, #f4faff 64%, #e3f5ff)",
  },
  archive: {
    "--color-canvas": "#eff7fa",
    "--color-surface-soft": "#f4f9fb",
    "--color-surface-muted": "#e8f0f5",
    "--color-border": "#dae3ec",
    "--color-border-strong": "#a9b8cb",
    "--color-text": "#303c50",
    "--color-text-soft": "#4c5b6f",
    "--color-text-muted": "#606d80",
    "--color-decor-soft": "#f2f8fb",
    "--color-decor-tint": "#dff4fc",
    "--color-decor-accent": "#2886ad",
    "--color-decor-text": "#263473",
    "--color-decor-cool": "#d8e5ef",
    "--color-decor-cool-text": "#405c78",
    "--ba-action-bg": "#263473",
    "--ba-action-hover": "#334685",
    "--ba-action-text": "#ffffff",
    "--ba-action-text-hover": "#ffffff",
    "--ba-action-border": "#263473",
    "--page-background":
      "linear-gradient(180deg, #dff4fc 0, #eff7fa 28rem, #f7fafc 65rem)",
  },
  shittim: {
    "--color-canvas": "#e9f4fb",
    "--color-surface-soft": "#f5f8fb",
    "--color-surface-muted": "#edf3f8",
    "--color-border": "#dfe8f1",
    "--color-border-strong": "#a7bfd3",
    "--color-text": "#24364b",
    "--color-text-soft": "#42566b",
    "--color-text-muted": "#5f6f86",
    "--color-decor-soft": "#f4f9fd",
    "--color-decor-tint": "#eaf5fe",
    "--color-decor-accent": "#2b95f0",
    "--color-decor-text": "#196cba",
    "--color-decor-cool": "#e3f0fa",
    "--color-decor-cool-text": "#246c99",
    "--ba-action-bg": "#1b74c8",
    "--ba-action-hover": "#155fa8",
    "--ba-action-text": "#ffffff",
    "--ba-action-text-hover": "#ffffff",
    "--ba-action-border": "#1b74c8",
    "--page-background": "linear-gradient(180deg, #e9f4fb, #f5f9fc 48rem)",
  },
};

export const baThemeStyles = ["schale", "archive", "shittim"] as const;
export type BAThemeStyle = (typeof baThemeStyles)[number];
export function isBAThemeStyle(value: unknown): value is BAThemeStyle {
  return baThemeStyles.some((style) => style === value);
}
export const themeProfileTokens: Record<
  BAThemeStyle,
  Record<string, string>
> = {
  schale: { ...palette.schale, ...roundedTokens },
  archive: { ...palette.archive, ...roundedTokens },
  shittim: { ...palette.shittim, ...roundedTokens },
};
