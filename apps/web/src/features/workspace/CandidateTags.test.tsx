import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { CandidateTags } from "./CandidateTags";

const matches = [
  {
    normalizedValue: "ba",
    displayValue: "BA",
    groupId: "a",
    groupName: "BA 作品",
    groupRevision: 1,
    direction: "priority" as const,
  },
  {
    normalizedValue: "bluearchive",
    displayValue: "BlueArchive",
    groupId: "a",
    groupName: "BA 作品",
    groupRevision: 1,
    direction: "priority" as const,
  },
  {
    normalizedValue: "other",
    displayValue: "Other",
    groupId: "b",
    groupName: "其他作品",
    groupRevision: 2,
    direction: "deprioritize" as const,
  },
];
let cardWidth = 250;
let tagWidth = 70;
let resize: ResizeObserverCallback | undefined;

beforeEach(() => {
  cardWidth = 250;
  tagWidth = 70;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const width = this.classList.contains("candidate-tags")
        ? cardWidth
        : this.hasAttribute("data-candidate-tag-measure")
          ? tagWidth
          : this.hasAttribute("data-candidate-more-measure")
            ? 30 + (this.textContent!.length - 2) * 8
            : this.hasAttribute("data-model-test")
              ? 90
              : 70;
      return {
        width,
        height: 26,
        x: 0,
        y: 0,
        top: 0,
        bottom: 26,
        left: 0,
        right: width,
        toJSON: () => ({}),
      };
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  // Keep geometry delivery deterministic; browser frame delivery is asynchronous.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fonts");
});
function flushResize() {
  act(() => {
    fireEvent(window, new Event("resize"));
    vi.runOnlyPendingTimers();
  });
}

test("fills the same two-row flow with neutral ordinary pills before counting every omitted source tag", () => {
  render(
    <CandidateTags
      hashtags={["one", "two", "three", "four", "five", "six", "seven", "ONE"]}
      matches={[]}
    />,
  );
  const pills = screen.getAllByRole("button", { name: /^#/ });
  expect(pills.map((pill) => pill.textContent)).toEqual([
    "#ONE",
    "#two",
    "#three",
    "#four",
    "#five",
  ]);
  expect(
    pills.every((pill) =>
      pill.firstElementChild?.classList.contains("ui-badge--neutral"),
    ),
  ).toBe(true);
  const more = screen.getByRole("button", { name: "+2，查看全部原帖标签" });
  fireEvent.click(more);
  expect(
    within(screen.getByRole("dialog")).getAllByRole("listitem"),
  ).toHaveLength(7);
});

test("keeps model and retry mounted once and reserves both rule directions before ordinary tags", () => {
  render(
    <CandidateTags
      hashtags={["sketch", "BA", "BlueArchive", "Other", "art", "extra"]}
      matches={matches}
      model={
        <>
          <button data-model-test>模型分数</button>
          <button data-model-test>重试识别</button>
        </>
      }
    />,
  );
  expect(screen.getAllByRole("button", { name: "模型分数" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "重试识别" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: /↑ #BA/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /↓ #Other/ })).toBeTruthy();
  const more = screen.getByRole("button", { name: "+4，查看全部原帖标签" });
  fireEvent.click(more);
  const overview = screen.getByRole("dialog");
  expect(within(overview).getAllByRole("listitem")).toHaveLength(6);
  expect(within(overview).getAllByText("优先标签 · BA 作品")).toHaveLength(2);
  expect(within(overview).getByText("降级标签 · 其他作品")).toBeTruthy();
});

test("recomputes exact overflow on shrinking and growing even without ResizeObserver", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  render(
    <CandidateTags
      hashtags={["one", "two", "three", "four", "five", "six"]}
      matches={[]}
    />,
  );
  expect(screen.queryByRole("button", { name: /查看全部原帖标签/ })).toBeNull();
  cardWidth = 160;
  flushResize();
  expect(
    screen.getByRole("button", { name: "+3，查看全部原帖标签" }),
  ).toBeTruthy();
  cardWidth = 500;
  flushResize();
  expect(screen.queryByRole("button", { name: /查看全部原帖标签/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: /^#/ })).toHaveLength(6);
});

test("very long matches preserve both directions and accessible full text without a third row", () => {
  tagWidth = 1000;
  const long = "a".repeat(150);
  const other = "b".repeat(150);
  render(
    <CandidateTags
      hashtags={[long, "ordinary", other]}
      matches={[
        { ...matches[0], normalizedValue: long },
        { ...matches[2], normalizedValue: other },
      ]}
      model={
        <>
          <button data-model-test>模型分数</button>
          <button data-model-test>重试识别</button>
        </>
      }
    />,
  );
  expect(screen.getByRole("button", { name: `↑ #${long}` })).toBeTruthy();
  expect(screen.getByRole("button", { name: `↓ #${other}` })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "+1，查看全部原帖标签" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `↑ #${long}` }));
  expect(within(screen.getByRole("dialog")).getByText(`#${long}`)).toBeTruthy();
});

test("one source tag with both rule directions keeps both clues and source-normalized deduplication", () => {
  render(
    <CandidateTags
      hashtags={["ＢＡ", " #BA ", "ordinary"]}
      matches={[
        matches[0],
        { ...matches[2], normalizedValue: "ba", displayValue: "BA" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /↑↓ #BA/ }));
  const overview = screen.getByRole("dialog");
  expect(within(overview).getAllByRole("listitem")).toHaveLength(2);
  expect(within(overview).getByText("优先标签 · BA 作品")).toBeTruthy();
  expect(within(overview).getByText("降级标签 · 其他作品")).toBeTruthy();
});

test("popup retains focus, arrow, Tab and Escape interaction and handles Window resize targets", () => {
  render(<CandidateTags hashtags={["BA"]} matches={[matches[0]]} />);
  const trigger = screen.getByRole("button", { name: /↑ #BA/ });
  act(() => trigger.focus());
  let overview = screen.getByRole("dialog");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(document.activeElement).toBe(overview);
  flushResize();
  expect(screen.getByRole("dialog")).toBe(overview);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  overview = screen.getByRole("dialog");
  fireEvent.keyDown(trigger, { key: "Tab" });
  expect(document.activeElement).toBe(overview);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("empty content leaves no row and the measurement rail is inert without model controls", () => {
  const view = render(<CandidateTags hashtags={[]} matches={[]} />);
  expect(view.container.firstChild).toBeNull();
  view.rerender(
    <CandidateTags
      hashtags={["one"]}
      matches={[]}
      model={<button data-model-test>分数</button>}
    />,
  );
  const rail = view.container.querySelector(".candidate-tags__measure")!;
  expect(rail.getAttribute("aria-hidden")).toBe("true");
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(rail.querySelector("button")).toBeNull();
  expect(rail.textContent).not.toContain("分数");
});

test("observer notifications are coalesced and do not rerender or remount model controls", () => {
  const mounted = vi.fn();
  function Model() {
    mounted();
    return <button data-model-test>模型分数</button>;
  }
  render(
    <CandidateTags
      hashtags={["one", "two", "three"]}
      matches={[]}
      model={<Model />}
    />,
  );
  const before = mounted.mock.calls.length;
  act(() => {
    resize?.([], {} as ResizeObserver);
    resize?.([], {} as ResizeObserver);
    resize?.([], {} as ResizeObserver);
    vi.runOnlyPendingTimers();
  });
  expect(mounted.mock.calls.length).toBe(before);
});

test("remeasures after web fonts finish and cancels pending measurements on unmount", () => {
  const fonts = new EventTarget();
  Object.defineProperty(fonts, "ready", { value: new Promise(() => {}) });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts,
  });
  const view = render(
    <CandidateTags
      hashtags={["one", "two", "three", "four", "five", "six"]}
      matches={[]}
    />,
  );
  expect(screen.queryByRole("button", { name: /查看全部原帖标签/ })).toBeNull();
  tagWidth = 150;
  act(() => {
    fonts.dispatchEvent(new Event("loadingdone"));
    vi.runOnlyPendingTimers();
  });
  expect(
    screen.getByRole("button", { name: "+4，查看全部原帖标签" }),
  ).toBeTruthy();
  act(() => {
    fonts.dispatchEvent(new Event("loadingdone"));
  });
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("font load failures remeasure the fallback font without polling", () => {
  const fonts = new EventTarget();
  Object.defineProperty(fonts, "ready", { value: new Promise(() => {}) });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts,
  });
  render(
    <CandidateTags
      hashtags={["one", "two", "three", "four", "five", "six"]}
      matches={[]}
    />,
  );
  tagWidth = 150;
  act(() => {
    fonts.dispatchEvent(new Event("loadingerror"));
    vi.runOnlyPendingTimers();
  });
  expect(
    screen.getByRole("button", { name: "+4，查看全部原帖标签" }),
  ).toBeTruthy();
});

test("hover can cross into the overview and a hidden resize anchor dismisses it", () => {
  render(
    <CandidateTags
      hashtags={["one", "two", "three", "four", "five", "six"]}
      matches={[]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "#six" });
  fireEvent.pointerEnter(trigger);
  const overview = screen.getByRole("dialog");
  fireEvent.pointerLeave(trigger);
  fireEvent.pointerEnter(overview);
  act(() => vi.runOnlyPendingTimers());
  expect(screen.getByRole("dialog")).toBe(overview);
  cardWidth = 160;
  flushResize();
  expect(screen.queryByRole("button", { name: "#six" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("overview opens outside the whole two-row tag block instead of covering its second row", () => {
  const measure = vi
    .mocked(HTMLElement.prototype.getBoundingClientRect)
    .getMockImplementation()!;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
    function (this: HTMLElement) {
      const rect = measure.call(this);
      return this.classList.contains("candidate-tags")
        ? { ...rect, top: 20, bottom: 100, height: 80 }
        : rect;
    },
  );
  render(<CandidateTags hashtags={["BA"]} matches={[matches[0]]} />);
  fireEvent.click(screen.getByRole("button", { name: /↑ #BA/ }));
  expect(screen.getByRole("dialog").style.top).toBe("108px");
});
