import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Avatar } from "./Avatar";
afterEach(cleanup);

test.each([
  ["未来", "未"],
  ["👩🏽‍🎨 artist", "👩🏽‍🎨"],
  ["e\u0301clair", "e\u0301"],
  ["🇨🇳 author", "🇨🇳"],
  ["  ", "?"],
])("avatar keeps the first complete character of %s", (name, expected) => {
  render(<Avatar name={name} />);
  expect(screen.getByRole("img").textContent).toBe(expected);
  if (!name.trim())
    expect(screen.getByRole("img", { name: "头像" })).toBeTruthy();
});
test("avatar falls back after a read failure and displays a replacement", () => {
  const failed = vi.fn();
  const { container, rerender } = render(
    <Avatar name="未来" src="/old.png" onError={failed} />,
  );
  fireEvent.error(container.querySelector("img")!);
  expect(screen.getByRole("img", { name: "未来的头像" }).textContent).toBe(
    "未",
  );
  expect(failed).toHaveBeenCalledTimes(1);
  rerender(<Avatar name="未来" src="/new.png" />);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/new.png");
});
