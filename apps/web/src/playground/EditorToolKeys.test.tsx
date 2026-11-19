import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MarkerDemo } from "./MarkerDemo";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

test("Playground reuses shortcut settings with live keycaps and isolated in-memory preferences", () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const view = render(<MarkerDemo />);
  fireEvent.click(screen.getByRole("button", { name: "快捷键设置" }));
  const dialog = screen.getByRole("dialog", { name: "快捷键设置" });
  expect(dialog.textContent).toContain("不会修改账号偏好");
  fireEvent.keyDown(within(dialog).getByLabelText("添加框内快捷键"), {
    key: "q",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存快捷键" }));
  const tool = screen.getByRole("button", { name: "框内标点" });
  expect(tool.getAttribute("aria-keyshortcuts")).toBe("Q");
  expect(tool.querySelector("kbd")?.textContent).toBe("Q");
  expect(tool.title).toContain("Q");
  const canvas = screen.getByLabelText("示例漫画标记画布");
  fireEvent.keyDown(canvas, { key: "2" });
  expect(tool.getAttribute("aria-pressed")).toBe("false");
  fireEvent.keyDown(canvas, { key: "q" });
  expect(tool.getAttribute("aria-pressed")).toBe("true");
  expect(storage).not.toHaveBeenCalled();
  view.unmount();
  render(<MarkerDemo />);
  expect(
    screen.getByRole("button", { name: "框内标点" }).querySelector("kbd")
      ?.textContent,
  ).toBe("2");
});

test("Playground marker navigation preserves focus, stops at endpoints, and respects native controls and IME", () => {
  render(<MarkerDemo />);
  const canvas = screen.getByLabelText("示例漫画标记画布");
  canvas.focus();
  fireEvent.keyDown(canvas, { key: "ArrowDown" });
  expect(screen.getByLabelText("标记 2")).toBeTruthy();
  expect(document.activeElement).toBe(canvas);
  fireEvent.keyDown(canvas, { key: "ArrowDown" });
  fireEvent.keyDown(canvas, { key: "ArrowDown" });
  expect(screen.getByLabelText("标记 3")).toBeTruthy();
  const list = screen.getByLabelText("演示标记列表");
  list.focus();
  fireEvent.keyDown(list, { key: "ArrowUp" });
  expect(screen.getByLabelText("标记 2")).toBeTruthy();
  const area = screen.getByRole("textbox");
  fireEvent.keyDown(area, { key: "ArrowUp" });
  expect(screen.getByLabelText("标记 2")).toBeTruthy();
  fireEvent.compositionStart(area);
  fireEvent.keyDown(canvas, { key: "ArrowUp" });
  expect(screen.getByLabelText("标记 2")).toBeTruthy();
  fireEvent.compositionEnd(area);
  fireEvent.keyDown(list, { key: "ArrowUp" });
  fireEvent.keyDown(list, { key: "ArrowUp" });
  expect(screen.getByLabelText("标记 1")).toBeTruthy();
  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  expect(screen.getByLabelText("标记 1")).toBeTruthy();
});
