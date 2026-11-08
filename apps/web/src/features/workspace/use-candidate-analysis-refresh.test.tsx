import { afterEach, expect, test, vi } from "vitest";
import { type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type InfiniteData,
  type QueryFunction,
} from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { useCandidateAnalysisRefresh } from "./use-candidate-analysis-refresh";

type CandidatePage = InfiniteData<
  components["schemas"]["CandidatePageDto"] & { analysisPending?: boolean }
>;
const sourceKey = ["candidates", "pending", "uncertain"] as const;
const destinationKey = ["candidates", "pending", "priority"] as const;
const disposers: (() => void)[] = [];

function page(
  priority?: "unprocessed" | "queued" | "high" | "failed",
  analysisPending?: boolean,
): CandidatePage {
  return {
    pages: [
      {
        items: priority
          ? [
              {
                id: "synthetic-candidate",
                text: priority,
              } as components["schemas"]["CandidateDto"],
            ]
          : [],
        total: priority ? 1 : 0,
        nextCursor: null,
        analysisPending:
          analysisPending ??
          (priority === "queued" || priority === "unprocessed"),
      },
    ],
    pageParams: [null],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function fixture() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  focusManager.setFocused(true);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  disposers.push(() => client.clear());
  function observe(
    key: typeof sourceKey | typeof destinationKey,
    queryFn: QueryFunction<CandidatePage>,
    initial?: CandidatePage,
  ) {
    if (initial) client.setQueryData(key, initial);
    const observer = new QueryObserver(client, { queryKey: key, queryFn });
    disposers.push(observer.subscribe(() => {}));
    return observer;
  }
  function mount() {
    return renderHook(useCandidateAnalysisRefresh, {
      wrapper: ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  }
  return { client, observe, mount };
}

afterEach(() => {
  cleanup();
  while (disposers.length) disposers.pop()!();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

test("range metadata follows an unprocessed candidate through queueing and completion", async () => {
  const { client, observe, mount } = fixture();
  let sourcePage = page("unprocessed", true);
  const readSource = vi.fn(async () => sourcePage);
  observe(sourceKey, readSource, sourcePage);
  const readDestination = vi.fn(async () => page());
  observe(destinationKey, readDestination, page(undefined, true));
  const mounted = mount();
  expect(vi.getTimerCount()).toBe(1);

  sourcePage = page("queued", true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(
    client.getQueryData<CandidatePage>(sourceKey)?.pages[0].items[0]?.text,
  ).toBe("queued");
  expect(readSource).toHaveBeenCalledTimes(1);

  sourcePage = page("high", false);
  readDestination.mockResolvedValue(page(undefined, false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  await waitFor(() =>
    expect(
      client.getQueryData<CandidatePage>(sourceKey)?.pages[0].items[0]?.text,
    ).toBe("high"),
  );
  expect(vi.getTimerCount()).toBe(0);
  const readsAfterCompletion = readSource.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(readSource).toHaveBeenCalledTimes(readsAfterCompletion);
  mounted.unmount();
});

test("pending outside loaded pages and groups refreshes the current view in the foreground only", async () => {
  const { observe, mount } = fixture();
  const readSource = vi.fn(async () => page("high", true));
  observe(sourceKey, readSource, page("high", true));
  const readDestination = vi.fn(async () => page(undefined, true));
  observe(destinationKey, readDestination, page(undefined, true));
  const mounted = mount();
  await act(async () => {
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(readSource).not.toHaveBeenCalled();
  expect(readDestination).not.toHaveBeenCalled();
  await act(async () => {
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(readSource).toHaveBeenCalledTimes(1));
  expect(readDestination).toHaveBeenCalledTimes(1);
  mounted.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["unprocessed", "failed"] as const)(
  "disabled or terminal %s rows with no range work do not poll",
  async (priority) => {
    const { observe, mount } = fixture();
    const readSource = vi.fn(async () => page(priority, false));
    observe(sourceKey, readSource, page(priority, false));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(readSource).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("completion refetches a destination after its stale initial request settles", async () => {
  const { client, observe, mount } = fixture();
  const initialDestination = deferred<CandidatePage>();
  const source = observe(sourceKey, async () => page(), page("queued"));
  const readDestination = vi
    .fn<() => Promise<CandidatePage>>()
    .mockImplementationOnce(() => initialDestination.promise)
    .mockResolvedValue(page("high"));
  observe(destinationKey, readDestination);
  mount();

  await act(async () => {
    await source.refetch();
  });
  expect(readDestination).toHaveBeenCalledTimes(1);
  await act(async () => {
    initialDestination.resolve(page());
  });
  await waitFor(() => expect(readDestination).toHaveBeenCalledTimes(2));
  expect(
    client.getQueryData<CandidatePage>(destinationKey)?.pages[0].items,
  ).toHaveLength(1);
});

test("polling does not cancel or restart a request taking longer than five seconds", async () => {
  const { observe, mount } = fixture();
  const slow = deferred<CandidatePage>();
  const aborted = vi.fn();
  const readSource = vi.fn<QueryFunction<CandidatePage>>(({ signal }) => {
    signal.addEventListener("abort", aborted, { once: true });
    return slow.promise;
  });
  observe(sourceKey, readSource, page("queued"));
  observe(destinationKey, async () => page(), page());
  mount();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(readSource).toHaveBeenCalledTimes(1);
  expect(aborted).not.toHaveBeenCalled();
  await act(async () => {
    slow.resolve(page("queued"));
  });
});

test("completion in the background retains its final refresh until focus returns", async () => {
  const { client, observe, mount } = fixture();
  const source = observe(sourceKey, async () => page(), page("queued"));
  const readDestination = vi.fn(async () => page("high"));
  observe(destinationKey, readDestination, page());
  mount();

  await act(async () => {
    focusManager.setFocused(false);
    await source.refetch();
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(readDestination).not.toHaveBeenCalled();
  await act(async () => {
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(readDestination).toHaveBeenCalledTimes(1));
  expect(
    client.getQueryData<CandidatePage>(destinationKey)?.pages[0].items,
  ).toHaveLength(1);
});

test("unmount clears polling and abandons a final refresh awaiting an initial response", async () => {
  const { observe, mount } = fixture();
  const initialDestination = deferred<CandidatePage>();
  const readSource = vi.fn(async () => page());
  const source = observe(sourceKey, readSource, page("queued"));
  const readDestination = vi.fn(() => initialDestination.promise);
  observe(destinationKey, readDestination);
  const mounted = mount();
  await act(async () => {
    await source.refetch();
  });
  const sourceReadsBeforeUnmount = readSource.mock.calls.length;
  const destinationReadsBeforeUnmount = readDestination.mock.calls.length;
  mounted.unmount();

  await act(async () => {
    initialDestination.resolve(page());
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(readSource).toHaveBeenCalledTimes(sourceReadsBeforeUnmount);
  expect(readDestination).toHaveBeenCalledTimes(destinationReadsBeforeUnmount);
  expect(vi.getTimerCount()).toBe(0);
});

test("unmount clears a polling interval while analysis remains queued", async () => {
  const { observe, mount } = fixture();
  const readSource = vi.fn(async () => page("queued"));
  observe(sourceKey, readSource, page("queued"));
  const mounted = mount();
  expect(vi.getTimerCount()).toBe(1);
  mounted.unmount();

  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(readSource).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("failed plus queued media keep polling even with a successful score, then stop when all media are terminal", async () => {
  const { client, observe, mount } = fixture();
  const readSource = vi.fn(async () => page("high", true));
  observe(sourceKey, readSource, page("high", true));
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(readSource).toHaveBeenCalledTimes(1);
  readSource.mockResolvedValue(page("high", false));
  await act(async () => {
    await client.invalidateQueries({ queryKey: sourceKey });
  });
  const reads = readSource.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(readSource).toHaveBeenCalledTimes(reads);
  expect(vi.getTimerCount()).toBe(0);
});
