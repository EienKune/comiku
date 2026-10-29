import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { client } from "../account/api";
import { useCandidateReviewSession } from "./use-candidate-review-session";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const success = (sessionId: string) => ({
  data: { sessionId, expiresAt: "2030-01-01T00:00:00Z", counts: {} },
  response: new Response(null, { status: 201 }),
});

test("old-filter refresh rejection cannot overwrite new-filter success or refreshing state", async () => {
  let rejectOld!: (error: Error) => void;
  let finishNew!: (value: ReturnType<typeof success>) => void;
  vi.spyOn(client, "POST").mockImplementation((async (
    _path: unknown,
    options: { body: { search?: string; replaceSessionId?: string } },
  ) => {
    if (!options.body.replaceSessionId) return success(options.body.search!);
    return options.body.search === "old"
      ? new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
      : new Promise((resolve) => {
          finishNew = resolve;
        });
  }) as never);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ search }) => useCandidateReviewSession({ search }),
    { initialProps: { search: "old" }, wrapper },
  );
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe("old"),
  );
  let old!: Promise<void>;
  act(() => {
    old = hook.result.current.refresh();
  });
  hook.rerender({ search: "new" });
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe("new"),
  );
  expect(hook.result.current.refreshing).toBe(false);
  let current!: Promise<void>;
  act(() => {
    current = hook.result.current.refresh();
  });
  await act(async () => {
    finishNew(success("new-refreshed"));
    await current;
  });
  await act(async () => {
    rejectOld(new Error("old request failed"));
    await old;
  });
  expect(hook.result.current.session?.sessionId).toBe("new-refreshed");
  expect(hook.result.current.error).toBeFalsy();
  expect(hook.result.current.refreshing).toBe(false);
  cache.clear();
});

test("returning to a filter gives it a new generation while an old refresh fails", async () => {
  let rejectOld!: (error: Error) => void;
  let finishNew!: (value: ReturnType<typeof success>) => void;
  let refreshes = 0;
  vi.spyOn(client, "POST").mockImplementation((async (
    _path: unknown,
    options: { body: { search?: string; replaceSessionId?: string } },
  ) => {
    if (!options.body.replaceSessionId) return success(options.body.search!);
    return ++refreshes === 1
      ? new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
      : new Promise((resolve) => {
          finishNew = resolve;
        });
  }) as never);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ search }) => useCandidateReviewSession({ search }),
    { initialProps: { search: "old" }, wrapper },
  );
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe("old"),
  );
  let old!: Promise<void>;
  act(() => {
    old = hook.result.current.refresh();
  });
  hook.rerender({ search: "other" });
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe("other"),
  );
  hook.rerender({ search: "old" });
  let current!: Promise<void>;
  act(() => {
    current = hook.result.current.refresh();
  });
  await act(async () => {
    rejectOld(new Error("stale failure"));
    await old;
  });
  expect(hook.result.current.refreshing).toBe(true);
  expect(hook.result.current.error).toBeFalsy();
  await act(async () => {
    finishNew(success("fresh generation"));
    await current;
  });
  expect(hook.result.current.session?.sessionId).toBe("fresh generation");
  expect(hook.result.current.refreshing).toBe(false);
  expect(hook.result.current.error).toBeFalsy();
  cache.clear();
});

test("filter changes clear a previous current-filter refresh error", async () => {
  vi.spyOn(client, "POST").mockImplementation((async (
    _path: unknown,
    options: { body: { search?: string; replaceSessionId?: string } },
  ) => {
    if (options.body.replaceSessionId)
      throw new Error("current request failed");
    return success(options.body.search!);
  }) as never);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ search }) => useCandidateReviewSession({ search }),
    { initialProps: { search: "old" }, wrapper },
  );
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe("old"),
  );
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(hook.result.current.error).toBe("current request failed");
  hook.rerender({ search: "new" });
  await waitFor(() =>
    expect(hook.result.current.session?.sessionId).toBe("new"),
  );
  expect(hook.result.current.error).toBeFalsy();
  cache.clear();
});
