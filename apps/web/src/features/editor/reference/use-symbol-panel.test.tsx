import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorReferenceDemo } from "../../../playground/EditorReferenceDemo";
import { installNativeTextEditMock } from "../native-text-edit.test-support";
import { symbolPanelPosition } from "./use-symbol-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("anchor placement prefers useful space below, flips only when needed and clamps edges", () => {
  const panel = { width: 352, height: 310 };
  expect(
    symbolPanelPosition({ right: 800, top: 60, bottom: 92 }, panel, {
      width: 1000,
      height: 800,
    }),
  ).toEqual({ left: 448, top: 100, maxHeight: 688 });
  expect(
    symbolPanelPosition({ right: 200, top: 650, bottom: 682 }, panel, {
      width: 1000,
      height: 800,
    }),
  ).toEqual({ left: 12, top: 332, maxHeight: 630 });
  const short = symbolPanelPosition(
    { right: 1100, top: 80, bottom: 112 },
    panel,
    { width: 390, height: 180 },
  );
  expect(short.left).toBe(26);
  expect(short.top).toBe(12);
  expect(short.maxHeight).toBe(156);
});

test("drag preserves symbol insertion selection, ignores close controls, clamps resize and resets on reopen", () => {
  installNativeTextEditMock();
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const floating = this.classList.contains("editor-symbol-panel");
      const x = floating ? Number.parseFloat(this.style.left || "12") : 700;
      const y = floating ? Number.parseFloat(this.style.top || "12") : 60;
      const width = floating ? 352 : 100;
      const height = floating
        ? Math.min(310, Number.parseFloat(this.style.maxHeight || "310"))
        : 32;
      return {
        x,
        y,
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
        width,
        height,
        toJSON() {},
      };
    },
  );
  render(<EditorReferenceDemo />);
  const area = screen.getByLabelText("示例译文") as HTMLTextAreaElement;
  area.focus();
  const original = area.value;
  area.setSelectionRange(1, 3);
  fireEvent.select(area);
  const opener = screen.getByRole("button", { name: "符号" });
  fireEvent.click(opener);
  const panel = screen.getByRole("group", { name: "常用符号" });
  const header = panel.querySelector("header")!;
  const capture = vi.fn();
  Object.assign(header, {
    setPointerCapture: capture,
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  });
  function pointer(target: Element, type: string, x: number, y: number) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      isPrimary: { value: true },
    });
    fireEvent(target, event);
  }
  expect(panel.style.left).toBe("448px");
  expect(panel.style.top).toBe("100px");
  const anchorMeasurement = vi.fn(opener.getBoundingClientRect.bind(opener));
  Object.defineProperty(opener, "getBoundingClientRect", {
    configurable: true,
    value: anchorMeasurement,
  });
  fireEvent.scroll(panel.querySelector(".editor-symbol-buttons")!);
  fireEvent.scroll(area);
  expect(anchorMeasurement).not.toHaveBeenCalled();
  fireEvent.scroll(opener.parentElement!);
  expect(anchorMeasurement).toHaveBeenCalledTimes(1);
  pointer(header, "pointerdown", 500, 110);
  pointer(header, "pointermove", 200, 310);
  pointer(header, "pointerup", 200, 310);
  expect(panel.style.left).toBe("148px");
  expect(panel.style.top).toBe("300px");
  expect(area.selectionStart).toBe(1);
  expect(area.selectionEnd).toBe(3);
  fireEvent.click(screen.getByRole("button", { name: "插入或复制 ♡" }));
  expect(area.value).toBe(original.slice(0, 1) + "♡" + original.slice(3));
  pointer(
    screen.getByRole("button", { name: "关闭符号" }),
    "pointerdown",
    200,
    310,
  );
  expect(capture).toHaveBeenCalledTimes(1);
  vi.stubGlobal("innerHeight", 240);
  fireEvent.resize(window);
  expect(panel.style.top).toBe("12px");
  expect(panel.style.maxHeight).toBe("216px");
  fireEvent.click(screen.getByRole("button", { name: "关闭符号" }));
  vi.stubGlobal("innerHeight", 800);
  fireEvent.click(opener);
  expect(screen.getByRole("group", { name: "常用符号" }).style.left).toBe(
    "448px",
  );
  expect(screen.getByRole("group", { name: "常用符号" }).style.top).toBe(
    "100px",
  );
});
