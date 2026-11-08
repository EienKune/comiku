import { expect, test } from "vitest";
import { fitCandidateTags } from "./candidate-tag-layout";

test("counts tags against the model nodes and the overflow chip inside two rows", () => {
  expect(
    fitCandidateTags({
      width: 250,
      gap: 8,
      modelWidths: [90, 90],
      tagWidths: [70, 70, 70, 70, 70, 70],
      moreWidths: [30],
    }),
  ).toBe(2);
  expect(
    fitCandidateTags({
      width: 250,
      gap: 8,
      modelWidths: [],
      tagWidths: [70, 70, 70, 70, 70, 70],
      moreWidths: [30],
    }),
  ).toBe(6);
  expect(
    fitCandidateTags({
      width: 160,
      gap: 8,
      modelWidths: [],
      tagWidths: [70, 70, 70, 70, 70, 70],
      moreWidths: [30],
    }),
  ).toBe(3);
});

test("uses the omitted count's digit width and reclaims the chip when all tags fit", () => {
  expect(
    fitCandidateTags({
      width: 100,
      gap: 0,
      modelWidths: [100],
      tagWidths: Array(14).fill(20),
      moreWidths: [20, 40],
    }),
  ).toBe(3);
  expect(
    fitCandidateTags({
      width: 100,
      gap: 0,
      modelWidths: [100],
      tagWidths: Array(13).fill(20),
      moreWidths: [20, 40],
    }),
  ).toBe(4);
  expect(
    fitCandidateTags({
      width: 100,
      gap: 0,
      modelWidths: [100],
      tagWidths: Array(5).fill(20),
      moreWidths: [20],
    }),
  ).toBe(5);
});

test("zero width and too-large nodes cannot report a fitting visible hashtag", () => {
  expect(
    fitCandidateTags({
      width: 0,
      gap: 8,
      modelWidths: [],
      tagWidths: [50],
      moreWidths: [30],
    }),
  ).toBe(0);
  expect(
    fitCandidateTags({
      width: 100,
      gap: 8,
      modelWidths: [100, 100],
      tagWidths: [50],
      moreWidths: [30],
    }),
  ).toBe(0);
});
