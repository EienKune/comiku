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

const resolvedPixiv: components["schemas"]["ResolvedPixivProfileDto"] = {
  externalUserId: "123456",
  handle: null,
  displayName: "同步昵称",
  profileUrl: "https://www.pixiv.net/users/123456",
  avatarFileObjectId: "avatar",
  avatarUrl: "https://storage.invalid/avatar",
  adapterKey: "pixiv_fixture",
  syncedAt: "2026-11-06T00:00:00Z",
  profileProof: "pixiv-proof",
};

test.each([true, false])(
  "bound Pixiv sync previews avatar=%s and saves proof without replacing identity or collection settings",
  async (avatarAvailable) => {
    const saved = {
      ...pixiv,
      notes: "keep note",
      fetchEnabled: false,
      firstSyncMode: "last_7_days" as const,
    };
    collectionFixture([saved]);
    const post = vi.spyOn(client, "POST").mockResolvedValue(
      success({
        ...resolvedPixiv,
        ...(!avatarAvailable
          ? { avatarUrl: null, avatarFileObjectId: null }
          : {}),
      }),
    );
    const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(saved));
    setup([saved]);
    fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
    fireEvent.change(screen.getByLabelText("账号备注（可选）"), {
      target: { value: "edited note" },
    });
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("平台显示昵称（可选）") as HTMLInputElement)
          .value,
      ).toBe("同步昵称"),
    );
    expect(
      Boolean(screen.queryByRole("img", { name: "同步的 Pixiv 头像" })),
    ).toBe(avatarAvailable);
    expect(
      (screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement).value,
    ).toBe("123456");
    expect(post.mock.calls[0]).toEqual([
      "/api/authors/pixiv-profile/resolve",
      {
        body: {
          authorId: "author",
          accountId: "pixiv",
          externalUserId: "123456",
        },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0][1]).toMatchObject({
      body: {
        displayNameSnapshot: "同步昵称",
        notes: "edited note",
        fetchEnabled: false,
        firstSyncMode: "last_7_days",
        ...(avatarAvailable
          ? { avatarFileObjectId: "avatar", profileProof: "pixiv-proof" }
          : {}),
        expectedRevision: 2,
      },
    });
    expect(patch.mock.calls[0][1]).not.toHaveProperty("body.externalUserId");
    if (!avatarAvailable)
      expect(patch.mock.calls[0][1]).not.toHaveProperty("body.profileProof");
  },
);

test("bound Pixiv rejects another profile identity and still permits metadata maintenance", async () => {
  collectionFixture([pixiv]);
  vi.spyOn(client, "POST").mockResolvedValue(
    success({ ...resolvedPixiv, externalUserId: "999999" }),
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(pixiv));
  setup([pixiv]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement).value,
  ).toBe("123456");
  expect(
    (screen.getByLabelText("平台显示昵称（可选）") as HTMLInputElement).value,
  ).toBe("昵称");
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).not.toHaveProperty("body.profileProof");
});

test.each(["changed-input", "cleared-proof"])(
  "new Pixiv binding keeps edited identity free of an old %s profile",
  async (scenario) => {
    collectionFixture([]);
    let release!: (value: never) => void;
    const post = vi.spyOn(client, "POST").mockImplementation(async (path) =>
      path === "/api/authors/pixiv-profile/resolve"
        ? new Promise<never>((resolve) => {
            release = resolve;
          })
        : success(pixiv),
    );
    setup();
    const bind = await screen.findByRole("button", { name: "关联 Pixiv" });
    await waitFor(() =>
      expect((bind as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(bind);
    fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
    );
    if (scenario === "changed-input")
      fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
        target: { value: "654321" },
      });
    await act(async () => {
      release(success(resolvedPixiv));
    });
    if (scenario === "changed-input") await screen.findByRole("alert");
    else {
      await screen.findByRole("img", { name: "同步的 Pixiv 头像" });
      fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
        target: { value: "654321" },
      });
    }
    expect(screen.queryByRole("img", { name: "同步的 Pixiv 头像" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({
      body: { platform: "pixiv", externalUserId: "654321" },
    });
    expect(post.mock.calls[1][1]).not.toHaveProperty("body.profileProof");
  },
);

test("new Pixiv binding saves its resolved profile and deliberate collection settings", async () => {
  collectionFixture([]);
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path) =>
      success(
        path === "/api/authors/pixiv-profile/resolve" ? resolvedPixiv : pixiv,
      ),
    );
  setup();
  const bind = await screen.findByRole("button", { name: "关联 Pixiv" });
  await waitFor(() => expect((bind as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(bind);
  const id = screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement;
  expect(id.readOnly).toBe(false);
  fireEvent.change(id, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "启用自动抓取" }));
  fireEvent.change(screen.getByLabelText("账号备注（可选）"), {
    target: { value: "binding note" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByRole("img", { name: "同步的 Pixiv 头像" });
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0][1]).toEqual({
    body: { authorId: "author", externalUserId: "123456" },
  });
  expect(post.mock.calls[1][1]).toMatchObject({
    body: {
      platform: "pixiv",
      externalUserId: "123456",
      displayNameSnapshot: "同步昵称",
      avatarFileObjectId: "avatar",
      profileProof: "pixiv-proof",
      notes: "binding note",
      fetchEnabled: false,
      firstSyncMode: "last_24_hours",
    },
  });
});

test.each([true, false])(
  "new Pixiv binding retains a previous avatar on a null refresh only when evidence is fresh=%s",
  async (fresh) => {
    collectionFixture([]);
    let syncCount = 0;
    const post = vi.spyOn(client, "POST").mockImplementation(async (path) =>
      success(
        path === "/api/authors/pixiv-profile/resolve"
          ? ++syncCount === 1
            ? {
                ...resolvedPixiv,
                syncedAt: new Date(
                  Date.now() - (fresh ? 0 : 600_001),
                ).toISOString(),
              }
            : {
                ...resolvedPixiv,
                displayName: "Latest nickname",
                avatarFileObjectId: null,
                avatarUrl: null,
                profileProof: "fresh-null-proof",
                syncedAt: new Date().toISOString(),
              }
          : pixiv,
      ),
    );
    setup();
    const bind = await screen.findByRole("button", { name: "关联 Pixiv" });
    await waitFor(() =>
      expect((bind as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(bind);
    fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
    );
    await screen.findByRole("img", { name: "同步的 Pixiv 头像" });
    fireEvent.click(
      screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("平台显示昵称（可选）") as HTMLInputElement)
          .value,
      ).toBe("Latest nickname"),
    );
    expect(
      Boolean(screen.queryByRole("img", { name: "同步的 Pixiv 头像" })),
    ).toBe(fresh);
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][1]).toMatchObject({
      body: {
        externalUserId: "123456",
        displayNameSnapshot: "Latest nickname",
        avatarFileObjectId: fresh ? "avatar" : null,
        profileProof: fresh ? "pixiv-proof" : "fresh-null-proof",
      },
    });
  },
);

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

test("pausing an X account accepts its canonical handle without profile sync", async () => {
  const account: Account = {
    ...pixiv,
    platform: "x",
    handle: "artist",
    externalUserId: "42",
    fetchEnabled: true,
    firstSyncMode: "last_24_hours",
  };
  collectionFixture([account]);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(account));
  setup([account]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  fireEvent.change(screen.getByLabelText("X @账号"), {
    target: { value: "https://x.com/artist" },
  });
  fireEvent.click(screen.getByLabelText("启用自动抓取"));
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch.mock.calls[0]).toMatchObject([
    "/api/authors/{authorId}/accounts/{id}",
    { body: { handle: "artist", fetchEnabled: false } },
  ]);
});

test("pausing after a nickname-only synchronization omits an unrelated expired proof", async () => {
  const account: Account = {
    ...pixiv,
    platform: "x",
    handle: "artist",
    externalUserId: "42",
    fetchEnabled: true,
    firstSyncMode: "last_24_hours",
  };
  collectionFixture([account]);
  vi.spyOn(client, "POST").mockResolvedValue(
    success({
      ...resolvedPixiv,
      externalUserId: "42",
      handle: "artist",
      displayName: "同步昵称",
      avatarFileObjectId: null,
      avatarUrl: null,
      profileProof: "expired-proof",
      syncedAt: "2020-01-01T00:00:00Z",
    }),
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(account));
  setup([account]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("平台显示昵称（可选）") as HTMLInputElement).value,
    ).toBe("同步昵称"),
  );
  fireEvent.click(screen.getByLabelText("启用自动抓取"));
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0]).toMatchObject([
    "/api/authors/{authorId}/accounts/{id}",
    { body: { displayNameSnapshot: "同步昵称", fetchEnabled: false } },
  ]);
  expect(patch.mock.calls[0]?.[1]).not.toHaveProperty("body.profileProof");
});

test("editing a platform identity keeps its ID read-only and omits it from PATCH", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    success(
      String(path).endsWith("archived") || path === "/api/authors/sources"
        ? []
        : [pixiv],
    ),
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(pixiv));
  setup([pixiv]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  expect(
    (screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement).readOnly,
  ).toBe(true);
  expect(
    screen.queryByRole("checkbox", { name: /确认更换平台身份/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { expectedRevision: 2 },
  });
  expect(patch.mock.calls[0][1]).not.toHaveProperty("body.externalUserId");
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
    body: { expectedRevision: 2 },
  });
  expect(patch.mock.calls[0][1]).not.toHaveProperty("body.externalUserId");
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

test("editing X rejects a synchronized profile belonging to a different stable ID", async () => {
  const x: Account = {
    ...pixiv,
    platform: "x",
    handle: "artist",
    externalUserId: "777",
  };
  collectionFixture([x], []);
  vi.spyOn(client, "POST").mockResolvedValue(
    success({
      externalUserId: "888",
      handle: "another",
      displayName: "Another person",
      avatarFileObjectId: "another-avatar",
      avatarUrl: null,
      adapterKey: "fixture",
      syncedAt: "2026-11-05T00:00:00Z",
      profileUrl: "https://x.com/another",
    }),
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(x));
  setup([x]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  const id = screen.getByLabelText("X 稳定用户 ID") as HTMLInputElement;
  expect(id.readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await screen.findByText(/不同的 X 账号.*新账号/);
  expect(id.value).toBe("777");
  expect(
    (screen.getByLabelText("平台显示昵称（可选）") as HTMLInputElement).value,
  ).toBe("昵称");
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).not.toHaveProperty("body.externalUserId");
  expect(patch.mock.calls[0][1]).not.toHaveProperty("body.avatarFileObjectId");
});

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

test("configured Pixiv collection defaults to enabled and twenty-four hours", async () => {
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
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  expect(
    screen.getByRole("combobox", { name: "首次同步范围" }).textContent,
  ).toContain("最近 24 小时");
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

test.each(["x", "pixiv"] as const)(
  "paused %s metadata retains its saved window while capabilities fail",
  async (platform) => {
    const paused: Account = {
      ...pixiv,
      platform,
      handle: platform === "x" ? "artist" : null,
      firstSyncMode: "last_7_days",
    };
    collectionFixture([paused], new Error("能力读取失败"));
    const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(paused));
    setup([paused]);
    fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
    fireEvent.change(screen.getByLabelText("平台显示昵称（可选）"), {
      target: { value: "renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0][1]).toMatchObject({
      body: {
        displayNameSnapshot: "renamed",
        fetchEnabled: false,
        firstSyncMode: "last_7_days",
      },
    });
  },
);

test("saved paused accounts never re-default after late capabilities", async () => {
  collectionFixture([pixiv], []);
  setup([pixiv]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  await act(async () => {
    queryClient.setQueryData(["source-capabilities"], [pixivCapability]);
  });
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: "启用自动抓取",
      })) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(
    screen.getByRole("combobox", { name: "首次同步范围" }).textContent,
  ).toContain("仅后续内容");
});

test("new associations wait for late capabilities before saving their defaults", async () => {
  let release!: (value: never) => void;
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    path === "/api/authors/sources"
      ? new Promise<never>((resolve) => {
          release = resolve;
        })
      : success([]),
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
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  expect((await screen.findByRole("alert")).textContent).toContain("仍在读取");
  expect(post).not.toHaveBeenCalled();
  await act(async () => {
    release(success([pixivCapability]));
  });
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: "启用自动抓取",
      })) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { fetchEnabled: true, firstSyncMode: "last_24_hours" },
  });
});

test.each(["removed", "failed"] as const)(
  "an unsubmitted paused association can explicitly switch to information-only after capabilities are %s",
  async (state) => {
    let available = true;
    vi.spyOn(client, "GET").mockImplementation(async (path) => {
      if (path !== "/api/authors/sources") return success([]);
      if (!available && state === "failed") throw new Error("能力读取失败");
      return success(
        available
          ? [
              {
                ...pixivCapability,
                supportedFirstSyncModes: [
                  "none",
                  "last_24_hours",
                  "last_7_days",
                ],
              },
            ]
          : [],
      );
    });
    const post = vi.spyOn(client, "POST").mockResolvedValue(success(pixiv));
    setup();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "关联 Pixiv",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "关联 Pixiv" }));
    fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "启用自动抓取" }),
    );
    if (state === "removed") {
      fireEvent.click(screen.getByRole("combobox", { name: "首次同步范围" }));
      fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
    }
    available = false;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["source-capabilities"],
      });
    });
    const range = screen.getByRole("combobox", {
      name: "首次同步范围",
    }) as HTMLButtonElement;
    await waitFor(() => expect(range.textContent).toContain("当前不可用"));
    expect(range.textContent).toContain(
      state === "removed" ? "最近 7 天" : "最近 24 小时",
    );
    expect(range.disabled).toBe(false);
    fireEvent.click(range);
    fireEvent.click(screen.getByRole("option", { name: "仅后续内容" }));
    fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toMatchObject({
      body: { fetchEnabled: false, firstSyncMode: "none" },
    });
  },
);

test("saving an account locks its metadata and collection choices until the request finishes", async () => {
  collectionFixture([pixiv]);
  let release!: (value: never) => void;
  vi.spyOn(client, "PATCH").mockImplementation(
    () =>
      new Promise<never>((resolve) => {
        release = resolve;
      }),
  );
  setup([pixiv]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  expect(
    (screen.getByLabelText("平台显示昵称（可选）") as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText("账号备注（可选）") as HTMLTextAreaElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: "启用自动抓取" }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("combobox", {
        name: "首次同步范围",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => {
    release(success(pixiv));
  });
});

test.each([true, false])(
  "account controls hide technical adapter switches (available=%s)",
  async (available) => {
    const account: Account = {
      ...pixiv,
      adapterStates: [
        {
          adapterKey: "pixiv_fixture",
          enabled: false,
          available,
          health: "disabled",
          revision: 3,
          consecutiveFailures: 0,
          lastAttemptAt: null,
          lastSuccessAt: null,
          nextAttemptAt: null,
          lastErrorMessage: "private technical failure",
        },
      ],
    };
    collectionFixture([account]);
    const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(account));
    setup([account]);
    await screen.findByRole("button", { name: "编辑账号" });
    expect(
      screen.queryByRole("button", { name: /启用通道|停用通道/ }),
    ).toBeNull();
    expect(screen.queryByText("private technical failure")).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  },
);

test("Pixiv can pause collection and explicitly select seven days", async () => {
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
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("combobox", { name: "首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { firstSyncMode: "last_7_days", fetchEnabled: false },
  });
});

test("X profile refresh uses the bound account ID and carries signed proof when saving", async () => {
  const x: Account = {
    ...pixiv,
    id: "x-account",
    platform: "x",
    externalUserId: "777",
    handle: "old",
  };
  collectionFixture([x], []);
  const post = vi.spyOn(client, "POST").mockResolvedValue(
    success({
      externalUserId: "777",
      handle: "latest",
      displayName: "Artist",
      profileUrl: "https://x.com/latest",
      avatarFileObjectId: null,
      avatarUrl: null,
      adapterKey: "x_gallery_dl",
      syncedAt: "2026-11-05T00:00:00Z",
      profileProof: "synthetic-proof",
    }),
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(x));
  setup([x]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await waitFor(() =>
    expect((screen.getByLabelText("X @账号") as HTMLInputElement).value).toBe(
      "latest",
    ),
  );
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { accountId: "x-account" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { profileProof: "synthetic-proof" },
  });
});

test("new X identity cannot be entered as an unverified stable ID", async () => {
  collectionFixture([], []);
  setup([]);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "关联 X" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "关联 X" }));
  expect(
    (screen.getByLabelText("X 稳定用户 ID") as HTMLInputElement).readOnly,
  ).toBe(true);
});

test("management account notes render as text and save edited or cleared notes", async () => {
  const saved = { ...pixiv, notes: "<b>private account</b>" };
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    success(
      path === "/api/authors/sources" || String(path).endsWith("archived")
        ? []
        : [saved],
    ),
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(success(saved));
  setup([saved]);
  expect(
    (await screen.findByText("<b>private account</b>")).querySelector("b"),
  ).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "编辑账号" }));
  const notes = screen.getByLabelText(
    "账号备注（可选）",
  ) as HTMLTextAreaElement;
  expect(notes.value).toBe(saved.notes);
  fireEvent.change(notes, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存账号" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { notes: null, expectedRevision: 2 },
  });
});
