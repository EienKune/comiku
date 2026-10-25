import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageLightbox } from "./ImageLightbox";

afterEach(() => cleanup());

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
