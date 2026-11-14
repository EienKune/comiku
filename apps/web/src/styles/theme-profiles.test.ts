import { baThemeStyles, themeProfileTokens } from "./theme-profiles";
import { afterEach, expect, test } from "vitest";
import {
  applyTheme,
  defaultTheme,
  mountTheme,
  readTheme,
  themeReadability,
} from "./theme";
import {
  readThemeSelection,
  siteTheme,
} from "../features/site/theme-selection";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme-style");
  localStorage.clear();
});

test.each([
  "schale",
  "archive",
  "shittim",
  "arona",
  "plana",
  "shittim-duo",
  "ba-cyan",
  "ba-azure",
])("%s survives site selection and saved personal preferences", (style) => {
  const selected = siteTheme(style);
  expect(selected.style).toBe(style);
  expect(readTheme(JSON.stringify(selected))).toEqual(selected);
  expect(
    readThemeSelection(
      JSON.stringify({ mode: "custom", theme: selected }),
      null,
    ),
  ).toEqual({ mode: "custom", theme: selected });
  applyTheme(selected);
  expect(document.documentElement.dataset.themeStyle).toBe(style);
  expect(
    document.documentElement.style.getPropertyValue("--radius-button"),
  ).toBe("999px");
  const contrast = themeReadability(selected);
  expect(contrast.normal.contrast).toBeGreaterThanOrEqual(4.5);
  expect(contrast.hover.contrast).toBeGreaterThanOrEqual(4.5);
  applyTheme(defaultTheme, { persist: false });
  expect(document.documentElement.style.getPropertyValue("--color-text")).toBe(
    "",
  );
  expect(
    document.documentElement.style.getPropertyValue("--ba-action-bg"),
  ).toBe("");
});

test("nested previews restore complete palettes without writing personal preferences", () => {
  const root = document.documentElement;
  applyTheme(siteTheme("archive"));
  const saved = localStorage.getItem("comiku.playground.theme.v1");
  const before = root.getAttribute("style");
  const restore = mountTheme(root, siteTheme("schale"));
  expect(root.style.getPropertyValue("--ba-action-bg")).toBe("#80d8f5");
  const nested = mountTheme(root, defaultTheme);
  expect(root.style.getPropertyValue("--color-text")).toBe("");
  nested();
  expect(root.dataset.themeStyle).toBe("schale");
  restore();
  expect(root.dataset.themeStyle).toBe("archive");
  expect(root.getAttribute("style")).toBe(before);
  expect(localStorage.getItem("comiku.playground.theme.v1")).toBe(saved);
});

function contrast(a: string, b: string) {
  const light = (hex: string) => {
    const rgb = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const values = [light(a), light(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
}
test.each(baThemeStyles)(
  "%s keeps small labels readable on their actual surfaces",
  (style) => {
    const tokens = themeProfileTokens[style];
    for (const surface of [
      "--color-canvas",
      "--color-surface-soft",
      "--color-surface-muted",
    ]) {
      expect(
        contrast(tokens["--color-text-muted"], tokens[surface]),
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const [foreground, background] of [
      ["--color-decor-text", "--color-decor-tint"],
      ["--color-decor-cool-text", "--color-decor-cool"],
    ]) {
      expect(
        contrast(tokens[foreground], tokens[background]),
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of ["#ff6699", "#a78bfa"]) {
      expect(
        contrast(tokens["--ba-marker-text"], background),
      ).toBeGreaterThanOrEqual(4.5);
    }
  },
);
