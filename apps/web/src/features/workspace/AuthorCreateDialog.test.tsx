import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client, queryClient } from "../account/api";
import type { components } from "@comiku/api-client";
import { AuthorsPage, AuthorDetailPage } from "./BusinessPages";

const ok = (data: unknown) => ({ data, response: new Response() }) as never;
const failed = (message: string) =>
  ({
    error: { message },
    response: new Response(null, { status: 409 }),
  }) as never;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
  sessionStorage.clear();
});

async function openCreate(
  waitForCapabilities = true,
  platform: "x" | "pixiv" = "pixiv",
) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route
            element={
              <Outlet
                context={{ permissions: ["authors:read", "authors:manage"] }}
              />
            }
          >
            <Route path="/" element={<AuthorsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "新增作者" }));
  fireEvent.change(screen.getByLabelText("作者昵称"), {
    target: { value: "合成作者" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "Pixiv" }));
  const pixivId = screen.queryByLabelText("Pixiv 用户 ID");
  if (pixivId)
    fireEvent.change(pixivId, {
      target: { value: "123456" },
    });
  if (platform === "x") fireEvent.click(screen.getByRole("tab", { name: "X" }));
  if (waitForCapabilities)
    await waitFor(() =>
      expect(queryClient.getQueryState(["source-capabilities"])?.status).toBe(
        "success",
      ),
    );
}

const configuredSources: components["schemas"]["SourceCapabilityDto"][] = [
  "x",
  "pixiv",
].map((platform) => ({
  platform,
  adapterKey: `${platform}_fixture`,
  priority: 10,
  metered: false,
  available: true,
  supportedFirstSyncModes: ["none", "last_24_hours", "last_7_days"],
}));

function createCollectionFixture(sources = configuredSources) {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/sources"
        ? sources
        : path === "/api/authors"
          ? { items: [], total: 0, nextCursor: null }
          : { author: null },
    ),
  );
  return vi.spyOn(client, "POST").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/x-profile/resolve"
        ? {
            externalUserId: "777",
            handle: "artist",
            displayName: "Artist",
            profileUrl: "https://x.com/artist",
            avatarFileObjectId: null,
            avatarUrl: null,
            adapterKey: "x_fixture",
            syncedAt: "2026-11-06T00:00:00Z",
            profileProof: "synthetic-proof",
          }
        : { id: "author", revision: 0, externalAccounts: [] },
    ),
  );
}

const pixivProfile: components["schemas"]["ResolvedPixivProfileDto"] = {
  externalUserId: "123456",
  handle: null,
  displayName: "Pixiv Artist",
  profileUrl: "https://www.pixiv.net/users/123456",
  avatarFileObjectId: "pixiv-avatar",
  avatarUrl: "https://storage.invalid/pixiv-avatar",
  adapterKey: "pixiv_fixture",
  syncedAt: new Date().toISOString(),
  profileProof: "pixiv-proof",
};

test("Pixiv explicit profile sync fills a blank author name and saves the verified account snapshot", async () => {
  const post = createCollectionFixture();
  post.mockImplementation(async (path) =>
    ok(
      path === "/api/authors/pixiv-profile/resolve"
        ? pixivProfile
        : { id: "author", externalAccounts: [] },
    ),
  );
  await openCreate(true, "pixiv");
  fireEvent.change(screen.getByLabelText("作者昵称"), {
    target: { value: "" },
  });
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  expect(
    await screen.findByRole("img", { name: "同步的作者头像" }),
  ).toBeTruthy();
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "Pixiv Artist",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0]).toEqual([
    "/api/authors/pixiv-profile/resolve",
    { body: { externalUserId: "123456" } },
  ]);
  expect(post.mock.calls[1][1]).toMatchObject({
    body: {
      displayName: "Pixiv Artist",
      profileSourcePlatform: "pixiv",
      accounts: [
        {
          platform: "pixiv",
          externalUserId: "123456",
          displayNameSnapshot: "Pixiv Artist",
          avatarFileObjectId: "pixiv-avatar",
          profileProof: "pixiv-proof",
        },
      ],
    },
  });
});

test("explicit Pixiv sync adopts the author name and avatar while preserving notes and collection choice", async () => {
  const post = createCollectionFixture();
  post.mockResolvedValue(ok(pixivProfile));
  await openCreate(true, "pixiv");
  fireEvent.change(screen.getByLabelText("作者备注（可选）"), {
    target: { value: "author note" },
  });
  fireEvent.change(screen.getByLabelText("Pixiv 账号备注（可选）"), {
    target: { value: "pixiv note" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Pixiv 启用自动抓取" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
  fireEvent.change(screen.getByLabelText("手动头像"), {
    target: {
      files: [new File(["avatar"], "manual-avatar.png", { type: "image/png" })],
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByText("Pixiv Artist");
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "Pixiv Artist",
  );
  expect(
    (screen.getByLabelText("作者备注（可选）") as HTMLTextAreaElement).value,
  ).toBe("author note");
  expect(
    (screen.getByLabelText("Pixiv 账号备注（可选）") as HTMLTextAreaElement)
      .value,
  ).toBe("pixiv note");
  expect(screen.queryByRole("img", { name: "manual-avatar.png" })).toBeNull();
  expect(screen.getByRole("img", { name: "同步的作者头像" })).toBeTruthy();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Pixiv 启用自动抓取",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(
    screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }).textContent,
  ).toContain("最近 7 天");
  expect(
    within(screen.getByRole("dialog")).getByText("Pixiv Artist"),
  ).toBeTruthy();
});

test("a Pixiv profile failure leaves manual creation editable and sends no implicit profile retry", async () => {
  const post = createCollectionFixture();
  post.mockImplementation(async (path) =>
    path === "/api/authors/pixiv-profile/resolve"
      ? failed("资料暂不可用")
      : ok({ id: "author", externalAccounts: [] }),
  );
  await openCreate(true, "pixiv");
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "资料暂不可用",
  );
  expect(
    (screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[1][1]).toMatchObject({
    body: { accounts: [{ externalUserId: "123456" }] },
  });
  expect(post.mock.calls[1][1]).not.toHaveProperty(
    "body.accounts.0.profileProof",
  );
  expect(post.mock.calls[1][1]).not.toHaveProperty(
    "body.profileSourcePlatform",
  );
});

test.each(["changed-input", "wrong-result"])(
  "Pixiv create rejects %s profile results",
  async (scenario) => {
    const post = createCollectionFixture();
    let release!: (value: never) => void;
    post.mockImplementation(async (path) =>
      path === "/api/authors/pixiv-profile/resolve"
        ? new Promise<never>((resolve) => {
            release = resolve;
          })
        : ok({ id: "author", externalAccounts: [] }),
    );
    await openCreate(true, "pixiv");
    fireEvent.click(
      screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
    );
    expect(
      (screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement).disabled,
    ).toBe(true);
    if (scenario === "changed-input")
      fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
        target: { value: "654321" },
      });
    await act(async () => {
      release(
        ok({
          ...pixivProfile,
          ...(scenario === "wrong-result" ? { externalUserId: "999999" } : {}),
        }),
      );
    });
    await screen.findByRole("alert");
    expect(screen.queryByText("Pixiv Artist")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).not.toHaveProperty(
      "body.accounts.0.profileProof",
    );
  },
);

test("editing a newly resolved Pixiv ID clears its preview and proof before manual save", async () => {
  const post = createCollectionFixture();
  post.mockImplementation(async (path) =>
    ok(
      path === "/api/authors/pixiv-profile/resolve"
        ? { ...pixivProfile, avatarUrl: null, avatarFileObjectId: null }
        : { id: "author", externalAccounts: [] },
    ),
  );
  await openCreate(true, "pixiv");
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByText("Pixiv Artist");
  expect(screen.queryByRole("img", { name: "同步的 Pixiv 头像" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
    target: { value: "654321" },
  });
  expect(screen.queryByText("Pixiv Artist")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[1][1]).toMatchObject({
    body: { accounts: [{ externalUserId: "654321" }] },
  });
  expect(post.mock.calls[1][1]).not.toHaveProperty(
    "body.accounts.0.profileProof",
  );
});

test("platform tabs preserve both drafts and only explicit sync adopts an author profile", async () => {
  const post = createCollectionFixture();
  const xSync = post.getMockImplementation()!;
  post.mockImplementation(async (...args) =>
    args[0] === "/api/authors/pixiv-profile/resolve"
      ? ok(pixivProfile)
      : xSync(...args),
  );
  await openCreate(true, "pixiv");
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByText("Pixiv Artist");
  fireEvent.click(screen.getByRole("tab", { name: "X" }));
  expect(
    screen.queryByRole("checkbox", { name: "Pixiv 启用自动抓取" }),
  ).toBeNull();
  expect(screen.queryByLabelText("Pixiv 账号备注（可选）")).toBeNull();
  fireEvent.change(screen.getByLabelText("X @账号"), {
    target: { value: "artist" },
  });
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "Pixiv Artist",
  );
  expect(
    screen.getByRole("img", { name: "同步的作者头像" }).getAttribute("src"),
  ).toBe("https://storage.invalid/pixiv-avatar");
  expect(post).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await screen.findByText("@artist");
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "Artist",
  );
  expect(
    screen.getByRole("img", { name: "同步的作者头像" }).getAttribute("src"),
  ).toBe("https://storage.invalid/pixiv-avatar");
  fireEvent.click(screen.getByRole("tab", { name: "Pixiv" }));
  expect(
    (screen.getByLabelText("Pixiv 用户 ID") as HTMLInputElement).value,
  ).toBe("123456");
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "Artist",
  );
  fireEvent.change(screen.getByLabelText("作者昵称"), {
    target: { value: "manual after sync" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  expect(post.mock.calls[2][1]).toMatchObject({
    body: {
      displayName: "manual after sync",
      profileSourcePlatform: "pixiv",
      accounts: [
        { platform: "x", profileProof: "synthetic-proof" },
        { platform: "pixiv", profileProof: "pixiv-proof" },
      ],
    },
  });
});

test("manual author creation needs no platform account or profile request", async () => {
  const post = createCollectionFixture();
  await openCreate(true, "pixiv");
  fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][0]).toBe("/api/authors");
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { displayName: "合成作者", accounts: [] },
  });
  expect(post.mock.calls[0][1]).not.toHaveProperty(
    "body.profileSourcePlatform",
  );
});

test.each(["x", "pixiv"] as const)(
  "the last successful %s avatar sync is saved independently of the active tab",
  async (lastPlatform) => {
    const post = createCollectionFixture();
    post.mockImplementation(async (path) =>
      ok(
        path === "/api/authors/x-profile/resolve"
          ? {
              externalUserId: "777",
              handle: "artist",
              displayName: "X Artist",
              profileUrl: "https://x.com/artist",
              avatarFileObjectId: "x-avatar",
              avatarUrl: "https://storage.invalid/x-avatar",
              adapterKey: "x_fixture",
              syncedAt: "2026-11-06T00:00:00Z",
              profileProof: "x-proof",
            }
          : path === "/api/authors/pixiv-profile/resolve"
            ? pixivProfile
            : { id: "author", externalAccounts: [] },
      ),
    );
    await openCreate(true, "x");
    fireEvent.change(screen.getByLabelText("X @账号"), {
      target: { value: "artist" },
    });
    const order = lastPlatform === "x" ? ["pixiv", "x"] : ["x", "pixiv"];
    for (const platform of order) {
      fireEvent.click(
        screen.getByRole("tab", { name: platform === "x" ? "X" : "Pixiv" }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: platform === "x" ? "同步昵称和头像" : "同步 Pixiv 昵称和头像",
        }),
      );
      await waitFor(() =>
        expect(
          (screen.getByLabelText("作者昵称") as HTMLInputElement).value,
        ).toBe(platform === "x" ? "X Artist" : "Pixiv Artist"),
      );
    }
    fireEvent.click(
      screen.getByRole("tab", { name: lastPlatform === "x" ? "Pixiv" : "X" }),
    );
    expect(
      screen.getByRole("img", { name: "同步的作者头像" }).getAttribute("src"),
    ).toBe(
      lastPlatform === "x"
        ? "https://storage.invalid/x-avatar"
        : "https://storage.invalid/pixiv-avatar",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][1]).toMatchObject({
      body: { profileSourcePlatform: lastPlatform },
    });
  },
);

test("manual name and avatar edits after sync override the selected author profile", async () => {
  const post = createCollectionFixture();
  post.mockResolvedValue(ok(pixivProfile));
  await openCreate(true, "pixiv");
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByText("Pixiv Artist");
  fireEvent.change(screen.getByLabelText("作者昵称"), {
    target: { value: "manual after sync" },
  });
  fireEvent.change(screen.getByLabelText("手动头像"), {
    target: {
      files: [new File(["avatar"], "after-sync.png", { type: "image/png" })],
    },
  });
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "manual after sync",
  );
  expect(screen.getByRole("img", { name: "after-sync.png" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "同步的作者头像" })).toBeNull();
});

test("a synced nickname without an avatar preserves the user's manual avatar choice", async () => {
  const post = createCollectionFixture();
  post.mockResolvedValue(
    ok({ ...pixivProfile, avatarUrl: null, avatarFileObjectId: null }),
  );
  await openCreate(true, "pixiv");
  fireEvent.change(screen.getByLabelText("手动头像"), {
    target: {
      files: [new File(["avatar"], "keep-manual.png", { type: "image/png" })],
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByText("Pixiv Artist");
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "Pixiv Artist",
  );
  expect(screen.getByRole("img", { name: "keep-manual.png" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("保留当前头像");
});

test("a later same-ID sync without an avatar retains the previously verified avatar and proof", async () => {
  const post = createCollectionFixture();
  let syncCount = 0;
  post.mockImplementation(async (path) =>
    ok(
      path === "/api/authors/pixiv-profile/resolve"
        ? ++syncCount === 1
          ? pixivProfile
          : {
              ...pixivProfile,
              displayName: "New nickname",
              avatarFileObjectId: null,
              avatarUrl: null,
              profileProof: "new-null-proof",
            }
        : { id: "author", externalAccounts: [] },
    ),
  );
  await openCreate(true, "pixiv");
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByRole("img", { name: "同步的作者头像" });
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
      "New nickname",
    ),
  );
  expect(
    screen.getByRole("img", { name: "同步的作者头像" }).getAttribute("src"),
  ).toBe("https://storage.invalid/pixiv-avatar");
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  expect(post.mock.calls[2][1]).toMatchObject({
    body: {
      displayName: "New nickname",
      profileSourcePlatform: "pixiv",
      accounts: [
        {
          displayNameSnapshot: "New nickname",
          avatarFileObjectId: "pixiv-avatar",
          profileProof: "pixiv-proof",
        },
      ],
    },
  });
});

test("a fresh null-avatar sync replaces expired previous evidence and clears its author avatar choice", async () => {
  const post = createCollectionFixture();
  let syncCount = 0;
  post.mockImplementation(async (path) =>
    ok(
      path === "/api/authors/pixiv-profile/resolve"
        ? ++syncCount === 1
          ? {
              ...pixivProfile,
              syncedAt: new Date(Date.now() - 600_001).toISOString(),
            }
          : {
              ...pixivProfile,
              displayName: "Fresh nickname",
              avatarFileObjectId: null,
              avatarUrl: null,
              profileProof: "fresh-proof",
            }
        : { id: "author", externalAccounts: [] },
    ),
  );
  await openCreate(true, "pixiv");
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await screen.findByRole("img", { name: "同步的作者头像" });
  fireEvent.click(
    screen.getByRole("button", { name: "同步 Pixiv 昵称和头像" }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
      "Fresh nickname",
    ),
  );
  expect(screen.queryByRole("img", { name: "同步的作者头像" })).toBeNull();
  expect(screen.getByRole("status").textContent).not.toContain("保留当前头像");
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  expect(post.mock.calls[2][1]).not.toHaveProperty(
    "body.profileSourcePlatform",
  );
  expect(post.mock.calls[2][1]).toMatchObject({
    body: {
      accounts: [{ avatarFileObjectId: null, profileProof: "fresh-proof" }],
    },
  });
});

test("an X rename with no avatar saves the new handle and proof instead of retaining old-handle evidence", async () => {
  const post = createCollectionFixture();
  let syncCount = 0;
  post.mockImplementation(async (path) =>
    ok(
      path === "/api/authors/x-profile/resolve"
        ? {
            externalUserId: "777",
            handle: ++syncCount === 1 ? "artist" : "renamed",
            displayName: syncCount === 1 ? "Old name" : "New name",
            profileUrl:
              syncCount === 1
                ? "https://x.com/artist"
                : "https://x.com/renamed",
            avatarFileObjectId: syncCount === 1 ? "x-avatar" : null,
            avatarUrl:
              syncCount === 1 ? "https://storage.invalid/x-avatar" : null,
            adapterKey: "x_fixture",
            syncedAt: new Date().toISOString(),
            profileProof:
              syncCount === 1 ? "old-handle-proof" : "new-handle-proof",
          }
        : { id: "author", externalAccounts: [] },
    ),
  );
  await openCreate(true, "x");
  fireEvent.change(screen.getByLabelText("X @账号"), {
    target: { value: "artist" },
  });
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await screen.findByRole("img", { name: "同步的作者头像" });
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await waitFor(() =>
    expect((screen.getByLabelText("X @账号") as HTMLInputElement).value).toBe(
      "renamed",
    ),
  );
  expect(screen.queryByRole("img", { name: "同步的作者头像" })).toBeNull();
  expect(screen.getByRole("status").textContent).not.toContain("保留当前头像");
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  expect(post.mock.calls[2][1]).toMatchObject({
    body: {
      accounts: [
        {
          platform: "x",
          handle: "renamed",
          displayNameSnapshot: "New name",
          avatarFileObjectId: null,
          profileProof: "new-handle-proof",
        },
        { platform: "pixiv" },
      ],
    },
  });
  expect(post.mock.calls[2][1]).not.toHaveProperty(
    "body.profileSourcePlatform",
  );
});

test("new X and Pixiv accounts share enabled twenty-four-hour defaults and retain proof and notes", async () => {
  const post = createCollectionFixture();
  await openCreate(true, "x");
  fireEvent.change(screen.getByLabelText("X @账号"), {
    target: { value: "artist" },
  });
  fireEvent.click(screen.getByRole("button", { name: "同步昵称和头像" }));
  await screen.findByText("@artist");
  expect(
    (
      screen.getByRole("checkbox", {
        name: "X 启用自动抓取",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("X 账号备注（可选）"), {
    target: { value: "X note" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "Pixiv" }));
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Pixiv 启用自动抓取",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(screen.queryByRole("checkbox", { name: "X 启用自动抓取" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[1][1]).toMatchObject({
    body: {
      accounts: [
        {
          platform: "x",
          fetchEnabled: true,
          firstSyncMode: "last_24_hours",
          profileProof: "synthetic-proof",
          notes: "X note",
        },
        {
          platform: "pixiv",
          fetchEnabled: true,
          firstSyncMode: "last_24_hours",
        },
      ],
    },
  });
});

test("new Pixiv can turn collection off and choose seven days", async () => {
  const post = createCollectionFixture();
  await openCreate();
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Pixiv 启用自动抓取" }),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: {
      accounts: [
        {
          platform: "pixiv",
          fetchEnabled: false,
          firstSyncMode: "last_7_days",
        },
      ],
    },
  });
});

test("capability refresh does not override a deliberate new-account choice", async () => {
  const post = createCollectionFixture();
  await openCreate();
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Pixiv 启用自动抓取" }),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "仅后续内容" }));
  await act(async () => {
    queryClient.setQueryData(
      ["source-capabilities"],
      configuredSources.map((source) => ({ ...source, priority: 20 })),
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { accounts: [{ fetchEnabled: false, firstSyncMode: "none" }] },
  });
});

test("late capabilities cannot replace a previously submitted information-only intent on retry", async () => {
  const post = createCollectionFixture([]);
  post.mockRejectedValueOnce(new TypeError("response lost"));
  await openCreate();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await screen.findByRole("alert");
  await act(async () => {
    queryClient.setQueryData(["source-capabilities"], configuredSources);
  });
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: "Pixiv 启用自动抓取",
      })) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);
  expect(post.mock.calls[1][1]).toMatchObject({
    body: { accounts: [{ fetchEnabled: false, firstSyncMode: "none" }] },
  });
});

test("untouched new accounts adopt late capabilities and cannot save before they arrive", async () => {
  const post = createCollectionFixture();
  let release!: (value: never) => void;
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    path === "/api/authors/sources"
      ? new Promise<never>((resolve) => {
          release = resolve;
        })
      : ok({ items: [], total: 0, nextCursor: null }),
  );
  await openCreate(false);
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  expect((await screen.findByRole("alert")).textContent).toContain("仍在读取");
  expect(post).not.toHaveBeenCalled();
  await act(async () => {
    release(ok(configuredSources));
  });
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: "Pixiv 启用自动抓取",
      })) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: {
      accounts: [{ fetchEnabled: true, firstSyncMode: "last_24_hours" }],
    },
  });
});

test.each([
  ["last_7_days", true, true],
  ["none", true, true],
  ["last_24_hours", false, false],
] as const)(
  "new accounts use supported %s fallback with availability %s",
  async (mode, available, enabled) => {
    const post = createCollectionFixture([
      { ...configuredSources[1], available, supportedFirstSyncModes: [mode] },
    ]);
    await openCreate();
    fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toMatchObject({
      body: {
        accounts: [
          { fetchEnabled: enabled, firstSyncMode: enabled ? mode : "none" },
        ],
      },
    });
  },
);

test("a failed capabilities read allows only information binding", async () => {
  const post = createCollectionFixture();
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/authors/sources")
      throw new Error("capabilities unavailable");
    return ok({ items: [], total: 0, nextCursor: null });
  });
  await openCreate(false);
  await waitFor(() =>
    expect(queryClient.getQueryState(["source-capabilities"])?.status).toBe(
      "error",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { accounts: [{ fetchEnabled: false, firstSyncMode: "none" }] },
  });
});

test("an explicit activation cannot save when its supported window disappears", async () => {
  const post = createCollectionFixture();
  await openCreate();
  fireEvent.click(screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
  await act(async () => {
    queryClient.setQueryData(["source-capabilities"], []);
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("combobox", {
          name: "Pixiv 首次同步范围",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "没有支持所选首次同步范围",
  );
  expect(post).not.toHaveBeenCalled();
});

test.each(["removed", "failed"] as const)(
  "an unsubmitted paused draft can explicitly switch to information-only after capabilities are %s",
  async (state) => {
    const post = createCollectionFixture();
    let available = true;
    vi.spyOn(client, "GET").mockImplementation(async (path) => {
      if (path !== "/api/authors/sources")
        return ok({ items: [], total: 0, nextCursor: null });
      if (!available && state === "failed") throw new Error("能力读取失败");
      return ok(available ? configuredSources : []);
    });
    await openCreate();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Pixiv 启用自动抓取" }),
    );
    if (state === "failed") {
      fireEvent.click(
        screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }),
      );
      fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
    }
    available = false;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["source-capabilities"],
      });
    });
    const range = screen.getByRole("combobox", {
      name: "Pixiv 首次同步范围",
    }) as HTMLButtonElement;
    await waitFor(() => expect(range.textContent).toContain("当前不可用"));
    expect(range.textContent).toContain(
      state === "failed" ? "最近 7 天" : "最近 24 小时",
    );
    expect(range.disabled).toBe(false);
    fireEvent.click(range);
    fireEvent.click(screen.getByRole("option", { name: "仅后续内容" }));
    fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toMatchObject({
      body: { accounts: [{ fetchEnabled: false, firstSyncMode: "none" }] },
    });
  },
);

test("a submitted paused window is not silently changed when capabilities disappear", async () => {
  const post = createCollectionFixture();
  post.mockRejectedValueOnce(new TypeError("response lost"));
  await openCreate();
  fireEvent.click(screen.getByRole("checkbox", { name: "Pixiv 启用自动抓取" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }));
  fireEvent.click(screen.getByRole("option", { name: "最近 7 天" }));
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await screen.findByRole("alert");
  await act(async () => {
    queryClient.setQueryData(["source-capabilities"], []);
  });
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }).textContent,
    ).toContain("当前不可用"),
  );
  expect(
    screen.getByRole("combobox", { name: "Pixiv 首次同步范围" }).textContent,
  ).toContain("最近 7 天");
  expect(screen.getByRole("button", { name: "检查保存结果" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "没有支持所选首次同步范围",
    ),
  );
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { accounts: [{ fetchEnabled: false, firstSyncMode: "last_7_days" }] },
  });
});

test("base information and platform accounts use one atomic author request, and a rejected save keeps fields editable", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/sources"
        ? []
        : path === "/api/authors"
          ? { items: [], total: 0, nextCursor: null }
          : null,
    ),
  );
  let attempts = 0;
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    if (++attempts === 1) return failed("账号已关联其他作者");
    return ok({ id: "author", revision: 0, externalAccounts: [] });
  });
  await openCreate();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "账号已关联",
  );
  expect(screen.getByLabelText("作者昵称").hasAttribute("disabled")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await screen.findByText(/作者已创建/);
  expect(post).toHaveBeenCalledTimes(2);
  const requests = post.mock.calls as unknown as [
    string,
    { body: Record<string, unknown> },
  ][];
  expect(requests.map(([path]) => path)).toEqual([
    "/api/authors",
    "/api/authors",
  ]);
  expect(requests[0][1].body.accounts).toEqual([
    {
      platform: "pixiv",
      externalUserId: "123456",
      fetchEnabled: false,
      firstSyncMode: "none",
    },
  ]);
  expect(requests[0][1].body.idempotencyKey).toBe(
    requests[1][1].body.idempotencyKey,
  );
});

test("a lost initial response recovers the committed author by request ID without a second POST", async () => {
  let saved = false;
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/sources"
        ? []
        : path === "/api/authors"
          ? { items: [], total: 0, nextCursor: null }
          : {
              author: saved
                ? { id: "author", revision: 0, externalAccounts: [] }
                : null,
            },
    ),
  );
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    saved = true;
    throw new TypeError("响应丢失");
  });
  await openCreate();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await screen.findByText(/作者已创建/);
  expect(post).toHaveBeenCalledTimes(1);
  expect(
    (get.mock.calls as unknown as [string, unknown][]).some(
      ([path]) => path === "/api/authors/creation-requests/{idempotencyKey}",
    ),
  ).toBe(true);
});

test("reopening restores only the same actor request result without persisting draft text or credentials", async () => {
  const key = "f72f6416-81a0-4508-988b-4c76712c38dc";
  sessionStorage.setItem("comiku:author-creation:undefined", key);
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/sources"
        ? []
        : path === "/api/authors"
          ? { items: [], total: 0, nextCursor: null }
          : {
              author: {
                id: "author",
                revision: 0,
                displayName: "已保存作者",
                sourceLanguage: "ja",
                authorizationStatus: "pending",
                externalAccounts: [],
              },
            },
    ),
  );
  const post = vi.spyOn(client, "POST");
  await openCreate();
  expect(
    (await screen.findByRole("link", { name: "打开作者详情" })).getAttribute(
      "href",
    ),
  ).toBe("/authors/author");
  expect(screen.getByLabelText("作者昵称").hasAttribute("disabled")).toBe(true);
  expect(post).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("comiku:author-creation:undefined")).toBe(key);
  expect(
    (get.mock.calls as unknown as [string, unknown][]).some(
      ([path, options]) =>
        path === "/api/authors/creation-requests/{idempotencyKey}" &&
        (options as { params: { path: { idempotencyKey: string } } }).params
          .path.idempotencyKey === key,
    ),
  ).toBe(true);
});

test("completed avatar and account steps survive a lost evidence-finalize response without duplicating attachments", async () => {
  vi.stubGlobal("crypto", {
    randomUUID: () => "74d00bc2-61ad-4d0c-873f-e7a6ae9706aa",
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  const fetch = vi.fn(async () => new Response());
  vi.stubGlobal("fetch", fetch);
  const session = (id: string, status: string) => ({
    id,
    status,
    error: null,
    expiresAt:
      id === "evidence"
        ? new Date(Date.now() + 1_000).toISOString()
        : "2099-01-01T00:00:00Z",
    files: [
      {
        sourceName: `${id}.png`,
        upload:
          status === "pending"
            ? { url: `https://storage.invalid/${id}`, headers: {} }
            : null,
      },
    ],
  });
  let revision = 1;
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async (path) =>
      ok(
        path === "/api/authors/sources"
          ? []
          : path === "/api/authors"
            ? { items: [], total: 0, nextCursor: null }
            : path === "/api/transfers/uploads/{id}"
              ? session("evidence", "completed")
              : { id: "author", revision },
      ),
    );
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path, options) => {
      if (path === "/api/authors") return ok({ id: "author", revision });
      if (path === "/api/authors/{authorId}/accounts")
        return ok({ id: "account" });
      if (path === "/api/transfers/uploads")
        return ok(
          session(
            (options as { body: { purpose: string } }).body.purpose ===
              "author_avatar"
              ? "avatar"
              : "evidence",
            "pending",
          ),
        );
      revision++;
      if (
        (options as { params: { path: { id: string } } }).params.path.id ===
        "evidence"
      )
        throw new Error("网络中断");
      return ok(session("avatar", "completed"));
    });
  await openCreate();
  for (const label of ["手动头像", "授权凭证（可多张）"]) {
    const file = new File(["image"], "test.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(5),
    });
    fireEvent.change(screen.getByLabelText(label), {
      target: { files: [file] },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "作者已保存",
  );
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
  await act(async () => {
    queryClient.setQueryData(["authors", ""], {
      pages: [{ items: [], total: 0, nextCursor: null }],
      pageParams: [null],
    });
  });
  expect(
    screen.getByLabelText("授权凭证（可多张）").hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /继续保存/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/authors",
    ),
  ).toHaveLength(1);
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/authors/{authorId}/accounts",
    ),
  ).toHaveLength(0);
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/transfers/uploads",
    ),
  ).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    (get.mock.calls as unknown as [string, unknown][]).some(
      ([path]) => path === "/api/transfers/uploads/{id}",
    ),
  ).toBe(true);
});

test("editing retries a failed avatar at the saved revision and then accepts a new upload intent", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.stubGlobal("crypto", {
    randomUUID: () => "74d00bc2-61ad-4d0c-873f-e7a6ae9706aa",
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  let revision = 1;
  let completed = false;
  let readFailed = false;
  const author = () => ({
    id: "author",
    revision,
    displayName: "合成作者",
    notes: "original note",
    authorizationStatus: "pending",
    sourceLanguage: "ja",
    tags: [],
    externalAccounts: [],
    avatarAvailable: false,
  });
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (
      (path === "/api/authors/{id}" || path === "/api/authors/{id}/managed") &&
      completed &&
      !readFailed
    ) {
      readFailed = true;
      throw new Error("回读中断");
    }
    return ok(
      path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
        ? author()
        : path === "/api/transfers/uploads/{id}"
          ? {
              id: "avatar",
              status: "pending",
              files: [
                {
                  upload: {
                    url: "https://storage.invalid/avatar",
                    headers: {},
                  },
                },
              ],
            }
          : [],
    );
  });
  const patch = vi.spyOn(client, "PATCH").mockImplementation(async () => {
    revision = 2;
    return ok(author());
  });
  const post = vi.spyOn(client, "POST").mockImplementation(async (path) => {
    if (path === "/api/transfers/uploads/{id}/finalize") completed = true;
    return ok(
      path === "/api/transfers/uploads"
        ? {
            id: "avatar",
            status: "pending",
            files: [
              {
                upload: {
                  url: "https://storage.invalid/avatar",
                  headers: {},
                },
              },
            ],
          }
        : { id: "avatar", status: "completed", files: [], error: null },
    );
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValue(new Response());
  vi.stubGlobal("fetch", fetch);
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
  const picker = await screen.findByLabelText("手动头像（可选）");
  fireEvent.change(screen.getByLabelText("作者备注（可选）"), {
    target: { value: "saved note" },
  });
  const file = new File(["avatar"], "avatar.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(6),
  });
  fireEvent.change(picker, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "信息已保存",
  );
  await act(async () => {
    queryClient.setQueryData(["managed-author", "author"], author());
  });
  expect(screen.getByLabelText("作者昵称").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("img", { name: "avatar.png" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /继续.*头像/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(patch).toHaveBeenCalledTimes(1);
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { notes: "saved note", expectedRevision: 1 },
  });
  expect(
    (screen.getByLabelText("作者备注（可选）") as HTMLTextAreaElement).value,
  ).toBe("saved note");
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/transfers/uploads",
    ),
  ).toHaveLength(1);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "读取保存结果未完成",
  );
  fireEvent.click(screen.getByRole("button", { name: "确认保存结果" }));
  await screen.findByRole("button", { name: "保存作者" });
  const second = new File(["second"], "second.png", { type: "image/png" });
  Object.defineProperty(second, "arrayBuffer", {
    value: async () => new ArrayBuffer(6),
  });
  fireEvent.change(screen.getByLabelText("手动头像（可选）"), {
    target: { files: [second] },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(patch).toHaveBeenCalledTimes(2);
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/transfers/uploads",
    ),
  ).toHaveLength(2);
});

test("an in-flight creation cannot be closed with the close button or Escape", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/sources"
        ? []
        : { items: [], total: 0, nextCursor: null },
    ),
  );
  let release!: (value: never) => void;
  vi.spyOn(client, "POST").mockImplementation(
    () =>
      new Promise<never>((resolve) => {
        release = resolve;
      }),
  );
  await openCreate();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  const dialog = screen.getByRole("dialog");
  expect(
    screen.getByRole("button", { name: "关闭" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent(dialog, new Event("cancel", { cancelable: true, bubbles: true }));
  expect(screen.getByRole("dialog")).toBe(dialog);
  release(failed("创建失败"));
  await screen.findByRole("alert");
});

test.each([false, true])(
  "a refreshed author revision updates a clean form and preserves a dirty baseline (dirty=%s)",
  async (dirty) => {
    const original = {
      id: "author",
      revision: 1,
      displayName: "原作者",
      notes: "original note",
      authorizationStatus: "pending",
      sourceLanguage: "ja",
      tags: [],
      externalAccounts: [],
      avatarAvailable: false,
    };
    const latest = {
      ...original,
      revision: 3,
      displayName: "其他操作保存的昵称",
      notes: "newer note",
    };
    let current = original;
    vi.spyOn(client, "GET").mockImplementation(async (path) =>
      ok(
        path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
          ? current
          : [],
      ),
    );
    const patch = vi
      .spyOn(client, "PATCH")
      .mockImplementation(async (_path, options) =>
        (options as { body: { expectedRevision: number } }).body
          .expectedRevision === 3
          ? ok(latest)
          : failed("作者版本已变化"),
      );
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/authors/author"]}>
          <Routes>
            <Route
              element={
                <Outlet
                  context={{ permissions: ["authors:read", "authors:manage"] }}
                />
              }
            >
              <Route path="/authors/:id" element={<AuthorDetailPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const name = (await screen.findByLabelText("作者昵称")) as HTMLInputElement;
    if (dirty) fireEvent.change(name, { target: { value: "未保存的昵称" } });
    current = latest;
    await act(async () => {
      queryClient.setQueryData(["managed-author", "author"], latest);
    });
    if (dirty) {
      expect(name.value).toBe("未保存的昵称");
      fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
      await screen.findByRole("alert");
      const firstBody = (
        patch.mock.calls as unknown as [
          string,
          { body: { expectedRevision: number } },
        ][]
      )[0][1].body;
      expect(firstBody.expectedRevision).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "加载最新资料" }));
    }
    await waitFor(() => expect(name.value).toBe("其他操作保存的昵称"));
    expect(
      (screen.getByLabelText("作者备注（可选）") as HTMLTextAreaElement).value,
    ).toBe("newer note");
    fireEvent.change(name, { target: { value: "继续编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(dirty ? 2 : 1));
    const calls = patch.mock.calls as unknown as [
      string,
      { body: { expectedRevision: number } },
    ][];
    expect(calls.at(-1)![1].body.expectedRevision).toBe(3);
  },
);

test("author creation includes optional author and account notes in the atomic request", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/sources"
        ? []
        : path === "/api/authors"
          ? { items: [], total: 0, nextCursor: null }
          : null,
    ),
  );
  const post = vi
    .spyOn(client, "POST")
    .mockResolvedValue(ok({ id: "author", revision: 0, externalAccounts: [] }));
  await openCreate();
  fireEvent.change(screen.getByLabelText("作者备注（可选）"), {
    target: { value: "author internal" },
  });
  fireEvent.change(screen.getByLabelText("Pixiv 账号备注（可选）"), {
    target: { value: "account internal" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: {
      notes: "author internal",
      accounts: [{ notes: "account internal" }],
    },
  });
});

test("public detail never requests or renders management notes", async () => {
  const author = {
    id: "author",
    revision: 1,
    displayName: "Public artist",
    authorizationStatus: "pending",
    sourceLanguage: "ja",
    tags: [],
    externalAccounts: [],
    avatarAvailable: false,
  };
  const get = vi.spyOn(client, "GET").mockResolvedValue(ok(author));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/authors/author"]}>
        <Routes>
          <Route
            element={<Outlet context={{ permissions: ["authors:read"] }} />}
          >
            <Route path="/authors/:id" element={<AuthorDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText("Public artist");
  expect(
    (get.mock.calls as unknown as [string, unknown][]).some(([path]) =>
      String(path).includes("managed"),
    ),
  ).toBe(false);
  expect(screen.queryByLabelText("作者备注（可选）")).toBeNull();
});

test("dirty author notes survive background refresh until explicit latest load", async () => {
  const original = {
    id: "author",
    revision: 1,
    displayName: "Artist",
    authorizationStatus: "pending",
    sourceLanguage: "ja",
    tags: [],
    externalAccounts: [],
    avatarAvailable: false,
    notes: "saved notes",
  };
  let current = original;
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
        ? current
        : [],
    ),
  );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(failed("作者版本已变化"));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/authors/author"]}>
        <Routes>
          <Route
            element={
              <Outlet
                context={{ permissions: ["authors:read", "authors:manage"] }}
              />
            }
          >
            <Route path="/authors/:id" element={<AuthorDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const notes = (await screen.findByLabelText(
    "作者备注（可选）",
  )) as HTMLTextAreaElement;
  expect(notes.value).toBe("saved notes");
  fireEvent.change(notes, { target: { value: "dirty notes" } });
  current = { ...original, revision: 2, notes: "other manager notes" };
  await act(async () => {
    queryClient.setQueryData(["managed-author", "author"], current);
  });
  expect(notes.value).toBe("dirty notes");
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { notes: "dirty notes", expectedRevision: 1 },
  });
  fireEvent.click(await screen.findByRole("button", { name: "加载最新资料" }));
  await waitFor(() => expect(notes.value).toBe("other manager notes"));
});

test("a transient managed refetch error preserves dirty fields and the selected avatar", async () => {
  const original = {
    id: "author",
    revision: 1,
    displayName: "Artist",
    authorizationStatus: "pending",
    sourceLanguage: "ja",
    tags: [],
    externalAccounts: [],
    avatarAvailable: false,
    notes: "saved notes",
  };
  let failManaged = false;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/authors/{id}/managed" && failManaged)
      throw new Error("temporary managed read failure");
    return ok(
      path === "/api/authors/{id}" || path === "/api/authors/{id}/managed"
        ? original
        : [],
    );
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/authors/author"]}>
        <Routes>
          <Route
            element={
              <Outlet
                context={{ permissions: ["authors:read", "authors:manage"] }}
              />
            }
          >
            <Route path="/authors/:id" element={<AuthorDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const notes = (await screen.findByLabelText(
    "作者备注（可选）",
  )) as HTMLTextAreaElement;
  fireEvent.change(notes, { target: { value: "dirty notes" } });
  fireEvent.change(screen.getByLabelText("作者昵称"), {
    target: { value: "dirty name" },
  });
  fireEvent.change(screen.getByLabelText("手动头像（可选）"), {
    target: {
      files: [
        new File(["avatar"], "pending-avatar.png", { type: "image/png" }),
      ],
    },
  });
  failManaged = true;
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["managed-author", "author"],
    });
  });
  expect(screen.getByLabelText("作者备注（可选）")).toBe(notes);
  expect(notes.value).toBe("dirty notes");
  expect((screen.getByLabelText("作者昵称") as HTMLInputElement).value).toBe(
    "dirty name",
  );
  expect(screen.getByRole("img", { name: "pending-avatar.png" })).toBeTruthy();
  expect(await screen.findByText(/管理资料更新失败/)).toBeTruthy();
  failManaged = false;
  fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
  await waitFor(() =>
    expect(screen.queryByText(/管理资料更新失败/)).toBeNull(),
  );
  expect(screen.getByLabelText("作者备注（可选）")).toBe(notes);
  expect(notes.value).toBe("dirty notes");
  expect(screen.getByRole("img", { name: "pending-avatar.png" })).toBeTruthy();
});
