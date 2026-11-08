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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AuthorDirectory } from "./AuthorDirectory";
import { client } from "../account/api";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("changing a filter aborts its old request and a late response cannot replace the current results", async () => {
  let resolveOld!: (value: ReturnType<typeof response>) => void;
  let oldSignal: AbortSignal | undefined;
  const pending = new Promise<ReturnType<typeof response>>((resolve) => {
    resolveOld = resolve;
  });
  vi.spyOn(client, "GET").mockImplementation(async (_path, options) => {
    const current = options as {
      params: { query: { xState?: string } };
      signal: AbortSignal;
    };
    if (current.params.query.xState === "enabled")
      return response({
        items: [{ ...author, displayName: "当前筛选作者" }],
        total: 1,
        nextCursor: null,
      }) as never;
    oldSignal = current.signal;
    return pending as never;
  });
  setup();
  await waitFor(() => expect(oldSignal).toBeDefined());
  await choose("X 采集状态", "已开启");
  await screen.findByText("当前筛选作者");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    resolveOld(response({ items: [author], total: 1, nextCursor: null }));
  });
  expect(screen.queryByText(author.displayName)).toBeNull();
  expect(screen.getByText("当前筛选作者")).toBeTruthy();
});
const account = (platform: string, fetchEnabled: boolean) => ({
  id: platform,
  platform,
  externalUserId: platform === "x" ? "900001" : "100001",
  handle: platform === "x" ? "demo_shiro" : null,
  profileUrl: null,
  displayNameSnapshot: null,
  avatarAvailable: false,
  fetchEnabled,
});
const author = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "长名字作者｜保留完整授权状态与平台账号信息",
  sourceLanguage: "ja",
  authorizationStatus: "authorized",
  externalAccounts: [account("x", true), account("pixiv", false)],
  tags: [{ id: "tag", name: "漫画", revision: 1 }],
  avatarAvailable: false,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};
const response = (data: unknown) => ({
  data,
  response: new Response(null, { status: 200 }),
});
function setup() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(c);
  render(
    <QueryClientProvider client={c}>
      <MemoryRouter>
        <AuthorDirectory />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function choose(name: string, text: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(screen.getByRole("option", { name: text }));
}

test("author directory sends combined server filters, resets cursor, and preserves filters across views", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async (_path, options) => {
      const q = (
        options as { params?: { query?: { cursor?: string; xState?: string } } }
      )?.params?.query;
      return response({
        items: [
          {
            ...author,
            id: q?.cursor ? "00000000-0000-4000-8000-000000000002" : author.id,
            displayName: q?.cursor ? "第二页作者" : author.displayName,
          },
        ],
        total: 2,
        nextCursor: q?.cursor || q?.xState ? null : "cursor-one",
      }) as never;
    });
  setup();
  await screen.findByText(author.displayName);
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByText("第二页作者");
  await choose("X 采集状态", "已开启");
  await choose("Pixiv 采集状态", "已关闭");
  await choose("授权状态", "已授权");
  await waitFor(() =>
    expect(get.mock.calls.at(-1)?.[1]).toMatchObject({
      params: {
        query: {
          xState: "enabled",
          pixivState: "disabled",
          authorizationStatus: "authorized",
        },
      },
    }),
  );
  expect(
    (
      get.mock.calls.at(-1)?.[1] as unknown as {
        params: { query: { cursor?: string } };
      }
    ).params.query.cursor,
  ).toBeUndefined();
  expect(screen.queryByText("第二页作者")).toBeNull();
  const calls = get.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "列表" }));
  expect(screen.getByRole("table")).toBeTruthy();
  expect(
    screen.getByRole("combobox", { name: "X 采集状态" }).textContent,
  ).toContain("已开启");
  expect(get.mock.calls.length).toBe(calls);
  expect(screen.getByText("已显示 1 / 2 位作者")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "X 采集状态" }).textContent,
    ).toContain("全部"),
  );
  expect(screen.getByRole("table")).toBeTruthy();
});

test("both author views show all authorization, language, numeric Pixiv ID, and link collection settings", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    response({ items: [author], total: 1, nextCursor: null }) as never,
  );
  setup();
  await screen.findByText(author.displayName);
  expect(screen.getByTitle(author.displayName)).toBeTruthy();
  const card = screen.getByRole("article");
  expect(within(card).getByText("已授权")).toBeTruthy();
  expect(within(card).getByText("日语")).toBeTruthy();
  expect(within(card).getByText("100001")).toBeTruthy();
  expect(within(card).queryByText("Pixiv")).toBeNull();
  expect(
    screen
      .getByRole("link", { name: /打开 X @demo_shiro.*采集已开启/ })
      .getAttribute("href"),
  ).toBe("https://x.com/demo_shiro");
  expect(
    screen
      .getByRole("link", { name: /打开 Pixiv 100001.*采集已关闭/ })
      .getAttribute("href"),
  ).toBe("https://www.pixiv.net/users/100001");
  fireEvent.click(screen.getByRole("button", { name: "列表" }));
  const row = screen.getAllByRole("row")[1];
  expect(within(row).getByText("已授权")).toBeTruthy();
  expect(within(row).getAllByText("日语").length).toBeGreaterThan(0);
  expect(within(row).getByText("100001")).toBeTruthy();
});

test("author search is debounced, cancellable and has a filtered empty-state reset", async () => {
  const calls: { search?: string; signal?: AbortSignal }[] = [];
  vi.spyOn(client, "GET").mockImplementation(async (_path, options) => {
    const o = options as {
      params: { query: { search?: string } };
      signal: AbortSignal;
    };
    calls.push({ search: o.params.query.search, signal: o.signal });
    return response({
      items: o.params.query.search ? [] : [author],
      total: o.params.query.search ? 0 : 1,
      nextCursor: null,
    }) as never;
  });
  setup();
  await screen.findByText(author.displayName);
  const field = screen.getByPlaceholderText("搜索作者昵称或平台账号");
  fireEvent.change(field, { target: { value: "d" } });
  fireEvent.change(field, { target: { value: "demo" } });
  expect(calls).toHaveLength(1);
  await screen.findByText("没有符合条件的作者");
  expect(calls.at(-1)?.search).toBe("demo");
  expect(calls.at(-1)?.signal).toBeInstanceOf(AbortSignal);
  fireEvent.click(screen.getAllByRole("button", { name: "清除筛选" })[0]);
  await screen.findByText(author.displayName);
  expect((field as HTMLInputElement).value).toBe("");
});
