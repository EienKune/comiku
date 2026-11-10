import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AuthorArchiveControl } from "./AuthorArchiveControl";
import { client, queryClient } from "../account/api";
import type { components } from "@comiku/api-client";
const author = {
  id: "author",
  displayName: "合成作者",
  revision: 4,
} as components["schemas"]["AuthorDto"];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
});
test("deletion requires exact nickname, defaults to cancel and keeps its original revision", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const remove = vi.spyOn(client, "DELETE").mockResolvedValue({
    error: { message: "作者已更新" },
    response: new Response(null, { status: 409 }),
  } as never);
  const { rerender } = render(
    <MemoryRouter>
      <AuthorArchiveControl author={author} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "删除作者" }));
  let dialog = screen.getByRole("dialog");
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "取消" }),
  );
  expect(
    within(dialog)
      .getByRole("button", { name: "确认删除" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("确认作者昵称"), {
    target: { value: "合成作者 " },
  });
  expect(
    within(dialog)
      .getByRole("button", { name: "确认删除" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "删除作者" }));
  dialog = screen.getByRole("dialog");
  rerender(
    <MemoryRouter>
      <AuthorArchiveControl author={{ ...author, revision: 5 }} />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("确认作者昵称"), {
    target: { value: "合成作者" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
  await screen.findByRole("alert");
  expect(remove.mock.calls[0][1]).toMatchObject({
    body: { expectedRevision: 4 },
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "取消" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
});
