import { afterEach, expect, test } from "vitest";
import { themeRegistry } from "./registry";
import {
  applyTheme,
  defaultTheme,
  mountTheme,
  readTheme,
  themePresets,
  themeReadability,
} from "../styles/theme";
import {
  readThemeSelection,
  resolveTheme,
} from "../features/site/theme-selection";

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const values = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}
afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme-style");
  localStorage.clear();
});

test.each(themePresets.filter((preset) => preset.style.endsWith("-dark")))(
  "$id keeps secondary actions readable with extreme custom brand colors",
  (preset) => {
    const tokens = themeRegistry.definition(preset.style)!.tokens!;
    for (const brand of [
      "#000000",
      "#ffffff",
      "#0000ff",
      "#ff0000",
      "#00ff00",
      "#777777",
    ]) {
      const resolve = (key: string) => {
        const value = tokens[key];
        if (value.startsWith("#")) return value;
        const match =
          /^color-mix\(in srgb, var\(--color-brand\) (\d+)%, (white|#[a-f\d]{6})\)$/.exec(
            value,
          )!;
        const proportion = Number(match[1]) / 100;
        const base = match[2] === "white" ? "#ffffff" : match[2];
        return (
          "#" +
          [1, 3, 5]
            .map((index) =>
              Math.round(
                parseInt(brand.slice(index, index + 2), 16) * proportion +
                  parseInt(base.slice(index, index + 2), 16) * (1 - proportion),
              )
                .toString(16)
                .padStart(2, "0"),
            )
            .join("")
        );
      };
      for (const foreground of ["--color-brand-600", "--color-brand-700"])
        for (const background of [
          "--color-brand-50",
          "--color-brand-100",
          "--color-surface-soft",
        ])
          expect(
            contrast(resolve(foreground), resolve(background)),
            `${brand} ${foreground}/${background}`,
          ).toBeGreaterThanOrEqual(4.5);
    }
  },
);

test.each(themePresets.filter((preset) => preset.style.endsWith("-dark")))(
  "$id keeps text and semantic messages readable on dark surfaces",
  (preset) => {
    const tokens = themeRegistry.definition(preset.style)!.tokens!;
    for (const foreground of [
      "--color-text",
      "--color-text-soft",
      "--color-text-muted",
    ])
      for (const background of [
        "--color-canvas",
        "--color-surface",
        "--color-surface-soft",
        "--color-surface-muted",
      ])
        expect(
          contrast(tokens[foreground], tokens[background]),
          `${foreground}/${background}`,
        ).toBeGreaterThanOrEqual(4.5);
    for (const [fg, bg] of [
      ["--color-status-success-text", "--color-status-success-bg"],
      ["--color-status-translation-text", "--color-status-translation-bg"],
      ["--color-blue-700", "--color-blue-50"],
      ["--color-amber-600", "--color-amber-50"],
      ["--color-red-600", "--color-red-50"],
      ["--color-red-600", "--color-red-200"],
      ["--color-violet-700", "--color-violet-50"],
      ["--color-decor-text", "--color-decor-tint"],
    ])
      expect(
        contrast(tokens[fg], tokens[bg]),
        `${fg}/${bg}`,
      ).toBeGreaterThanOrEqual(4.5);
    const readability = themeReadability(preset);
    expect(readability.normal.contrast).toBeGreaterThanOrEqual(4.5);
    expect(readability.hover.contrast).toBeGreaterThanOrEqual(4.5);
  },
);

test.each(themePresets.filter((preset) => preset.style.endsWith("-dark")))(
  "$id survives stored choices, nested previews and return to a light theme",
  (preset) => {
    const saved = JSON.stringify({ mode: "custom", theme: preset });
    expect(
      resolveTheme(readThemeSelection(saved, null), defaultTheme),
    ).toMatchObject({ brand: preset.brand, style: preset.style });
    expect(readTheme(JSON.stringify(preset))).toMatchObject({
      brand: preset.brand,
      style: preset.style,
    });
    applyTheme(preset);
    const root = document.documentElement;
    const before = root.getAttribute("style");
    const restore = mountTheme(root, defaultTheme);
    expect(root.style.getPropertyValue("--color-brand-50")).toBe("");
    restore();
    expect(root.getAttribute("style")).toBe(before);
    applyTheme(defaultTheme, { persist: false });
    expect(root.dataset.themeStyle).toBe("soft");
    for (const key of themeRegistry.tokenKeys)
      expect(root.style.getPropertyValue(key), key).toBe("");
  },
);
