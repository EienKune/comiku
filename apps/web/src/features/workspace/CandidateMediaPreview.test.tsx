import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
import { CandidateMediaPreview } from "./CandidateMediaPreview";

vi.mock("../account/account-context", () => ({
  useAccount: () => ({ id: "reviewer" }),
}));

type Candidate = Pick<
  components["schemas"]["CandidateDto"],
  "id" | "authorName" | "media"
>;
const candidate: Candidate = {
  id: "post",
  authorName: "画师",
  media: Array.from({ length: 100 }, (_, index) => ({
    id: `image-${index + 1}`,
    externalMediaId: `${index + 1}`,
    orderIndex: index,
    width: 100,
    height: 100,
    mediaType: "photo",
  })),
};
const requests: { id: string; variant: string }[] = [];
const caches: QueryClient[] = [];
const observers: {
  callback: IntersectionObserverCallback;
  observer: IntersectionObserver;
  targets: Set<Element>;
}[] = [];

function mount(value = candidate) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  caches.push(cache);
  const element = (next: Candidate) => (
    <QueryClientProvider client={cache}>
      <CandidateMediaPreview candidate={next} />
    </QueryClientProvider>
  );
  const result = render(element(value));
  return {
    ...result,
    cache,
    update: (next: Candidate) => result.rerender(element(next)),
  };
}
const trigger = () =>
  screen.getByRole("button", { name: "查看 100 张图片总览" });
async function visible(...mediaIds: string[]) {
  await act(async () => {
    for (const item of observers) {
      const entries = Array.from(item.targets).map((target) => ({
        target,
        isIntersecting: mediaIds.includes(
          target.getAttribute("data-media-id")!,
        ),
      })) as IntersectionObserverEntry[];
      item.callback(entries, item.observer);
    }
  });
}

beforeEach(() => {
  requests.length = 0;
  observers.length = 0;
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? "mouse";
      }
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      record;
      constructor(callback: IntersectionObserverCallback) {
        this.record = {
          callback,
          observer: this as unknown as IntersectionObserver,
          targets: new Set<Element>(),
        };
        observers.push(this.record);
      }
      observe(element: Element) {
        this.record.targets.add(element);
      }
      disconnect() {
        this.record.targets.clear();
      }
    },
  );
  vi.spyOn(client, "GET").mockImplementation(async (_path, options) => {
    const input = options as {
      params: { path: { mediaId: string }; query?: { variant?: string } };
    };
    const id = input.params.path.mediaId;
    const variant = input.params.query?.variant ?? "original";
    requests.push({ id, variant });
    return {
      data: {
        url: `/api/test-media/${variant}/${id}`,
        status: "ready",
        expiresInSeconds: 3600,
        width: 100,
        height: 100,
        fileId: `file-${id}`,
      },
      response: new Response(null, { status: 200 }),
    } as never;
  });
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach((cache) => cache.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("closed overview requests only the first thumbnail; opening signs only visible thumbnails", async () => {
  mount();
  await waitFor(() =>
    expect(requests).toEqual([{ id: "image-1", variant: "thumbnail" }]),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger().closest("button button")).toBeNull();
  fireEvent.click(trigger());
  const popup = screen.getByRole("dialog", { name: "画师 的图片总览" });
  expect(within(popup).getAllByRole("button")).toHaveLength(100);
  expect(requests).toHaveLength(1);
  await visible("image-1", "image-2", "image-3");
  await waitFor(() => expect(requests).toHaveLength(3));
  expect(requests).toEqual([
    { id: "image-1", variant: "thumbnail" },
    { id: "image-2", variant: "thumbnail" },
    { id: "image-3", variant: "thumbnail" },
  ]);
  fireEvent.keyDown(document, { key: "Escape" });
  await visible("image-99");
  expect(requests).toHaveLength(3);
});

test("the Nth thumbnail opens only its original and arrow navigation requests only the current page", async () => {
  mount();
  fireEvent.click(trigger());
  fireEvent.click(screen.getByRole("button", { name: "查看第 3 张图片" }));
  const viewer = screen.getByRole("dialog");
  await waitFor(() =>
    expect(within(viewer).getByRole("img").getAttribute("src")).toBe(
      "/api/test-media/original/image-3",
    ),
  );
  expect(viewer.getAttribute("aria-label")).toContain("第 3 张，共 100 张");
  expect(requests.filter((r) => r.variant === "original")).toEqual([
    { id: "image-3", variant: "original" },
  ]);
  fireEvent.keyDown(document, { key: "ArrowRight" });
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: /第 4 页/ }).getAttribute("src"),
    ).toBe("/api/test-media/original/image-4"),
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

test("hover crosses the portal and internal scrolling stays open; escape returns focus without reopening", async () => {
  mount();
  fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
  const popup = screen.getByRole("dialog");
  fireEvent.pointerLeave(trigger());
  fireEvent.pointerEnter(popup);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  fireEvent.scroll(popup);
  expect(screen.getByRole("dialog")).toBe(popup);
  act(() => trigger().focus());
  fireEvent.keyDown(trigger(), { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    within(popup).getByRole("button", { name: "查看第 1 张图片" }),
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

test("touch needs a click and outside pointer closes without stealing outside focus", () => {
  mount();
  fireEvent.pointerEnter(trigger(), { pointerType: "touch" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger());
  expect(screen.getByRole("dialog")).toBeTruthy();
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  fireEvent.pointerDown(outside);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

test("viewer identity follows the selected media through a reorder and closes when it is removed", async () => {
  const view = mount({ ...candidate, media: candidate.media.slice(0, 3) });
  fireEvent.click(screen.getByRole("button", { name: "查看 3 张图片总览" }));
  fireEvent.click(screen.getByRole("button", { name: "查看第 2 张图片" }));
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: /第 2 页/ }).getAttribute("src"),
    ).toBe("/api/test-media/original/image-2"),
  );
  view.update({
    ...candidate,
    media: [candidate.media[1], candidate.media[0], candidate.media[2]],
  });
  expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain(
    "第 1 张，共 3 张",
  );
  expect(screen.getByRole("img", { name: /第 1 页/ }).getAttribute("src")).toBe(
    "/api/test-media/original/image-2",
  );
  view.update({ ...candidate, media: [candidate.media[0]] });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /图片总览/ })).toBeNull();
  expect(requests.filter((r) => r.variant === "original")).toEqual([
    { id: "image-2", variant: "original" },
  ]);
});

test("empty media has no requests or active image controls", async () => {
  mount({ ...candidate, media: [] });
  expect(requests).toEqual([]);
  expect(screen.queryByRole("button", { name: /图片总览/ })).toBeNull();
  const cover = screen.getByRole("button", { name: /图片组大图/ });
  expect(cover.hasAttribute("disabled")).toBe(true);
  fireEvent.click(cover);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests).toEqual([]);
});

test("a shrinking overview closes and returns focus to the surviving cover", async () => {
  const view = mount({ ...candidate, media: candidate.media.slice(0, 3) });
  const count = screen.getByRole("button", { name: "查看 3 张图片总览" });
  act(() => count.focus());
  fireEvent.keyDown(count, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "查看第 1 张图片" }),
  );
  view.update({ ...candidate, media: [candidate.media[0]] });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /图片组大图/ }),
  );
});

test("reordered thumbnails wait for fresh visibility before signing again", async () => {
  const view = mount({ ...candidate, media: candidate.media.slice(0, 3) });
  fireEvent.click(screen.getByRole("button", { name: "查看 3 张图片总览" }));
  await visible("image-2");
  await waitFor(() => expect(requests).toHaveLength(2));
  view.update({
    ...candidate,
    media: [candidate.media[0], candidate.media[2], candidate.media[1]],
  });
  await act(async () => {
    await view.cache.invalidateQueries({
      queryKey: ["thumbnail", "candidate-media", "post", "image-2"],
    });
  });
  expect(requests.filter((request) => request.id === "image-2")).toHaveLength(
    1,
  );
});
