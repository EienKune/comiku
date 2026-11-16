import { expect, test } from "vitest";
import { siteTheme } from "../../../features/site/theme-selection";
import {
  cssContrast,
  mountContrastFixture,
  readThemeCss,
} from "../../css-contrast.test-utils";

const runtimeCss = readThemeCss("./packs/ba/runtime.css");
const previewCss = readThemeCss("./packs/ba/preview.css");

test("plana-dark keeps business danger buttons readable while hovered", () => {
  const fixture = mountContrastFixture(
    siteTheme("plana-dark"),
    runtimeCss + previewCss,
  );
  try {
    for (const scope of ["account-app", "account-dialog"]) {
      const button = fixture.element(`.${scope} .ui-button--danger`);
      for (const hover of [false, true]) {
        const style = fixture.dangerColors(button, hover);
        expect(
          cssContrast(style.color, style.backgroundColor),
          `${scope} hover=${hover}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    fixture.dispose();
  }
});

test("plana-dark keeps Playground cards and unselected marker-list text readable", () => {
  const fixture = mountContrastFixture(
    siteTheme("plana-dark"),
    runtimeCss + previewCss,
  );
  try {
    for (const [text, surface] of [
      [".hero-card strong", ".hero-card"],
      [".hero-card small", ".hero-card"],
      [".hero-work-card strong", ".hero-work-card"],
      [".hero-work-card__content > span", ".hero-work-card"],
      [".marker-demo__list h3", ".marker-demo__list"],
      [".translation-row", ".marker-demo__list"],
    ]) {
      expect(
        cssContrast(
          getComputedStyle(fixture.element(text)).color,
          getComputedStyle(fixture.element(surface)).backgroundColor,
        ),
        text,
      ).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    fixture.dispose();
  }
});
