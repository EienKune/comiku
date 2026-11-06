import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client, queryClient } from "../account/api";
import { AuthorDetailPage } from "./BusinessPages";
const ok = (data: unknown) => ({ data, response: new Response() }) as never;
const author = {
  id: "author",
  revision: 4,
  displayName: "合成作者",
  authorizationStatus: "authorized",
  sourceLanguage: "ja",
  tags: [],
  externalAccounts: [],
  avatarAvailable: false,
};
const item = {
  id: "evidence",
  url: "https://images.invalid/evidence.png",
  size: 100,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
});
function open() {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/authors/author"]}>
        <Routes>
          <Route
            element={
              <Outlet
                context={{
                  permissions: [
                    "authors:read",
                    "authors:manage",
                    "authors:sensitive",
                  ],
                }}
              />
            }
          >
            <Route path="/authors/:id" element={<AuthorDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
test("evidence loading, failed read and confirmed empty are distinct and cached evidence survives a failed refresh", async () => {
  let reject!: (e: Error) => void;
  const pending = new Promise<never>((_r, j) => (reject = j));
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async (path) =>
      path === "/api/authors/{id}/authorization-evidence"
        ? pending
        : ok(
            path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
              ? author
              : [],
          ),
    );
  open();
  await screen.findByText("正在读取凭证…");
  expect(screen.queryByText(/有效授权尚未附凭证/)).toBeNull();
  await act(async () => reject(Error("synthetic read")));
  await screen.findByText(/凭证读取失败/);
  expect(screen.queryByText(/有效授权尚未附凭证/)).toBeNull();
  get.mockImplementation(async (path) =>
    ok(
      path === "/api/authors/{id}/authorization-evidence"
        ? []
        : path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
          ? author
          : [],
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
  await screen.findByText(/有效授权尚未附凭证/);
  await act(async () =>
    queryClient.setQueryData(["author-evidence", "author"], [item]),
  );
  get.mockImplementation(async (path) => {
    if (path === "/api/authors/{id}/authorization-evidence")
      throw Error("background read");
    return ok(
      path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
        ? author
        : [],
    );
  });
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["author-evidence", "author"],
    });
  });
  fireEvent.click(screen.getByText("授权凭证"));
  expect(screen.getByRole("img", { name: "授权凭证 1" })).toBeTruthy();
  expect(screen.getByText(/凭证读取失败/)).toBeTruthy();
});
test("evidence removal defaults to cancel and pins the observed revision without altering authorization", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/{id}/authorization-evidence"
        ? [item]
        : path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
          ? author
          : [],
    ),
  );
  const remove = vi.spyOn(client, "DELETE").mockResolvedValue(ok([]));
  open();
  fireEvent.click(await screen.findByRole("button", { name: "移除" }));
  let dialog = screen.getByRole("dialog");
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "取消" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  dialog = screen.getByRole("dialog");
  await act(async () =>
    queryClient.setQueryData(["author", "author"], { ...author, revision: 5 }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "确认移除" }));
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  expect(remove.mock.calls[0][1]).toMatchObject({
    body: { expectedRevision: 4 },
  });
  expect(queryClient.getQueryData(["author", "author"])).toMatchObject({
    authorizationStatus: "authorized",
  });
});
