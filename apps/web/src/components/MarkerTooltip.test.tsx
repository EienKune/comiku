import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MarkerTooltip } from "./MarkerTooltip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pointerEnter(
  element: HTMLElement,
  pointerType = "mouse",
  buttons = 0,
) {
  const event = new Event("pointerover", { bubbles: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    buttons: { value: buttons },
  });
  fireEvent(element, event);
}

test("previews text immediately and closes on leaving, dragging or scrolling", () => {
  const onPointerDown = vi.fn();
  const onClick = vi.fn();
  const view = render(
    <MarkerTooltip text={"测试译文\n第二行"}>
      <button onPointerDown={onPointerDown} onClick={onClick}>
        标记
      </button>
    </MarkerTooltip>,
  );
  const marker = screen.getByRole("button", { name: "标记" });
  pointerEnter(marker);
  expect(screen.getByRole("tooltip").textContent).toBe("测试译文\n第二行");
  expect(marker.getAttribute("aria-describedby")).toBe(
    screen.getByRole("tooltip").id,
  );
  fireEvent.pointerDown(marker);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(onPointerDown).toHaveBeenCalledTimes(1);
  fireEvent.click(marker);
  expect(onClick).toHaveBeenCalledTimes(1);

  pointerEnter(marker);
  expect(screen.getByRole("tooltip")).toBeTruthy();
  fireEvent.pointerOut(marker);
  expect(screen.queryByRole("tooltip")).toBeNull();
  pointerEnter(marker, "mouse", 1);
  expect(screen.queryByRole("tooltip")).toBeNull();
  pointerEnter(marker);
  fireEvent.scroll(window);
  expect(screen.queryByRole("tooltip")).toBeNull();
  pointerEnter(marker);
  view.unmount();
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("keyboard focus previews immediately; touch does not open a hover preview", () => {
  vi.useFakeTimers();
  render(
    <MarkerTooltip text="">
      <button>标记</button>
    </MarkerTooltip>,
  );
  const marker = screen.getByRole("button", { name: "标记" });
  pointerEnter(marker, "touch");
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(marker);
  expect(screen.getByRole("tooltip").textContent).toBe("尚未填写译文");
  fireEvent.keyDown(marker, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(marker);
});
