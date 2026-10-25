import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemePreview } from "./ThemePreview";
import { themeStorageKey } from "../styles/theme";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme-style");
});

test("preview persists choices, ignores incomplete color input and restores app styles on exit", () => {
  const root = document.documentElement;
  root.style.setProperty("--color-brand", "#123456", "important");
  root.dataset.themeStyle = "soft";
  const { unmount } = render(
    <StrictMode>
      <ThemePreview />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: /黑白极简/ }));
  expect(root.dataset.themeStyle).toBe("minimal");
  expect(root.style.getPropertyValue("--color-on-brand")).toBe("#ffffff");
  expect(JSON.parse(localStorage.getItem(themeStorageKey)!)).toMatchObject({
    brand: "#171717",
    style: "minimal",
  });
  fireEvent.change(screen.getByLabelText("自定义色值"), {
    target: { value: "#ff" },
  });
  expect(root.style.getPropertyValue("--color-brand")).toBe("#171717");
  expect(screen.getByLabelText("自定义色值").getAttribute("aria-invalid")).toBe(
    "true",
  );
  unmount();
  expect(root.style.getPropertyValue("--color-brand")).toBe("#123456");
  // jsdom drops priority on custom properties; real-browser QA covers restoration.
  expect(root.style.getPropertyValue("--color-on-brand")).toBe("");
  expect(root.dataset.themeStyle).toBe("soft");
  render(<ThemePreview />);
  expect(
    screen
      .getByRole("button", { name: /黑白极简/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("blocked storage does not prevent temporary theme switching or reset", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<ThemePreview />);
  fireEvent.click(screen.getByRole("button", { name: /黑白极简/ }));
  expect(document.documentElement.dataset.themeStyle).toBe("minimal");
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  expect(document.documentElement.dataset.themeStyle).toBe("soft");
  expect(document.documentElement.style.getPropertyValue("--color-brand")).toBe(
    "#33ccbb",
  );
});
