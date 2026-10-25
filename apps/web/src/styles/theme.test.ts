import { expect, test } from "vitest";
import {
  brandReadability,
  defaultTheme,
  readTheme,
  themePresets,
} from "./theme";

test("preset and extreme colors keep both button states readable", () => {
  const colors = [
    ...themePresets.map((theme) => theme.brand),
    "#ffffff",
    "#000000",
    "#ffff00",
    "#777777",
  ];
  // Sample the RGB cube, including colors near the black/white text crossover.
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) {
        colors.push(
          `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
        );
      }
    }
  }
  for (const color of colors) {
    const result = brandReadability(color);
    expect(result.normal.contrast, color).toBeGreaterThanOrEqual(4.5);
    expect(result.hover.contrast, color).toBeGreaterThanOrEqual(4.5);
  }
  expect(brandReadability("#000000").normal).toEqual({
    color: "#ffffff",
    contrast: 21,
  });
  expect(brandReadability("#ffffff").normal).toEqual({
    color: "#000000",
    contrast: 21,
  });
});

test("corrupted or unsupported stored preferences fall back safely", () => {
  for (const value of [
    null,
    "{",
    "null",
    "[]",
    '"red"',
    '{"brand":"red","style":"soft"}',
    '{"brand":"#12345678","style":"soft"}',
    '{"brand":"#123456","style":"dark"}',
  ]) {
    expect(readTheme(value)).toEqual(defaultTheme);
  }
  expect(
    readTheme('{"brand":"#ABCDEF","style":"minimal","ignored":true}'),
  ).toEqual({ brand: "#abcdef", style: "minimal" });
});
