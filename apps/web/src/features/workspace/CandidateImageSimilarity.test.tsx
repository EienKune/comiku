import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import { CandidateImageSimilarityAction } from "./CandidateImageSimilarity";
vi.mock("../account/account-context", () => ({
  useAccount: () => ({ id: "actor" }),
}));
type Result = components["schemas"]["ImageSimilarityResultDto"];
const match: components["schemas"]["ImageSimilarityMatchDto"] = {
  workId: "work",
  workNumber: 42,
  workTitle: "对白差分",
  authorId: "other",
  authorName: "另一位作者",
  imageId: "adopted",
  index: 1,
  imageCount: 3,
  workflowStatus: "translating",
  reviewStatus: "needs_review",
  archived: false,
  matchKind: "exact",
  distance: 0,
};
const result = (state: Result["state"] = "ready"): Result => ({
  state,
  coverage: { total: 5, ready: 3, pending: 1, failed: 1 },
  matches: [match],
  ...(state === "failed" ? { error: "invalid_image" } : {}),
});
const caches: QueryClient[] = [];
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  caches.push(cache);
  return render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <CandidateImageSimilarityAction
          candidateId="candidate"
          mediaId="media"
          authorName="当前作者"
          index={2}
          sourceUrl="https://example.invalid/source.png"
        />
      </MemoryRouter>
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
  vi.spyOn(client, "GET").mockImplementation((async () => ({
    data: {
      url: "https://example.invalid/compare.png",
      expiresInSeconds: 3600,
      status: "ready",
    },
    response: new Response(),
  })) as typeof client.GET);
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
});
test("global matches expose work identity, author, page and review status; comparison returns to the retained result scroll", async () => {
  const prepare = vi
    .spyOn(client, "POST")
    .mockResolvedValue({ data: result(), response: new Response() } as never);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "查找相似图" }));
  await screen.findByText("另一位作者");
  expect(screen.getByText("#42 · 第 2 / 3 页")).toBeTruthy();
  expect(screen.getByText("待审核")).toBeTruthy();
  const link = screen.getByRole("link", { name: "对白差分" });
  expect(link.getAttribute("href")).toBe("/works/work");
  expect(link.getAttribute("target")).toBe("_blank");
  const scroll = document.querySelector<HTMLElement>(".similarity-scroll")!;
  scroll.scrollTop = 170;
  fireEvent.click(
    screen.getByRole("button", { name: "对照 对白差分 第 2 页" }),
  );
  await screen.findByAltText("历史作品原图");
  fireEvent.click(screen.getByRole("button", { name: "返回相似结果" }));
  await screen.findByText("另一位作者");
  expect(scroll.scrollTop).toBe(170);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "返回图片" })).toBeTruthy();
});
test("only preparing current image polls, stops at partial coverage, and still shows exact matches on failed fingerprints", async () => {
  vi.spyOn(client, "POST").mockResolvedValue({
    data: result("preparing"),
    response: new Response(),
  } as never);
  const get = vi.mocked(client.GET);
  const reads: string[] = [];
  get.mockImplementation((async (path: string) => {
    reads.push(path);
    return path.includes("image-similarity")
      ? { data: result("partial"), response: new Response() }
      : {
          data: {
            url: "https://example.invalid/thumb.png",
            expiresInSeconds: 3600,
            status: "ready",
          },
          response: new Response(),
        };
  }) as typeof client.GET);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "查找相似图" }));
  await screen.findByText("正在准备当前图片指纹…");
  await screen.findByText(/部分图片尚未建立指纹/, {}, { timeout: 3500 });
  expect(screen.getByText("另一位作者")).toBeTruthy();
  expect(
    reads.filter((path) => path.includes("image-similarity")),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "返回图片" }));
  vi.mocked(client.POST).mockResolvedValue({
    data: result("failed"),
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "查找相似图" }));
  await screen.findByText("当前图片无法解码，暂时只能检查文件是否相同。");
  expect(
    screen.getByRole("button", { name: "对照 对白差分 第 2 页" }),
  ).toBeTruthy();
});
test("closing aborts the request and ignores a late result before another query opens", async () => {
  let finish:
    ((value: { data: Result; response: Response }) => void) | undefined;
  let signal: AbortSignal | undefined;
  vi.spyOn(client, "POST").mockImplementation((async (
    _path: string,
    options: { signal: AbortSignal },
  ) => {
    signal = options.signal;
    return new Promise<{ data: Result; response: Response }>((resolve) => {
      finish = resolve;
    });
  }) as typeof client.POST);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "查找相似图" }));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "返回图片" }));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish?.({ data: result(), response: new Response() }));
  expect(screen.queryByText("另一位作者")).toBeNull();
  vi.mocked(client.POST).mockResolvedValue({
    data: { ...result(), matches: [] },
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "查找相似图" }));
  await screen.findByText("未找到相似图片。");
  expect(screen.queryByText("另一位作者")).toBeNull();
});
