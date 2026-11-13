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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import { WorkSourceRecord } from "./WorkSourceRecord";

vi.mock("../account/account-context", () => ({
  useAccount: () => ({ id: "synthetic-reader" }),
}));

const clients: QueryClient[] = [];
const source: components["schemas"]["WorkSourceDto"] = {
  sources: [],
  candidateId: "synthetic-source",
  platform: "x",
  externalPostId: "synthetic-post",
  sourceUrl: "https://example.test/post/synthetic-post",
  sourceText: "更新后的原帖文字",
  importedSourceText: "入库时的原帖文字",
  media: [
    {
      id: "adopted",
      orderIndex: 0,
      width: 600,
      height: 800,
      mediaType: "image",
      adopted: true,
      disposition: "this_work",
      adoptedByWork: null,
      workImageId: "page-two",
      workOrderIndex: 1,
      available: true,
    },
    {
      id: "excluded",
      orderIndex: 1,
      width: 600,
      height: 800,
      mediaType: "image",
      adopted: false,
      disposition: "unadopted",
      adoptedByWork: null,
      workImageId: null,
      workOrderIndex: null,
      available: true,
    },
    {
      id: "legacy",
      orderIndex: 2,
      width: null,
      height: null,
      mediaType: "image",
      adopted: null,
      disposition: "unknown",
      adoptedByWork: null,
      workImageId: null,
      workOrderIndex: null,
      available: false,
    },
  ],
};
function response<T>(data: T) {
  // Vitest cannot specialize openapi-fetch's generic GET method at the spy boundary.
  return { data, response: new Response(null, { status: 200 }) } as never;
}
function imageUrl(url: string): components["schemas"]["ImageUrlDto"] {
  return {
    url,
    expiresInSeconds: 300,
    status: "ready",
    fileId: "synthetic-file",
    width: 600,
    height: 800,
  };
}
function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkSourceRecord workId="synthetic-work" />
    </QueryClientProvider>,
  );
}
function expand() {
  fireEvent.click(screen.getByText("来源记录"));
}

test("shows every contributing post and distinguishes another output from unused media", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    response({
      ...source,
      sources: [
        {
          ...source,
          media: [
            {
              ...source.media[0],
              disposition: "this_work",
              adoptedByWork: null,
            },
            {
              ...source.media[1],
              adopted: null,
              disposition: "other_work",
              adoptedByWork: {
                id: "another-work",
                workNumber: 42,
                title: "后篇",
              },
            },
            { ...source.media[2], disposition: "unknown", adoptedByWork: null },
          ],
        },
        {
          ...source,
          candidateId: "second-source",
          platform: "pixiv",
          externalPostId: "second-post",
          sourceUrl: "https://example.test/second-post",
          sourceText: "第二帖正文",
          importedSourceText: "第二帖正文",
          media: [
            {
              ...source.media[1],
              id: "unused-second",
              disposition: "unadopted",
              adoptedByWork: null,
            },
          ],
        },
      ],
    }),
  );
  mount();
  expand();
  expect(await screen.findByText("第二帖正文")).toBeTruthy();
  const usedElsewhere = screen.getByRole("link", { name: /42.*后篇/ });
  expect(usedElsewhere.getAttribute("href")).toBe("/works/another-work");
  expect(screen.getAllByText("未采用")).toHaveLength(1);
  expect(screen.getAllByRole("link", { name: "查看原帖" })).toHaveLength(2);
  expect(screen.getByText(/2 个来源/)).toBeTruthy();
});
function observer() {
  const observers: {
    callback: IntersectionObserverCallback;
    targets: Element[];
  }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      disconnect() {}
      unobserve() {}
    },
  );
  return (label: string, visible = true) => {
    const target = screen.getByRole("button", { name: label });
    const current = observers.find((item) => item.targets.includes(target));
    expect(current).toBeDefined();
    act(() =>
      current!.callback(
        [
          {
            target,
            isIntersecting: visible,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
  };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("does not read source until expanded and signs only visible thumbnails, never originals", async () => {
  const show = observer();
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/works/{id}/source") return response(source);
    return response(imageUrl("https://example.test/thumbnail.png"));
  });
  mount();
  expect(get).not.toHaveBeenCalled();
  expand();
  await screen.findByRole("button", { name: "查看来源原图 1" });
  expect(get).toHaveBeenCalledTimes(1);
  show("查看来源原图 1");
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(get.mock.calls[1]).toMatchObject([
    "/api/works/{workId}/source/media/{mediaId}/url",
    {
      params: {
        path: { workId: "synthetic-work", mediaId: "adopted" },
        query: { variant: "thumbnail" },
      },
    },
  ]);
  expect(
    screen.getByRole("button", { name: "查看来源原图 2" }).querySelector("img"),
  ).toBeNull();
});

test("shows complete media membership, page mapping, and unknown historical adoption separately", async () => {
  observer();
  vi.spyOn(client, "GET").mockResolvedValue(response(source));
  mount();
  expand();
  await screen.findByText("采用 · 第 2 页");
  expect(
    screen.getByText("原帖 3 张 · 采用 1 张 · 未采用 1 张 · 未知 1 张"),
  ).toBeTruthy();
  expect(screen.getAllByText("未采用")).toHaveLength(1);
  expect(screen.getByText("采用情况未知")).toBeTruthy();
  expect(screen.getByText("原图不可用")).toBeTruthy();
  expect(screen.getByText("更新后的原帖文字")).toBeTruthy();
  expect(screen.getByText("入库时的原帖文字")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "查看原帖" }).getAttribute("href"),
  ).toBe(source.sourceUrl);
});

test("requests an original only on explicit preview and can navigate to unadopted media", async () => {
  observer();
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async (path) =>
      path === "/api/works/{id}/source"
        ? response(source)
        : response(imageUrl("https://example.test/original.png")),
    );
  mount();
  expand();
  const trigger = await screen.findByRole("button", { name: "查看来源原图 1" });
  trigger.focus();
  fireEvent.click(trigger);
  const preview = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(within(preview).getByRole("img").getAttribute("src")).toBe(
      "https://example.test/original.png",
    ),
  );
  expect(get.mock.calls[1]).toMatchObject([
    "/api/works/{workId}/source/media/{mediaId}/url",
    {
      params: {
        path: { workId: "synthetic-work", mediaId: "adopted" },
        query: { variant: "original" },
      },
    },
  ]);
  fireEvent.click(within(preview).getByRole("button", { name: "下一张" }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  expect(get.mock.calls[2]).toMatchObject([
    "/api/works/{workId}/source/media/{mediaId}/url",
    {
      params: { path: { mediaId: "excluded" }, query: { variant: "original" } },
    },
  ]);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("distinguishes a loaded empty source from a failed read and allows explicit retry", async () => {
  vi.spyOn(client, "GET")
    .mockResolvedValueOnce({
      error: { statusCode: 503, message: "来源暂时不可用" },
      response: new Response(null, { status: 503 }),
    })
    .mockResolvedValueOnce(response({ ...source, media: [] }));
  mount();
  expand();
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "来源暂时不可用",
  );
  expect(screen.queryByText("没有来源图片")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("没有来源图片")).toBeTruthy();
});

test.each([403, 404])(
  "does not expose source media after an access or scope error (%s)",
  async (status) => {
    const get = vi.spyOn(client, "GET").mockResolvedValue({
      error: {
        statusCode: status,
        message: status === 403 ? "无权读取来源记录" : "作品不存在",
      },
      response: new Response(null, { status }),
    });
    mount();
    expand();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /查看来源原图/ })).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  },
);

test("an out-of-scope original response never displays a different work image", async () => {
  observer();
  vi.spyOn(client, "GET")
    .mockResolvedValueOnce(response(source))
    .mockResolvedValueOnce({
      error: { statusCode: 404, message: "作品来源图片不存在" },
      response: new Response(null, { status: 404 }),
    });
  mount();
  expand();
  fireEvent.click(
    await screen.findByRole("button", { name: "查看来源原图 2" }),
  );
  const preview = await screen.findByRole("dialog");
  await waitFor(() => expect(within(preview).getByRole("alert")).toBeTruthy());
  expect(within(preview).queryByRole("img")).toBeNull();
});

test("keeps loading distinct from empty source records", async () => {
  vi.spyOn(client, "GET").mockImplementation(() => new Promise(() => {}));
  mount();
  expand();
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(screen.queryByText("没有来源图片")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("collapsing source records closes previews and stops visible image reads", async () => {
  observer();
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async (path) =>
      path === "/api/works/{id}/source"
        ? response(source)
        : response(imageUrl("https://example.test/original.png")),
    );
  mount();
  expand();
  fireEvent.click(
    await screen.findByRole("button", { name: "查看来源原图 1" }),
  );
  await screen.findByRole("dialog");
  const calls = get.mock.calls.length;
  expand();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: /查看来源原图/ })).toBeNull();
  expect(get).toHaveBeenCalledTimes(calls);
});

test("hides cached protected source content when a refresh loses access", async () => {
  observer();
  const get = vi.spyOn(client, "GET").mockResolvedValueOnce(response(source));
  mount();
  expand();
  await screen.findByText("采用 · 第 2 页");
  get.mockResolvedValue({
    error: { statusCode: 403, message: "无权读取来源记录" },
    response: new Response(null, { status: 403 }),
  });
  await act(async () => {
    await clients[0].invalidateQueries({ queryKey: ["work-source"] });
  });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "无权读取来源记录",
  );
  expect(screen.queryByText("采用 · 第 2 页")).toBeNull();
  expect(screen.queryByText("更新后的原帖文字")).toBeNull();
});

test("does not turn unsafe source URLs into navigation links", async () => {
  observer();
  vi.spyOn(client, "GET").mockResolvedValue(
    response({ ...source, sourceUrl: "javascript:alert('synthetic')" }),
  );
  mount();
  expand();
  await screen.findByText("采用 · 第 2 页");
  expect(screen.queryByRole("link", { name: "查看原帖" })).toBeNull();
});
