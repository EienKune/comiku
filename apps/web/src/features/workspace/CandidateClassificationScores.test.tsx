import { beforeEach, afterEach, expect, test, vi } from "vitest";
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
import { client } from "../account/api";
import { CandidateClassificationScores } from "./CandidateClassificationScores";
const tag = { label: "art", text: "漫画／插画", tone: "success" as const };
const value = {
  modelKey: "current",
  columns: [
    tag,
    { label: "related", text: "相关", tone: "info" },
    { label: "other", text: "其他", tone: "neutral" },
  ],
  images: [
    {
      mediaId: "one",
      index: 1,
      state: "succeeded",
      scores: [0.8, 0.1, 0.1],
      winner: 0,
    },
    {
      mediaId: "two",
      index: 2,
      state: "succeeded",
      scores: [0.1, 0.7, 0.2],
      winner: 1,
    },
    {
      mediaId: "three",
      index: 3,
      state: "pending",
      scores: null,
      winner: null,
    },
    { mediaId: "four", index: 4, state: "failed", scores: null, winner: null },
  ],
};
const caches: QueryClient[] = [];
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  caches.push(cache);
  return render(
    <QueryClientProvider client={cache}>
      <CandidateClassificationScores candidateId="post" category={tag} />
    </QueryClientProvider>,
  );
}
const trigger = () => screen.getByRole("button", { name: "漫画／插画" });
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  caches.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mock(data = value) {
  return vi.spyOn(client, "GET").mockResolvedValue({
    data,
    response: new Response(null, { status: 200 }),
  } as never);
}
test("scores are lazy, every image is a row with one dynamic header and its own winner; reopen refreshes", async () => {
  const get = mock();
  mount();
  expect(get).not.toHaveBeenCalled();
  fireEvent.focus(trigger());
  const popup = await screen.findByRole("dialog", {
    name: "所有图片的分类分数",
  });
  await waitFor(() =>
    expect(within(popup).getAllByRole("row")).toHaveLength(5),
  );
  expect(within(popup).getAllByRole("columnheader")).toHaveLength(4);
  expect(popup.textContent).toContain("80.0%");
  expect(popup.textContent).toContain("70.0%");
  expect(popup.textContent).toContain("识别中");
  expect(popup.textContent).toContain("识别失败");
  expect(popup.querySelectorAll(".candidate-scores__winner")).toHaveLength(2);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger());
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
});
test("portal crossing and internal scroll stay open; outside and keyboard dismiss", async () => {
  mock();
  mount();
  fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
  const popup = await screen.findByRole("dialog");
  fireEvent.pointerLeave(trigger());
  fireEvent.pointerEnter(popup);
  await act(async () => new Promise((r) => setTimeout(r, 200)));
  fireEvent.scroll(popup.querySelector(".candidate-scores__scroll")!);
  expect(screen.getByRole("dialog")).toBe(popup);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.focus(trigger());
  await screen.findByRole("dialog");
  fireEvent.keyDown(trigger(), { key: "ArrowDown" });
  expect(document.activeElement?.className).toContain(
    "candidate-scores__scroll",
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger());
});
test("binary taxonomy and unavailable rows never invent a score; touch click opens", async () => {
  mock({
    ...value,
    columns: value.columns.slice(0, 2),
    images: [
      {
        mediaId: "one",
        index: 1,
        state: "unavailable",
        scores: null,
        winner: null,
      },
    ],
  });
  mount();
  fireEvent.pointerEnter(trigger(), { pointerType: "touch" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger());
  const popup = await screen.findByRole("dialog");
  await waitFor(() => expect(popup.textContent).toContain("暂无有效分数"));
  expect(within(popup).getAllByRole("columnheader")).toHaveLength(3);
  expect(popup.textContent).not.toContain("0.0%");
});
test("closing aborts a pending fetch and exposes no raw error", async () => {
  let signal: AbortSignal | undefined;
  vi.spyOn(client, "GET").mockImplementation((async (
    _path: unknown,
    options: { signal: AbortSignal },
  ) => {
    signal = options.signal;
    return new Promise(() => {});
  }) as never);
  const mounted = mount();
  fireEvent.click(trigger());
  await waitFor(() => expect(signal).toBeDefined());
  mounted.unmount();
  expect(signal!.aborted).toBe(true);
});

test("cached old-model scores stay hidden during reopen refetch and error, then a new binary model replaces them", async () => {
  const get = mock();
  mount();
  fireEvent.click(trigger());
  await screen.findByRole("table");
  fireEvent.keyDown(document, { key: "Escape" });
  let finish!: (result: unknown) => void;
  get.mockImplementationOnce(
    (() =>
      new Promise((resolve) => {
        finish = resolve;
      })) as never,
  );
  fireEvent.click(trigger());
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("正在读取");
  await act(async () =>
    finish({
      error: { message: "synthetic-private-error" },
      response: new Response(null, { status: 500 }),
    }),
  );
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "synthetic-private-error",
  );
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  get.mockResolvedValueOnce({
    data: {
      modelKey: "new-binary",
      columns: [
        { label: "accept", text: "接纳", tone: "info" },
        { label: "reject", text: "拒绝", tone: "neutral" },
      ],
      images: [
        {
          mediaId: "one",
          index: 1,
          state: "succeeded",
          scores: [0.05, 0.95],
          winner: 1,
        },
      ],
    },
    response: new Response(null, { status: 200 }),
  } as never);
  fireEvent.click(trigger());
  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
  expect(table.textContent).toContain("95.0%");
  expect(table.textContent).not.toContain("80.0%");
});

test("pending rows refresh only while inspected and stop on completion", async () => {
  vi.useFakeTimers();
  const get = mock();
  get
    .mockResolvedValueOnce({
      data: value,
      response: new Response(null, { status: 200 }),
    } as never)
    .mockResolvedValue({
      data: { ...value, images: value.images.slice(0, 2) },
      response: new Response(null, { status: 200 }),
    } as never);
  mount();
  fireEvent.click(trigger());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(get).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(document, { key: "Escape" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(get).toHaveBeenCalledTimes(2);
});

test("long 100-class taxonomy and every image remain complete", async () => {
  const columns = Array.from({ length: 100 }, (_, i) => ({
    label: `class-${i}`,
    text: `长分类${i}`,
    tone: "neutral",
  }));
  mock({
    ...value,
    columns,
    images: Array.from({ length: 12 }, (_, i) => ({
      mediaId: `image-${i}`,
      index: i + 1,
      state: "succeeded",
      scores: columns.map((_, j) => (j === 99 ? 0.8 : 0.2 / 99)),
      winner: 99,
    })),
  });
  mount();
  fireEvent.click(trigger());
  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("columnheader")).toHaveLength(101);
  expect(within(table).getAllByRole("row")).toHaveLength(13);
  expect(table.querySelectorAll("td")).toHaveLength(1200);
});

test("pending background refresh preserves the mounted table and scroll position", async () => {
  vi.useFakeTimers();
  const get = mock();
  const many = {
    ...value,
    images: Array.from({ length: 12 }, (_, index) => ({
      ...value.images[index % 4],
      mediaId: `image-${index}`,
      index: index + 1,
    })),
  };
  let finish!: (result: unknown) => void;
  get
    .mockResolvedValueOnce({
      data: many,
      response: new Response(null, { status: 200 }),
    } as never)
    .mockImplementationOnce(
      (() =>
        new Promise((resolve) => {
          finish = resolve;
        })) as never,
    );
  mount();
  fireEvent.click(trigger());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const table = screen.getByRole("table");
  const scroll = table.closest(".candidate-scores__scroll") as HTMLDivElement;
  scroll.scrollTop = 140;
  fireEvent.scroll(scroll);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(get).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("table")).toBe(table);
  expect(scroll.scrollTop).toBe(140);
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => {
    finish({ data: many, response: new Response(null, { status: 200 }) });
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByRole("table")).toBe(table);
  expect(scroll.scrollTop).toBe(140);
});
