import { expect, test } from "vitest";
import { createThemeCatalog, defaultThemePack } from "@comiku/theme-catalog";
import { createThemeRegistry } from "./registry";
import { themePack } from "./packs/default";
import {
  readThemeSelection,
  resolveTheme,
  themeSelectionKey,
  loadThemeSelection,
} from "../features/site/theme-selection";
import { presentSite } from "../features/site/site-config";

const catalog = createThemeCatalog([defaultThemePack]);
const registry = createThemeRegistry(catalog, [themePack]);
test("default-only registry is independent of optional style definitions", () => {
  expect(registry.tokenKeys).toEqual([]);
  expect(registry.hasStyle("arona")).toBe(false);
  expect(registry.preset("arona").id).toBe("teal");
  expect(() => createThemeRegistry(catalog, [])).toThrow();
  expect(() => createThemeRegistry(catalog, [themePack, themePack])).toThrow();
});
test("unavailable personal choices follow the site without overwriting saved or legacy choices", () => {
  const saved = JSON.stringify({
    mode: "custom",
    theme: { brand: "#82cbe8", style: "arona" },
  });
  const legacy = JSON.stringify({ brand: "#171717", style: "minimal" });
  const selection = readThemeSelection(saved, legacy);
  const site = { brand: "#5599ff", style: "soft" };
  expect(resolveTheme(selection, site, registry.hasStyle)).toEqual(site);
  expect(
    resolveTheme(
      selection,
      site,
      (style) => style === "arona" || registry.hasStyle(style),
    ),
  ).toEqual({ brand: "#82cbe8", style: "arona" });
  localStorage.setItem(themeSelectionKey, saved);
  expect(loadThemeSelection()).toEqual(selection);
  expect(localStorage.getItem(themeSelectionKey)).toBe(saved);
  localStorage.clear();
});
test("unavailable site presets preserve valid branding and revisions in responses and cached data", () => {
  const saved = {
    name: "团队站点",
    iconVersion: "11111111-1111-4111-8111-111111111111",
    themePresetId: "arona",
    revision: 9,
  };
  expect(presentSite(saved, catalog)).toEqual({
    ...saved,
    themePresetId: "teal",
  });
  expect(saved.themePresetId).toBe("arona");
  expect(presentSite({ ...saved, themePresetId: "future-theme" })).toEqual({
    ...saved,
    themePresetId: "teal",
  });
  expect(presentSite({ ...saved, name: "" }, catalog)).toBeUndefined();
});
