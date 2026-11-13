import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageOrderList } from "./ImageOrderList";
import { useImageDrag } from "./use-image-drag";
import {
  imageDragSnapshot,
  moveImage,
  type ImageDragGroup,
} from "./image-drag-model";

const initial = [
  { id: "one", mediaIds: ["a", "b"] },
  { id: "two", mediaIds: [] },
];
const valid = ["a", "b", "c"];
let hit: Element | null;
function Harness({
  epoch = "1",
  onRender,
}: {
  epoch?: string;
  onRender?: () => void;
}) {
  onRender?.();
  const [groups, setGroups] = useState<readonly ImageDragGroup[]>(initial);
  const root = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const { drag, feedback } = useImageDrag({
    groups,
    validIds: valid,
    snapshot: imageDragSnapshot(groups, valid, epoch),
    rootRef: root,
    scrollRef: scroll,
    caption: (id) => id,
    onDrop: (id, group, slot, snapshot) =>
      setGroups((current) =>
        moveImage(current, id, group, slot, snapshot, valid, epoch),
      ),
  });
  return (
    <div
      ref={root}
      data-testid="editor-root"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeEditor();
      }}
    >
      <div ref={scroll}>
        <button
          data-image-drag-preview
          onPointerDown={(event) => drag.start(event, "c")}
          onClick={() => preview("c")}
        >
          source c
        </button>
        {groups.map((group) => (
          <ImageOrderList
            key={group.id}
            groupId={group.id}
            ids={group.mediaIds}
            caption={(id) => id}
            renderThumbnail={(id) => <span>{id}</span>}
            onPreview={preview}
            onChange={(ids) =>
              setGroups((current) =>
                current.map((item) =>
                  item.id === group.id ? { ...item, mediaIds: ids } : item,
                ),
              )
            }
            onRemove={(id) =>
              setGroups((current) =>
                current.map((item) => ({
                  ...item,
                  mediaIds: item.mediaIds.filter((media) => media !== id),
                })),
              )
            }
            drag={drag}
          />
        ))}
      </div>
      {feedback}
      <output>{JSON.stringify(groups)}</output>
    </div>
  );
}
const preview = vi.fn();
const closeEditor = vi.fn();
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
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => hit,
  });
  hit = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  preview.mockClear();
  closeEditor.mockClear();
});
function pointerStart(element: Element, x = 10, y = 10) {
  fireEvent.pointerDown(element, {
    button: 0,
    clientX: x,
    clientY: y,
    pointerId: 1,
    isPrimary: true,
  });
}
function dropOn(group: string) {
  hit = document.querySelector(`[data-image-drag-group="${group}"]`);
  fireEvent.pointerMove(window, { clientX: 50, clientY: 70, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 50, clientY: 70, pointerId: 1 });
}
test("short press previews and full row drag moves to empty group without preview", () => {
  render(<Harness />);
  const thumb = screen.getByRole("button", { name: "预览第 1 页，a" });
  pointerStart(thumb);
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 12, clientY: 11 });
  fireEvent.click(thumb, { detail: 1 });
  expect(preview).toHaveBeenCalledWith("a");
  preview.mockClear();
  const row = thumb.closest("li")!;
  pointerStart(row);
  dropOn("two");
  expect(screen.getByRole("status").textContent).toContain('"mediaIds":["a"]');
  fireEvent.click(row, { detail: 1 });
  expect(preview).not.toHaveBeenCalled();
});
test("moving within the same insertion target updates feedback without rerendering the editor", () => {
  const rendered = vi.fn();
  render(<Harness onRender={rendered} />);
  pointerStart(screen.getByText("source c"));
  hit = document.querySelector('[data-image-drag-group="two"]');
  fireEvent.pointerMove(window, { clientX: 30, clientY: 40, pointerId: 1 });
  const baseline = rendered.mock.calls.length,
    feedback = screen.getByTestId("image-drag-feedback");
  for (let step = 0; step < 20; step++)
    fireEvent.pointerMove(window, {
      clientX: 31 + step,
      clientY: 41 + step,
      pointerId: 1,
    });
  expect(rendered.mock.calls.length).toBe(baseline);
  expect(feedback.style.transform).toBe("translate3d(64px, 74px, 0)");
  hit = document.querySelector('[data-image-drag-group="one"]');
  fireEvent.pointerMove(window, { clientX: 60, clientY: 70, pointerId: 1 });
  expect(rendered.mock.calls.length).toBe(baseline + 1);
});
test("source originals move directly and independent remove buttons never start a drag", () => {
  render(<Harness />);
  pointerStart(screen.getByText("source c"));
  dropOn("two");
  expect(screen.getByRole("status").textContent).toContain('"mediaIds":["c"]');
  const remove = screen.getByRole("button", { name: "移出 a" });
  pointerStart(remove);
  fireEvent.click(remove, { detail: 1 });
  expect(screen.getByRole("status").textContent).not.toContain('"a"');
});
test.each(["Escape", "blur", "pointercancel", "outside"])(
  "%s cancels drag and next intentional remove still works",
  (kind) => {
    render(<Harness />);
    const row = screen
      .getByRole("button", { name: "预览第 1 页，a" })
      .closest("li")!;
    pointerStart(row);
    hit = document.querySelector('[data-image-drag-group="two"]');
    fireEvent.pointerMove(window, { clientX: 50, clientY: 70, pointerId: 1 });
    expect(screen.getByTestId("image-drag-feedback")).toBeTruthy();
    if (kind === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (kind === "blur") fireEvent.blur(window);
    else if (kind === "pointercancel")
      fireEvent.pointerCancel(window, { pointerId: 1 });
    else hit = null;
    fireEvent.pointerUp(window, { clientX: 50, clientY: 70, pointerId: 1 });
    expect(screen.queryByTestId("image-drag-feedback")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      '"mediaIds":["a","b"]',
    );
    const remove = screen.getByRole("button", { name: "移出 a" });
    pointerStart(remove);
    fireEvent.click(remove, { detail: 1 });
    expect(screen.getByRole("status").textContent).not.toContain('"a"');
  },
);
test("Escape then late release on dialog padding cannot close the editor; next deliberate click works", () => {
  render(<Harness />);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const thumb = screen.getByRole("button", { name: "预览第 1 页，a" }),
    root = screen.getByTestId("editor-root");
  pointerStart(thumb);
  fireEvent.pointerMove(window, { clientX: 35, clientY: 10, pointerId: 1 });
  fireEvent.keyDown(window, { key: "Escape" });
  now = 1000;
  fireEvent.pointerMove(root, { clientX: 3, clientY: 3, pointerId: 1 });
  fireEvent.pointerUp(root, { clientX: 3, clientY: 3, pointerId: 1 });
  fireEvent.click(root, { detail: 1 });
  expect(closeEditor).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain(
    '"mediaIds":["a","b"]',
  );
  const remove = screen.getByRole("button", { name: "移出 a" });
  pointerStart(remove);
  fireEvent.click(remove, { detail: 1 });
  expect(screen.getByRole("status").textContent).not.toContain('"a"');
  pointerStart(root);
  fireEvent.pointerUp(root, { pointerId: 1 });
  fireEvent.click(root, { detail: 1 });
  expect(closeEditor).toHaveBeenCalledOnce();
});
test("Escape followed by a late release cannot open the dragged preview", () => {
  render(<Harness />);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const thumb = screen.getByRole("button", { name: "预览第 1 页，a" });
  pointerStart(thumb);
  fireEvent.pointerMove(window, { clientX: 50, clientY: 70, pointerId: 1 });
  fireEvent.keyDown(window, { key: "Escape" });
  now = 1000;
  fireEvent.pointerUp(window, { clientX: 50, clientY: 70, pointerId: 1 });
  fireEvent.click(thumb, { detail: 1 });
  expect(preview).not.toHaveBeenCalled();
});
test("5px threshold and row halves determine exact insertion", () => {
  render(<Harness />);
  const source = screen.getByText("source c");
  pointerStart(source);
  fireEvent.pointerMove(window, { clientX: 14, clientY: 10, pointerId: 1 });
  expect(screen.queryByTestId("image-drag-feedback")).toBeNull();
  const list = document.querySelector<HTMLElement>(
    '[data-image-drag-group="one"]',
  )!;
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 200,
  } as DOMRect);
  const rows = list.querySelectorAll("[data-media-id]");
  vi.spyOn(rows[0], "getBoundingClientRect").mockReturnValue({
    top: 0,
    height: 100,
  } as DOMRect);
  vi.spyOn(rows[1], "getBoundingClientRect").mockReturnValue({
    top: 100,
    height: 100,
  } as DOMRect);
  hit = rows[1];
  fireEvent.pointerMove(window, { clientX: 15, clientY: 120, pointerId: 1 });
  expect(screen.getByTestId("image-drag-feedback")).toBeTruthy();
  fireEvent.pointerUp(window, { clientX: 15, clientY: 120, pointerId: 1 });
  expect(screen.getByRole("status").textContent).toContain(
    '"mediaIds":["a","c","b"]',
  );
});
test("a collapsed group without rendered rows appends and an outside matching group cancels", () => {
  render(<Harness />);
  const source = screen.getByText("source c"),
    collapsed = document.createElement("section");
  collapsed.dataset.imageDragGroup = "one";
  source.parentElement!.append(collapsed);
  pointerStart(source);
  hit = collapsed;
  fireEvent.pointerMove(window, { clientX: 30, clientY: 30, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 30, clientY: 30, pointerId: 1 });
  expect(screen.getByRole("status").textContent).toContain(
    '"mediaIds":["a","b","c"]',
  );
  const outside = document.createElement("section");
  outside.dataset.imageDragGroup = "two";
  document.body.append(outside);
  pointerStart(source);
  hit = outside;
  fireEvent.pointerMove(window, { clientX: 40, clientY: 40, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 40, clientY: 40, pointerId: 1 });
  expect(screen.getByRole("status").textContent).toContain(
    '"mediaIds":["a","b","c"]',
  );
  outside.remove();
});
test("edge autoscroll is bounded and avoids measuring unchanged scroll frames", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const measure = vi.fn(() => hit);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: measure,
  });
  render(<Harness />);
  const source = screen.getByText("source c"),
    scroll = source.parentElement!;
  Object.defineProperties(scroll, {
    scrollHeight: { value: 500 },
    clientHeight: { value: 100 },
  });
  vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: 100,
    top: 0,
    bottom: 100,
  } as DOMRect);
  pointerStart(source);
  hit = document.querySelector('[data-image-drag-group="two"]');
  fireEvent.pointerMove(window, { clientX: 50, clientY: 95, pointerId: 1 });
  frames.shift()!(0);
  expect(scroll.scrollTop).toBe(12);
  scroll.scrollTop = 400;
  const calls = measure.mock.calls.length;
  frames.shift()!(1);
  expect(scroll.scrollTop).toBe(400);
  expect(measure.mock.calls.length).toBe(calls);
  fireEvent.pointerMove(window, { clientX: 150, clientY: 95, pointerId: 1 });
  scroll.scrollTop = 0;
  const outsideCalls = measure.mock.calls.length;
  frames.shift()!(2);
  expect(scroll.scrollTop).toBe(0);
  expect(measure.mock.calls.length).toBe(outsideCalls);
});
test("external revision changes cancel a live drag, keyboard grip retains reordering", () => {
  const view = render(<Harness />);
  pointerStart(screen.getByRole("button", { name: "预览第 1 页，a" }));
  hit = document.querySelector('[data-image-drag-group="two"]');
  fireEvent.pointerMove(window, { clientX: 50, clientY: 70, pointerId: 1 });
  view.rerender(<Harness epoch="2" />);
  fireEvent.pointerUp(window, { clientX: 50, clientY: 70, pointerId: 1 });
  expect(screen.getByRole("status").textContent).toContain(
    '"mediaIds":["a","b"]',
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "拖动 b 调整顺序" }), {
    key: "ArrowUp",
  });
  expect(screen.getByRole("status").textContent).toContain(
    '"mediaIds":["b","a"]',
  );
});
