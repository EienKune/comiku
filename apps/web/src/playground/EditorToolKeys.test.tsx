import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarkerDemo } from "./MarkerDemo";

afterEach(cleanup);

test("Playground keycaps select their working tools and leave typing and browser shortcuts alone", () => {
  render(<MarkerDemo />);
  const canvas = screen.getByLabelText("示例漫画标记画布");
  canvas.focus();
  for (const [key, label] of [
    ["2", "框内标点"],
    ["3", "框外标点"],
    ["4", "移动标点"],
    ["1", "移动画布"],
  ]) {
    fireEvent.keyDown(canvas, { key });
    const button = screen.getByRole("button", { name: label });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector("kbd")?.textContent).toBe(key);
    expect(button.querySelector("kbd")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  }
  const active = () =>
    screen
      .getByRole("button", { name: "移动画布" })
      .getAttribute("aria-pressed");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "3" });
  for (const flags of [
    { ctrlKey: true },
    { shiftKey: true },
    { isComposing: true },
    { repeat: true },
  ])
    fireEvent.keyDown(canvas, { key: "2", ...flags });
  expect(active()).toBe("true");
  const modal = document.createElement("dialog");
  modal.setAttribute("open", "");
  document.body.append(modal);
  fireEvent.keyDown(canvas, { key: "2" });
  expect(active()).toBe("true");
  modal.remove();
  const button = screen.getByRole("button", { name: "框内标点" });
  fireEvent.click(button.querySelector("kbd")!);
  expect(button.getAttribute("aria-pressed")).toBe("true");
});
