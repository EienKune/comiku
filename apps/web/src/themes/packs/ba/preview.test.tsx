import { StrictMode } from "react";
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemePreview } from "../../../playground/ThemePreview";
import { previewThemeStorageKey as themeStorageKey } from "../../../features/site/theme-selection";
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme-style");
});
test.each([
  "夏莱终端",
  "古书馆图册",
  "什亭工作台",
  "阿罗娜",
  "普拉娜",
  "普拉娜夜间",
  "什亭双人",
  "BA 青蓝白",
  "BA 亮蓝炭灰",
])("%s persists complete style and releases its palette", (name) => {
  const view = render(
    <StrictMode>
      <ThemePreview />
    </StrictMode>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(`^${name} #`) }),
  );
  const style = document.documentElement.dataset.themeStyle;
  expect(JSON.parse(localStorage.getItem(themeStorageKey)!)).toMatchObject({
    style,
  });
  expect(
    document.documentElement.style.getPropertyValue("--ba-action-bg"),
  ).not.toBe("");
  view.unmount();
  expect(
    document.documentElement.style.getPropertyValue("--ba-action-bg"),
  ).toBe("");
  render(<ThemePreview />);
  expect(document.documentElement.dataset.themeStyle).toBe(style);
  fireEvent.click(screen.getByRole("button", { name: /^青绿 #/ }));
  expect(
    document.documentElement.style.getPropertyValue("--ba-action-bg"),
  ).toBe("");
});
