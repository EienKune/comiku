import { expect, test } from "vitest";
import { themePresets } from "../../../styles/theme";
import {
  cssContrast,
  mountContrastFixture,
  readThemeCss,
} from "../../css-contrast.test-utils";

const runtimeCss = readThemeCss("./packs/default/runtime.css");

for (const preset of themePresets.filter((theme) =>
  ["minimal-dark", "teal-dark"].includes(theme.style),
)) {
  test(`${preset.id} keeps business danger buttons readable while hovered`, () => {
    const fixture = mountContrastFixture(preset, runtimeCss);
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
  test(`${preset.id} keeps Playground cards, marker list and marker states readable`, () => {
    const fixture = mountContrastFixture(preset, runtimeCss);
    try {
      for (const [text, surface] of [
        [".hero-card strong", ".hero-card"],
        [".hero-card small", ".hero-card"],
        [".hero-work-card strong", ".hero-work-card"],
        [".hero-work-card__content > span", ".hero-work-card"],
        [".marker-demo__list h3", ".marker-demo__list"],
        [".translation-row", ".marker-demo__list"],
        [".translation-marker[data-hover]", ".translation-marker[data-hover]"],
        [".translation-marker.is-selected", ".translation-marker.is-selected"],
        [".translation-marker--outside", ".translation-marker--outside"],
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
}

test("light Playground cards and marker list retain their original materials", () => {
  const fixture = mountContrastFixture(
    { brand: "#33ccbb", style: "soft" },
    runtimeCss,
  );
  try {
    expect(
      getComputedStyle(fixture.element(".hero-card")).backgroundColor,
    ).toBe("rgba(255, 255, 255, 0.84)");
    expect(
      getComputedStyle(fixture.element(".marker-demo__list")).backgroundColor,
    ).toBe("rgb(250, 252, 252)");
  } finally {
    fixture.dispose();
  }
});
