import { afterEach, expect, test, vi } from "vitest";
import {
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
import { AuthorAccountsPanel } from "./AuthorAccountsPanel";
import type { components } from "@comiku/api-client";
type Account = components["schemas"]["ExternalAccountDto"];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
});
function setup(accounts: Account[] = [], manage = true) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route
            element={
              <Outlet
                context={{
                  permissions: manage ? ["authors:manage"] : ["authors:read"],
                }}
              />
            }
          >
            <Route
              path="/"
              element={
                <AuthorAccountsPanel
                  authorId="author"
                  initialAccounts={accounts}
                />
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const success = (data: unknown) =>
  ({ data, response: new Response(null, { status: 200 }) }) as never;
const pixiv: Account = {
  id: "pixiv",
  authorId: "author",
  platform: "pixiv",
  externalUserId: "123456",
  handle: null,
  profileUrl: "https://www.pixiv.net/users/123456",
  displayNameSnapshot: "昵称",
  avatarAvailable: false,
  fetchEnabled: false,
  firstSyncMode: "none",
  providerAvailable: false,
  revision: 2,
  lastCheckedAt: null,
  adapterStates: [],
  deletedAt: null,
};

test("changing a platform identity requires an explicit replacement confirmation", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    success(String(path).endsWith("archived") ? [] : [pixiv]),
  );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(
      success({ ...pixiv, id: "replacement", externalUserId: "123457" }),
    );
  setup([pixiv]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
    target: { value: "123457" },
  });
  const confirmation = screen.getByRole("checkbox", {
    name: /确认更换平台身份/,
  });
  expect(patch).not.toHaveBeenCalled();
  fireEvent.click(confirmation);
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { externalUserId: "123457", expectedRevision: 2 },
  });
});

test("Pixiv uses the numeric identity and exposes edit, confirmed unbind and restore with refreshed data", async () => {
  let live: Account[] = [];
  let archived: Account[] = [];
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    success(String(path).endsWith("archived") ? archived : live),
  );
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    live = [pixiv];
    archived = [];
    return success(pixiv);
  });
  const patch = vi.spyOn(client, "PATCH").mockImplementation(async () => {
    live = [{ ...pixiv, displayNameSnapshot: "新昵称", revision: 3 }];
    return success(live[0]);
  });
  const remove = vi.spyOn(client, "DELETE").mockImplementation(async () => {
    archived = [{ ...live[0], deletedAt: "2026-10-03T00:00:00Z", revision: 4 }];
    live = [];
    return success({ ok: true });
  });
  setup();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "关联 Pixiv" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "关联 Pixiv" }));
  fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
    target: { value: "123456" },
  });
  expect(screen.queryByLabelText("Pixiv 账号名")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: {
      platform: "pixiv",
      externalUserId: "123456",
      handle: null,
      fetchEnabled: false,
      firstSyncMode: "none",
    },
  });
  expect(
    (screen.getByRole("button", { name: "关联 Pixiv" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "编辑账号" }));
  fireEvent.change(screen.getByLabelText("平台显示昵称（可选）"), {
    target: { value: "新昵称" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await screen.findByText("新昵称");
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { expectedRevision: 2, displayNameSnapshot: "新昵称" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解绑账号" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(remove.mock.calls[0][1]).toMatchObject({
    body: { expectedRevision: 3 },
  });
  fireEvent.click(screen.getByText("已解绑账号"));
  fireEvent.click(await screen.findByRole("button", { name: "恢复关联" }));
  await waitFor(() => expect(post.mock.calls.at(-1)?.[0]).toContain("restore"));
});

test("X profile sync passes the current author and edits the same identity; viewers receive no management form", async () => {
  const x: Account = {
    ...pixiv,
    platform: "x",
    handle: "artist",
    externalUserId: "777",
    fetchEnabled: true,
    firstSyncMode: "last_24_hours",
  };
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    success(String(path).endsWith("archived") ? [] : [x]),
  );
  const post = vi.spyOn(client, "POST").mockResolvedValue(
    success({
      externalUserId: "777",
      handle: "artist",
      displayName: "同步昵称",
      avatarFileObjectId: null,
      avatarUrl: null,
      profileUrl: "https://x.com/artist",
      adapterKey: "fixture",
      syncedAt: "2026-10-03T00:00:00Z",
    }),
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(x));
  setup([x]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("平台显示昵称（可选）") as HTMLInputElement).value,
    ).toBe("同步昵称"),
  );
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { handle: "artist", authorId: "author" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "保存账号",
    }),
  );
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { externalUserId: "777", expectedRevision: 2 },
  });
  cleanup();
  queryClient.clear();
  setup([x], false);
  expect(screen.queryByRole("button", { name: "编辑账号" })).toBeNull();
  expect(screen.queryByRole("button", { name: "关联 X" })).toBeNull();
});
