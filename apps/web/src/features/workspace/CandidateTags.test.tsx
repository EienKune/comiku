import { afterEach, expect, test, vi } from "vitest";
import {
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows both rule directions within two matches, excludes all matches from ordinary tags, and has one exact overflow count", () => {
  render(
    <CandidateTags
      hashtags={["BA", "BlueArchive", "Other", "sketch", "art", "extra", "BA"]}
      matches={matches}
    />,
  );
  expect(screen.getByRole("button", { name: /↑ #BA/ }).title).toContain(
    "BA 作品",
  );
  expect(screen.getByRole("button", { name: /↓ #Other/ }).title).toContain(
    "其他作品",
  );
  expect(screen.queryByText("#BlueArchive")).toBeNull();
  expect(screen.getByText("#sketch")).toBeTruthy();
  expect(screen.getByText("#art")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "+2，查看全部原帖标签" }));
  const overview = screen.getByRole("dialog", { name: "全部原帖标签" });
  expect(within(overview).getAllByRole("listitem")).toHaveLength(6);
  expect(within(overview).getByText("#BlueArchive")).toBeTruthy();
  expect(within(overview).getAllByText(/优先标签 · BA 作品/)).toHaveLength(2);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("narrow cards show one ordinary tag and increase the same overflow count", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 250 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
  render(<CandidateTags hashtags={["one", "two", "three"]} matches={[]} />);
  expect(screen.getByText("#one")).toBeTruthy();
  expect(screen.queryByText("#two")).toBeNull();
  expect(
    screen.getByRole("button", { name: "+2，查看全部原帖标签" }),
  ).toBeTruthy();
});

test("empty tags leave no empty row and a rule chip can inspect all source tags without an overflow count", () => {
  const view = render(<CandidateTags hashtags={[]} matches={[]} />);
  expect(view.container.firstChild).toBeNull();
  view.rerender(<CandidateTags hashtags={["BA"]} matches={[matches[0]]} />);
  fireEvent.focus(screen.getByRole("button", { name: /↑ #BA/ }));
  expect(screen.getByRole("dialog", { name: "全部原帖标签" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /查看全部原帖标签/ })).toBeNull();
});

test("one source tag with both rule directions keeps both clues without counting it twice", () => {
  render(
    <CandidateTags
      hashtags={["BA", "ordinary", "last"]}
      matches={[
        matches[0],
        { ...matches[2], normalizedValue: "ba", displayValue: "BA" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /↑↓ #BA/ }));
  const overview = screen.getByRole("dialog", { name: "全部原帖标签" });
  expect(within(overview).getAllByRole("listitem")).toHaveLength(3);
  expect(within(overview).getByText("优先标签 · BA 作品")).toBeTruthy();
  expect(within(overview).getByText("降级标签 · 其他作品")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /查看全部原帖标签/ })).toBeNull();
});
