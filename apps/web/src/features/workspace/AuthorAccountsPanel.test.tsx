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
type Capability = components["schemas"]["SourceCapabilityDto"];
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

test("unavailable persisted seven-day mode keeps its actual label", async () => {
  const saved = {
    ...pixiv,
    fetchEnabled: true,
    firstSyncMode: "last_7_days" as const,
  };
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    success(
      path === "/api/authors/sources" || String(path).endsWith("archived")
        ? []
        : [saved],
    ),
  );
  setup([saved]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  const select = screen.getByRole("combobox", {
    name: "首次同步范围",
  }) as HTMLButtonElement;
  expect(select.textContent).toContain("最近 7 天");
  expect(select.textContent).toContain("当前不可用");
  expect(select.disabled).toBe(true);
});

test("changing a platform identity requires an explicit replacement confirmation", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    success(
      String(path).endsWith("archived") || path === "/api/authors/sources"
        ? []
        : [pixiv],
    ),
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
    success(
      path === "/api/authors/sources"
        ? []
        : String(path).endsWith("archived")
          ? archived
          : live,
    ),
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
    success(
      String(path).endsWith("archived") || path === "/api/authors/sources"
        ? []
        : [x],
    ),
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

const pixivCapability: Capability = {
  platform: "pixiv",
  adapterKey: "pixiv_fixture",
  priority: 10,
  metered: false,
  available: true,
  supportedFirstSyncModes: ["none", "last_24_hours"],
};

function collectionFixture(
  accounts: Account[] = [],
  capabilities: Capability[] | Error = [pixivCapability],
) {
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/authors/sources") {
      if (capabilities instanceof Error) throw capabilities;
      return success(capabilities);
    }
    return success(String(path).endsWith("archived") ? [] : accounts);
  });
}

test("configured Pixiv collection stays off by default and saves an explicitly selected first-sync window", async () => {
  collectionFixture();
  const post = vi.spyOn(client, "POST").mockResolvedValue(success(pixiv));
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
  const checkbox = await screen.findByRole("checkbox", {
    name: "启用自动抓取",
  });
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("combobox", { name: "首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "最近 24 小时" }));
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: {
      platform: "pixiv",
      fetchEnabled: true,
      firstSyncMode: "last_24_hours",
    },
  });
});

test("Pixiv exposes only windows supported by an available adapter", async () => {
  collectionFixture(
    [pixiv],
    [
      { ...pixivCapability, supportedFirstSyncModes: ["none"] },
      { ...pixivCapability, adapterKey: "pixiv_offline", available: false },
    ],
  );
  setup([pixiv]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  await screen.findByRole("checkbox", { name: "启用自动抓取" });
  fireEvent.click(screen.getByRole("combobox", { name: "首次同步范围" }));
  expect(screen.getByRole("option", { name: "仅后续内容" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "最近 24 小时" })).toBeNull();
});

test("editing a Pixiv nickname preserves enabled collection if capabilities cannot be read", async () => {
  const enabled = {
    ...pixiv,
    fetchEnabled: true,
    firstSyncMode: "last_24_hours" as const,
  };
  collectionFixture([enabled], new Error("能力读取失败"));
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(enabled));
  setup([enabled]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  expect(
    (screen.getByRole("checkbox", { name: "启用自动抓取" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("平台显示昵称（可选）"), {
    target: { value: "保留抓取设置" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: {
      displayNameSnapshot: "保留抓取设置",
      fetchEnabled: true,
      firstSyncMode: "last_24_hours",
    },
  });
});

test.each([
  ["pixiv", "removed", []],
  ["pixiv", "unavailable", [{ ...pixivCapability, available: false }]],
  ["pixiv", "unreadable", new Error("能力读取失败")],
  [
    "pixiv",
    "missing the stored window",
    [{ ...pixivCapability, supportedFirstSyncModes: ["none"] }],
  ],
  ["x", "removed", []],
  ["x", "unreadable", new Error("能力读取失败")],
] as [string, string, Capability[] | Error][])(
  "an enabled %s account can pause and retain its window when capabilities are %s",
  async (platform, _name, capabilities) => {
    const enabled: Account = {
      ...pixiv,
      platform,
      handle: platform === "x" ? "fixture" : null,
      profileUrl: platform === "x" ? "https://x.com/fixture" : pixiv.profileUrl,
      fetchEnabled: true,
      firstSyncMode: "last_24_hours",
    };
    collectionFixture([enabled], capabilities);
    const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(enabled));
    setup([enabled]);
    fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
    const checkbox = screen.getByRole("checkbox", {
      name: "启用自动抓取",
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0][1]).toMatchObject({
      body: {
        fetchEnabled: false,
        firstSyncMode: "last_24_hours",
        expectedRevision: 2,
      },
    });
  },
);

test("an unavailable Pixiv adapter cannot enable collection", async () => {
  collectionFixture([pixiv], [{ ...pixivCapability, available: false }]);
  setup([pixiv]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  expect(screen.queryByRole("checkbox", { name: "启用自动抓取" })).toBeNull();
});

test("configured Pixiv adapter channels can be enabled from the account list", async () => {
  const account: Account = {
    ...pixiv,
    adapterStates: [
      {
        adapterKey: "pixiv_fixture",
        enabled: false,
        available: true,
        health: "disabled",
        revision: 3,
        consecutiveFailures: 0,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextAttemptAt: null,
        lastErrorMessage: null,
      },
    ],
  };
  collectionFixture([account]);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(account));
  setup([account]);
  const button = await screen.findByRole("button", { name: "启用通道" });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(button);
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0]).toMatchObject([
    "/api/authors/{authorId}/accounts/{id}/adapters/{adapterKey}",
    {
      params: {
        path: { authorId: "author", id: "pixiv", adapterKey: "pixiv_fixture" },
      },
      body: { enabled: true, expectedRevision: 3 },
    },
  ]);
});

test("a removed Pixiv channel can still be paused from its persisted account state", async () => {
  const account: Account = {
    ...pixiv,
    adapterStates: [
      {
        adapterKey: "pixiv_fixture",
        enabled: true,
        available: false,
        health: "unavailable",
        revision: 3,
        consecutiveFailures: 0,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextAttemptAt: null,
        lastErrorMessage: null,
      },
    ],
  };
  collectionFixture([account], []);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(account));
  setup([account]);
  const button = await screen.findByRole("button", { name: "停用通道" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    params: {
      path: { authorId: "author", id: "pixiv", adapterKey: "pixiv_fixture" },
    },
    body: { enabled: false, expectedRevision: 3 },
  });
});

test("Pixiv can explicitly select seven days while retaining the disabled default", async () => {
  collectionFixture(
    [],
    [
      {
        ...pixivCapability,
        supportedFirstSyncModes: ["none", "last_24_hours", "last_7_days"],
      },
    ],
  );
  const post = vi.spyOn(client, "POST").mockResolvedValue(success(pixiv));
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
  const checkbox = await screen.findByRole("checkbox", {
    name: "启用自动抓取",
  });
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("combobox", { name: "首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { firstSyncMode: "last_7_days", fetchEnabled: true },
  });
});
