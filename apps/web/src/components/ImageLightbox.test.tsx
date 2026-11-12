import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ImageLightbox } from "./ImageLightbox";

afterEach(() => cleanup());

test("previews inside the active native dialog and consumes Escape before its editor", () => {
  const host = document.createElement("dialog");
  host.open = true;
  document.body.append(host);
  const trigger = document.createElement("button");
  host.append(trigger);
  trigger.focus();
  const editorEscape = vi.fn();
  host.addEventListener("keydown", editorEscape);
  const close = vi.fn();
  const view = render(
    <ImageLightbox
      alt="编辑预览"
      index={0}
      count={1}
      onClose={close}
      portalContainer={host}
    />,
  );
  const preview = screen.getByRole("dialog", {
    name: "编辑预览，第 1 张，共 1 张",
  });
  expect(preview.parentElement).toBe(host);
  expect(document.activeElement).toBe(preview);
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(preview, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  expect(editorEscape).not.toHaveBeenCalled();
  view.unmount();
  expect(document.activeElement).toBe(trigger);
  host.remove();
});

test("only the top preview handles Escape and keeps scroll locked while another remains", () => {
  const lowerClose = vi.fn();
  const upperClose = vi.fn();
  const lower = render(
    <ImageLightbox alt="下层" index={0} count={1} onClose={lowerClose} />,
  );
  const upper = render(
    <ImageLightbox alt="上层" index={0} count={1} onClose={upperClose} />,
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(lowerClose).not.toHaveBeenCalled();
  expect(upperClose).toHaveBeenCalledOnce();
  upper.unmount();
  expect(document.documentElement.classList.contains("has-lightbox")).toBe(
    true,
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(lowerClose).toHaveBeenCalledOnce();
  lower.unmount();
});

test("does not restore focus to a removed preview trigger", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const focus = vi.spyOn(trigger, "focus");
  const view = render(
    <ImageLightbox alt="预览" index={0} count={1} onClose={vi.fn()} />,
  );
  trigger.remove();
  view.unmount();
  expect(focus).not.toHaveBeenCalled();
});

function pointer(
  image: HTMLElement,
  type: string,
  x: number,
  y: number,
  pointerType = "mouse",
) {
  if (!image.setPointerCapture) {
    image.setPointerCapture = vi.fn();
    image.releasePointerCapture = vi.fn();
  }
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
    button: { value: 0 },
  });
  fireEvent(image, event);
}

test("supports keyboard and swipe navigation and restores page scrolling", () => {
  const onClose = vi.fn();
  const onPrevious = vi.fn();
  const onNext = vi.fn();
  render(
    <ImageLightbox
      src="/preview.png"
      alt="作品预览"
      index={1}
      count={3}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
    />,
  );

  const dialog = screen.getByRole("dialog", {
    name: "作品预览，第 2 张，共 3 张",
  });
  expect(dialog.parentElement).toBe(document.body);
  expect(document.documentElement.classList.contains("has-lightbox")).toBe(
    true,
  );
  fireEvent.keyDown(document, { key: "ArrowLeft" });
  fireEvent.keyDown(document, { key: "ArrowRight" });
  const image = screen.getByRole("img");
  pointer(image, "pointerdown", 120, 20, "touch");
  pointer(image, "pointerup", 20, 20, "touch");
  fireEvent.keyDown(document, { key: "Escape" });

  expect(onPrevious).toHaveBeenCalledTimes(1);
  expect(onNext).toHaveBeenCalledTimes(2);
  expect(onClose).toHaveBeenCalledTimes(1);

  cleanup();
  expect(document.documentElement.classList.contains("has-lightbox")).toBe(
    false,
  );
});

test("Alt wheel zooms around the pointer; mouse drags pan without navigating or closing", () => {
  const close = vi.fn(),
    next = vi.fn();
  render(
    <ImageLightbox
      src="/preview.png"
      alt="预览"
      index={0}
      count={2}
      onClose={close}
      onNext={next}
    />,
  );
  const image = screen.getByRole("img");
  const viewport = image.parentElement!;
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  fireEvent.wheel(viewport, { deltaY: -100, clientX: 300, clientY: 150 });
  expect(screen.getByLabelText("图片缩放比例").textContent).toBe("100%");
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    altKey: true,
    deltaY: -100,
    clientX: 300,
    clientY: 150,
  });
  fireEvent(viewport, wheel);
  expect(wheel.defaultPrevented).toBe(true);
  expect(screen.getByLabelText("图片缩放比例").textContent).toBe("122%");
  const transform = image.style.transform;
  expect(transform).toContain("translate(-22.140");
  pointer(image, "pointerdown", 100, 100);
  pointer(image, "pointermove", 200, 120);
  pointer(image, "pointerup", 200, 120);
  expect(image.style.transform).not.toBe(transform);
  fireEvent.click(viewport); // A synthetic trailing click must not close after dragging.
  expect(close).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "复位图片" }));
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
  fireEvent.click(image);
  expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(viewport);
  fireEvent.click(viewport);
  expect(close).toHaveBeenCalledTimes(1);
});

test("top preview traps Tab and programmatic focus without reaching the underlying editor", () => {
  render(
    <>
      <button>底层编辑操作</button>
      <ImageLightbox
        src="/preview.png"
        alt="预览"
        index={0}
        count={2}
        onClose={vi.fn()}
        onNext={vi.fn()}
      />
    </>,
  );
  const dialog = screen.getByRole("dialog");
  const first = within(dialog).getByRole("button", { name: "缩小图片" });
  const last = within(dialog).getByRole("button", { name: "下一张" });
  last.focus();
  const forward = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(last, forward);
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  screen.getByRole("button", { name: "底层编辑操作" }).focus();
  expect(document.activeElement).toBe(first);
});

test("a newer native dialog owns keyboard and focus until it closes", () => {
  const close = vi.fn();
  render(
    <ImageLightbox
      src="/preview.png"
      alt="预览"
      index={0}
      count={1}
      onClose={close}
    />,
  );
  const overlay = document.createElement("dialog");
  overlay.open = true;
  const stay = document.createElement("button");
  stay.textContent = "继续编辑";
  overlay.append(stay);
  document.body.append(overlay);
  stay.focus();
  expect(document.activeElement).toBe(stay);
  const tab = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(stay, tab);
  expect(tab.defaultPrevented).toBe(false);
  fireEvent.keyDown(stay, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  overlay.remove();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("zoom is bounded, touch pans when enlarged, and only changing page resets the view", () => {
  const close = vi.fn(),
    next = vi.fn();
  const props = {
    alt: "预览",
    index: 0,
    count: 2,
    onClose: close,
    onNext: next,
  };
  const { rerender } = render(
    <ImageLightbox {...props} thumbnailSrc="/thumb.png" loading />,
  );
  for (let i = 0; i < 15; i++)
    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
  expect(screen.getByLabelText("图片缩放比例").textContent).toBe("300%");
  const image = screen.getByRole("img");
  pointer(image, "pointerdown", 100, 100, "touch");
  pointer(image, "pointermove", 20, 120, "touch");
  pointer(image, "pointerup", 20, 120, "touch");
  expect(next).not.toHaveBeenCalled();
  expect(image.style.transform).toBe("translate(-80px, 20px) scale(3)");
  rerender(<ImageLightbox {...props} src="/original.png" />);
  expect(screen.getByRole("img").style.transform).toBe(
    "translate(-80px, 20px) scale(3)",
  );
  for (let i = 0; i < 20; i++)
    fireEvent.click(screen.getByRole("button", { name: "缩小图片" }));
  expect(screen.getByLabelText("图片缩放比例").textContent).toBe("40%");
  rerender(<ImageLightbox {...props} index={1} src="/second.png" />);
  expect(screen.getByRole("img").style.transform).toBe(
    "translate(0px, 0px) scale(1)",
  );
});

test("optional footer remains focusable without replacing zoom or page navigation", () => {
  const close = vi.fn(),
    next = vi.fn();
  render(
    <ImageLightbox
      src="/samples/demo-work.png"
      alt="候选图片"
      index={0}
      count={2}
      onClose={close}
      onNext={next}
      footer={<button type="button">查找相似图</button>}
    />,
  );
  const preview = screen.getByRole("dialog");
  expect(preview.classList.contains("ui-lightbox--with-footer")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
  expect(screen.getByLabelText("图片缩放比例").textContent).toBe("120%");
  fireEvent.click(screen.getByRole("button", { name: "下一张" }));
  expect(next).toHaveBeenCalledOnce();
  screen.getByRole("button", { name: "查找相似图" }).focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "缩小图片" }),
  );
});
