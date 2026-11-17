import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorReferenceTools } from "./EditorReferenceTools";
afterEach(cleanup);
test("opening symbol controls preserves the supplied characters and order without editing until a choice, with Escape restoring focus", () => {
  const insert = vi.fn();
  render(<EditorReferenceTools insert={insert} status="" />);
  const opener = screen.getByRole("button", { name: "符号" });
  opener.focus();
  fireEvent.click(opener);
  expect(insert).not.toHaveBeenCalled();
  expect(opener.getAttribute("aria-expanded")).toBe("true");
  const expected = Array.from("…～♡♠「」『』（）○●※☆★□◇♪♬·〆");
  const choices = screen
    .getByRole("group", { name: "常用符号" })
    .querySelectorAll(".editor-symbol-buttons button");
  expect(Array.from(choices, (button) => button.textContent)).toEqual(expected);
  for (const symbol of expected)
    fireEvent.click(
      screen.getByRole("button", { name: `插入或复制 ${symbol}` }),
    );
  expect(insert.mock.calls.map(([symbol]) => symbol)).toEqual(expected);
  fireEvent.keyDown(screen.getByRole("group", { name: "常用符号" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("group", { name: "常用符号" })).toBeNull();
  expect(document.activeElement).toBe(opener);
});
