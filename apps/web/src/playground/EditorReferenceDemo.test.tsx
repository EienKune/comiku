import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { client } from "../features/account/api";
import { EditorReferenceDemo } from "./EditorReferenceDemo";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test("the reference Playground uses synthetic lookup records and production symbol controls without a network request", async () => {
  const get = vi.spyOn(client, "GET");
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  render(<EditorReferenceDemo />);
  const area = screen.getByLabelText("示例译文") as HTMLTextAreaElement;
  area.focus();
  area.setSelectionRange(0, 0);
  fireEvent.select(area);
  fireEvent.click(screen.getByRole("button", { name: "符号" }));
  fireEvent.click(screen.getByRole("button", { name: "插入或复制 ♡" }));
  expect(area.value.startsWith("♡")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "拟声词" }));
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "カチッ" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(screen.getByText("小物件扣合的短促声音。"));
  expect(get).not.toHaveBeenCalled();
});
