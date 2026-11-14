import { expect, test } from "vitest";
import { defaultTheme, themePresets } from "../../styles/theme";
import { readThemeSelection, resolveTheme, siteTheme } from "./theme-selection";

test("legacy selection is preserved while absent or corrupt storage follows the site", () => {
  const custom = { brand: "#abcdef", style: "minimal" as const };
  expect(readThemeSelection(null, JSON.stringify(custom))).toEqual({
    mode: "custom",
    theme: custom,
  });
  expect(readThemeSelection("{", JSON.stringify(custom))).toEqual({
    mode: "custom",
    theme: custom,
  });
  expect(readThemeSelection(null, null)).toEqual({ mode: "site" });
  expect(readThemeSelection('{"mode":"site"}', JSON.stringify(custom))).toEqual(
    { mode: "site" },
  );
  expect(resolveTheme({ mode: "custom", theme: custom }, defaultTheme)).toEqual(
    custom,
  );
  expect(resolveTheme({ mode: "site" }, custom)).toEqual(custom);
});

test("site preset IDs are stable and unknown IDs fall back without changing old values", () => {
  expect(themePresets.map((p) => p.id)).toEqual([
    "teal",
    "sky",
    "lavender",
    "pink",
    "amber",
    "minimal",
    "schale",
    "archive",
    "shittim",
  ]);
  expect(siteTheme("sky")).toEqual({ brand: "#5599ff", style: "soft" });
  expect(siteTheme("unknown")).toEqual(defaultTheme);
});
