import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client, queryClient } from "../account/api";
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
});

async function openCreate() {
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
  fireEvent.change(screen.getByLabelText("Pixiv 用户 ID"), {
    target: { value: "123456" },
  });
}

test("a failed account binding resumes the existing author and locks its saved fields", async () => {
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    ok(
      path === "/api/authors"
        ? { items: [], total: 0, nextCursor: null }
        : { id: "author", revision: 1 },
    ),
  );
  let attempts = 0;
  const post = vi.spyOn(client, "POST").mockImplementation(async (path) => {
    if (path === "/api/authors") return ok({ id: "author", revision: 1 });
    if (++attempts === 1) return failed("账号绑定失败");
    return ok({ id: "account" });
  });
  await openCreate();
  fireEvent.click(screen.getByRole("button", { name: "保存作者" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "作者已保存",
  );
  expect(screen.getByLabelText("作者昵称").hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "稍后补传" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /继续保存/ }));
  await screen.findByText("作者已创建");
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/authors",
    ),
  ).toHaveLength(1);
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/authors/{authorId}/accounts",
    ),
  ).toHaveLength(2);
});

test("completed avatar and account steps survive a lost evidence-finalize response without duplicating attachments", async () => {
  vi.stubGlobal("crypto", {
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
        path === "/api/authors"
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
  ).toHaveLength(1);
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
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  let revision = 1;
  let completed = false;
  let readFailed = false;
  const author = () => ({
    id: "author",
    revision,
    displayName: "合成作者",
    authorizationStatus: "pending",
    sourceLanguage: "ja",
    tags: [],
    externalAccounts: [],
    avatarAvailable: false,
  });
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/authors/{id}" && completed && !readFailed) {
      readFailed = true;
      throw new Error("回读中断");
    }
    return ok(
      path === "/api/authors/{id}"
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
    queryClient.setQueryData(["author", "author"], author());
  });
  expect(screen.getByLabelText("作者昵称").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("img", { name: "avatar.png" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /继续.*头像/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(patch).toHaveBeenCalledTimes(1);
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
  vi.spyOn(client, "GET").mockResolvedValue(
    ok({ items: [], total: 0, nextCursor: null }),
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
    };
    let current = original;
    vi.spyOn(client, "GET").mockImplementation(async (path) =>
      ok(path === "/api/authors/{id}" ? current : []),
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
      queryClient.setQueryData(["author", "author"], latest);
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
