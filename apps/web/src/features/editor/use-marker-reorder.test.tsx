import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useMarkerReorder } from "./use-marker-reorder";

let hit: Element | null;
const reordered = vi.fn();
let animation: FrameRequestCallback | undefined;
function Harness({
  scope = "work:image:epoch:access",
  disabled = false,
  ids = ["a", "b", "c"],
  onRender,
}: {
  scope?: string;
  disabled?: boolean;
  ids?: string[];
  onRender?: () => void;
}) {
  onRender?.();
  const root = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("draft");
  const reorder = useMarkerReorder({
    ids,
    scope,
    disabled,
    listRef: root,
    caption: (id) => `标记${id}`,
    onReorder: reordered,
  });
  return (
    <div ref={root} {...reorder.listProps} data-testid="list">
      {ids.map((id) => (
        <article key={id} {...reorder.rowProps(id)} data-testid={`row-${id}`}>
          <header>{reorder.controls(id)}</header>
          <textarea
            aria-label={`译文${id}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="button">删除{id}</button>
          <select aria-label={`类型${id}`} defaultValue="inside">
            <option value="inside">框内</option>
          </select>
          <div contentEditable suppressContentEditableWarning>
            editable{id}
          </div>
        </article>
      ))}
      {reorder.feedback}
      <output>{String(reorder.dragActiveRef.current)}</output>
    </div>
  );
}

beforeEach(() => {
  class TestPointer extends MouseEvent {
    pointerId = 1;
    isPrimary = true;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      Object.assign(this, {
        pointerId: init.pointerId ?? 1,
        isPrimary: init.isPrimary ?? true,
      });
    }
  }
  vi.stubGlobal("PointerEvent", TestPointer);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animation = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => hit,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const index = ["a", "b", "c"].indexOf(this.dataset.markerReorderId ?? "");
      const top = index < 0 ? 0 : index * 60;
      return {
        left: 0,
        right: 300,
        top,
        bottom: top + (index < 0 ? 200 : 60),
        width: 300,
        height: index < 0 ? 200 : 60,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  );
  hit = null;
  animation = undefined;
  reordered.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(element: Element) {
  fireEvent.pointerDown(element, {
    button: 0,
    pointerId: 1,
    isPrimary: true,
    clientX: 10,
    clientY: 10,
  });
}
function move(y: number) {
  hit = screen.getByTestId("list");
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: y });
}
function up(y: number) {
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: y });
}

test("pointer uses stable IDs and emits before-marker or null append", () => {
  render(<Harness />);
  start(screen.getByTestId("row-c"));
  move(50);
  expect(screen.getByTestId("row-b").dataset.markerReorderBefore).toBe("true");
  expect(screen.getByRole("status").textContent).toBe("true");
  up(50);
  expect(reordered).toHaveBeenLastCalledWith("c", "b");
  start(screen.getByRole("button", { name: "拖动标记a调整顺序" }));
  move(190);
  expect(screen.getByTestId("row-c").dataset.markerReorderAfter).toBe("true");
  up(190);
  expect(reordered).toHaveBeenLastCalledWith("a", null);
});

test("unrelated mouse-style pointer releases without pointer identity are harmless", () => {
  render(<Harness />);
  fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
  expect(reordered).not.toHaveBeenCalled();
});

test("grip arrows reorder with boundary and IME guards while preserving focus", () => {
  render(<Harness />);
  const grip = screen.getByRole("button", { name: "拖动标记b调整顺序" });
  grip.focus();
  fireEvent.keyDown(grip, { key: "ArrowUp", isComposing: true });
  expect(reordered).not.toHaveBeenCalled();
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  expect(reordered).toHaveBeenLastCalledWith("b", "a");
  expect(document.activeElement).toBe(grip);
  fireEvent.keyDown(screen.getByRole("button", { name: "拖动标记a调整顺序" }), {
    key: "ArrowUp",
  });
  expect(reordered).toHaveBeenCalledTimes(1);
});

test("a pending order request retains grip focus and rejects duplicate actions", () => {
  const view = render(<Harness />);
  const grip = screen.getByRole("button", { name: "拖动标记b调整顺序" });
  grip.focus();
  fireEvent.keyDown(grip, { key: "ArrowUp" });
  view.rerender(<Harness disabled />);
  expect(document.activeElement).toBe(grip);
  expect(grip.getAttribute("aria-disabled")).toBe("true");
  expect((grip as HTMLButtonElement).disabled).toBe(false);
  fireEvent.keyDown(grip, { key: "ArrowDown" });
  start(grip);
  move(190);
  up(190);
  expect(reordered).toHaveBeenCalledTimes(1);
});

test("typing, selecting, button clicks and a short row press do not drag", () => {
  render(<Harness />);
  for (const element of [
    screen.getByRole("textbox", { name: "译文a" }),
    screen.getByRole("combobox", { name: "类型a" }),
    screen.getByRole("button", { name: "删除a" }),
    screen.getByText("editablea"),
  ]) {
    start(element);
    move(190);
    up(190);
    expect(screen.queryByTestId("marker-reorder-feedback")).toBeNull();
  }
  const textarea = screen.getByRole("textbox", { name: "译文a" });
  textarea.focus();
  fireEvent.change(textarea, { target: { value: "changed" } });
  fireEvent.keyDown(textarea, { key: "ArrowDown" });
  expect((textarea as HTMLTextAreaElement).value).toBe("changed");
  expect(document.activeElement).toBe(textarea);
  start(screen.getByTestId("row-a"));
  up(11);
  expect(reordered).not.toHaveBeenCalled();
});

test.each([
  "scope",
  "order",
  "access",
  "Escape",
  "blur",
  "pointercancel",
  "outside",
])("%s change cancels active dragging without submitting", (reason) => {
  const view = render(<Harness />);
  start(screen.getByTestId("row-a"));
  move(190);
  if (reason === "scope") view.rerender(<Harness scope="another-image" />);
  if (reason === "order") view.rerender(<Harness ids={["b", "a", "c"]} />);
  if (reason === "access") view.rerender(<Harness disabled />);
  if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
  if (reason === "blur") fireEvent.blur(window);
  if (reason === "pointercancel")
    fireEvent.pointerCancel(window, { pointerId: 1 });
  if (reason === "outside") hit = document.body;
  up(190);
  expect(reordered).not.toHaveBeenCalled();
  expect(screen.queryByTestId("marker-reorder-feedback")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("false");
});

test("drag autoscrolls the list and unchanged targets avoid repeated renders", () => {
  const rendered = vi.fn();
  render(<Harness onRender={rendered} />);
  const list = screen.getByTestId("list");
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  start(screen.getByTestId("row-a"));
  move(190);
  const count = rendered.mock.calls.length;
  move(191);
  move(192);
  expect(rendered.mock.calls.length).toBe(count);
  animation?.(0);
  expect(list.scrollTop).toBeGreaterThan(0);
  up(192);
});
