import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorReferenceTools } from "./EditorReferenceTools";
afterEach(cleanup);
test("opening symbol controls makes no edit and exposes six keyboard-accessible choices with Escape restoring the opener", () => {
  const insert = vi.fn();
  render(<EditorReferenceTools insert={insert} status="" />);
  const opener = screen.getByRole("button", { name: "符号" });
  opener.focus();
  fireEvent.click(opener);
  expect(insert).not.toHaveBeenCalled();
  expect(opener.getAttribute("aria-expanded")).toBe("true");
  expect(
    screen
      .getByRole("group", { name: "常用符号" })
      .querySelectorAll(".editor-symbol-buttons button"),
  ).toHaveLength(6);
  fireEvent.click(screen.getByRole("button", { name: "插入或复制 ☆" }));
  expect(insert).toHaveBeenCalledWith("☆");
  fireEvent.keyDown(screen.getByRole("group", { name: "常用符号" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("group", { name: "常用符号" })).toBeNull();
  expect(document.activeElement).toBe(opener);
});
