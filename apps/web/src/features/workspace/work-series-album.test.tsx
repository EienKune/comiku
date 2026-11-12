import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import { WorkAlbum } from "./WorkAlbum";
import {
  WorkSeriesDetailPage,
  WorkSeriesDirectoryPage,
} from "./WorkSeriesPages";
import { groupAlbumImages } from "./work-album-data";
vi.mock("../account/account-context", () => ({
  useAccount: () => ({
    id: "actor",
    permissions: ["works:read", "works:metadata"],
  }),
}));
const caches: QueryClient[] = [];
type GetCall = [string, { params?: { query?: Record<string, unknown> } }?];

const series: components["schemas"]["WorkSeriesDetailDto"] = {
  id: "series",
  title: "约定",
  authorId: "author",
  authorName: "画师",
  revision: 7,
  memberCount: 2,
  updatedAt: "2026-11-12T00:00:00Z",
  coverImages: [],
  archived: false,
  visibleTotal: 2,
  nextCursor: null,
  entries: [0, 1].map((i) => ({
    id: `entry-${i}`,
    workId: `work-${i}`,
    workNumber: 40 + i,
    title: `章节 ${i + 1}`,
    workflowStatus: "translating",
    reviewStatus: "normal",
    archived: false,
    orderIndex: i,
    label: null,
    imageCount: 2,
    coverImageId: null,
  })),
};
const image = (
  id: string,
  workId: string,
  orderIndex = 0,
): components["schemas"]["WorkAlbumImageDto"] => ({
  id,
  workId,
  workNumber: workId === "one" ? 41 : 42,
  workTitle: workId === "one" ? "第一部" : "第二部",
  authorName: "画师",
  orderIndex,
  imageCount: workId === "one" ? 2 : 1,
  sourceLanguage: "ja",
  workflowStatus: "translating",
  reviewStatus: "normal",
  importedAt: "2026-11-11T17:00:00Z",
});
function mount(content: React.ReactNode, url = "/") {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  caches.push(cache);
  return render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[url]}>{content}</MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
});
test("album groups by Shanghai import date and reads only filtered adopted image pages with explicit pagination", async () => {
  const items = [image("one-a", "one"), image("one-b", "one", 1)];
  expect(groupAlbumImages(items)[0][0]).toBe("2026年11月12日");
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options?: { params?: { query?: { cursor?: string } } },
  ) =>
    path === "/api/works/album"
      ? {
          data: {
            items: options?.params?.query?.cursor
              ? [image("two-a", "two")]
              : items,
            total: 3,
            workTotal: 2,
            nextCursor: options?.params?.query?.cursor ? null : "next",
          },
          response: new Response(),
        }
      : {
          data: {
            url: "https://example.invalid/synthetic.png",
            expiresInSeconds: 3600,
            status: "ready",
          },
          response: new Response(),
        }) as typeof client.GET);
  mount(<WorkAlbum phase="translation" language="ja" mine search="约定" />);
  await screen.findByRole("button", { name: "画师 作品 #41 第 1 / 2 页" });
  expect(
    (get.mock.calls as unknown as GetCall[]).filter(
      ([path]) => path === "/api/works/album",
    ),
  ).toHaveLength(1);
  expect((get.mock.calls as unknown as GetCall[])[0][1]).toMatchObject({
    params: {
      query: {
        phase: "translation",
        sourceLanguage: "ja",
        mine: true,
        search: "约定",
        limit: 60,
      },
    },
  });
  expect(screen.queryByText("第一部")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "再加载 60 张图片" }));
  await screen.findByRole("button", { name: "画师 作品 #42 第 1 / 1 页" });
  fireEvent.click(
    screen.getByRole("button", { name: "画师 作品 #41 第 2 / 2 页" }),
  );
  await screen.findByRole("dialog", {
    name: "第一部 第 2 页，第 2 张，共 3 张",
  });
  fireEvent.click(screen.getByRole("button", { name: "下一张" }));
  await screen.findByRole("dialog", {
    name: "第二部 第 1 页，第 3 张，共 3 张",
  });
  expect(
    screen.getByRole("link", { name: "第二部" }).getAttribute("href"),
  ).toBe("/works/two");
  expect(
    (get.mock.calls as unknown as GetCall[]).some(
      ([path]) => path === "/api/works/{id}",
    ),
  ).toBe(false);
});
test("series directory filters server-side and exposes an explicit next page without loading all series", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    _path: string,
    options?: { params?: { query?: { search?: string; cursor?: string } } },
  ) => ({
    data: {
      items: [
        {
          ...series,
          id: options?.params?.query?.cursor ? "second" : "first",
          title: options?.params?.query?.cursor ? "第二系列" : "第一系列",
        },
      ],
      nextCursor: options?.params?.query?.cursor ? null : "cursor",
      total: 2,
    },
    response: new Response(),
  })) as typeof client.GET);
  mount(<WorkSeriesDirectoryPage />);
  await screen.findByRole("link", { name: "第一系列" });
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "加载更多系列" }));
  await screen.findByRole("link", { name: "第二系列" });
  fireEvent.change(screen.getByRole("textbox", { name: "搜索系列名称" }), {
    target: { value: "约定" },
  });
  await waitFor(() =>
    expect(
      (get.mock.calls as unknown as GetCall[]).some(
        ([, options]) => options?.params?.query?.search === "约定",
      ),
    ).toBe(true),
  );
});
test("series move and label writes carry the observed revision and retain explicit keyboard controls", async () => {
  vi.spyOn(client, "GET").mockImplementation((async () => ({
    data: series,
    response: new Response(),
  })) as typeof client.GET);
  const patch = vi.spyOn(client, "PATCH").mockImplementation((async () => ({
    data: { ...series, revision: 8 },
    response: new Response(),
  })) as typeof client.PATCH);
  mount(
    <Routes>
      <Route
        path="/works/series/:seriesId"
        element={<WorkSeriesDetailPage />}
      />
    </Routes>,
    "/works/series/series",
  );
  await screen.findByRole("heading", { name: "约定" });
  expect(screen.queryByRole("button", { name: "上移作品 #41" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "管理目录" }));
  fireEvent.click(screen.getByRole("button", { name: "上移作品 #41" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0]).toMatchObject([
    "/api/work-series/{id}/entries/{entryId}",
    {
      params: { path: { id: "series", entryId: "entry-1" } },
      body: { expectedRevision: 7, afterEntryId: null },
    },
  ]);
  expect(
    (
      patch.mock.calls as unknown as [
        string,
        { body: components["schemas"]["UpdateWorkSeriesEntryDto"] },
      ][]
    )[0][1].body.requestId,
  ).toMatch(/^[0-9a-f-]{36}$/);
  const label = screen.getByRole("textbox", { name: "作品 #40 的章节标签" });
  fireEvent.change(label, { target: { value: "前篇" } });
  fireEvent.blur(label);
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(
    (
      patch.mock.calls as unknown as [
        string,
        { body: components["schemas"]["UpdateWorkSeriesEntryDto"] },
      ][]
    )[1][1].body,
  ).toMatchObject({
    label: "前篇",
    expectedRevision: 7,
  });
});

test("series history is skipped by default and is fetched only after an explicit opt-in", async () => {
  const queries: boolean[] = [];
  vi.spyOn(client, "GET").mockImplementation((async (
    _path: string,
    options: { params: { query: { includeHistory: boolean } } },
  ) => {
    const history = options.params.query.includeHistory;
    queries.push(history);
    return {
      data: {
        ...series,
        entries: history ? series.entries : [series.entries[0]],
      },
      response: new Response(),
    };
  }) as typeof client.GET);
  mount(
    <Routes>
      <Route
        path="/works/series/:seriesId"
        element={<WorkSeriesDetailPage />}
      />
    </Routes>,
    "/works/series/series",
  );
  await screen.findByRole("link", { name: "章节 1" });
  expect(screen.queryByRole("link", { name: "章节 2" })).toBeNull();
  expect(queries).toEqual([false]);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "显示已归档或舍弃的作品" }),
  );
  await screen.findByRole("link", { name: "章节 2" });
  expect(queries).toEqual([false, true]);
});
