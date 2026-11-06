import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import { SourceSyncControl } from "./SourceSyncControl";

type RunSnapshot = components["schemas"]["SourceFetchProgressSnapshotDto"];
type Progress = components["schemas"]["SourceFetchProgressDto"];
const queryKey = ["source-fetch", "progress"] as const;
const clients: QueryClient[] = [];

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "synthetic-manual-run",
    trigger: "manual",
    status: "running",
    startedAt: "2026-10-27T01:02:00.000Z",
    completedAt: null,
    pagesFetched: 3,
    candidatesCreated: 2,
    mediaStored: 4,
    nextRetryAt: null,
    ...overrides,
  };
}

function response<T>(data: T) {
  return { data, response: new Response(null, { status: 200 }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function createClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(queryClient);
  return queryClient;
}

function mount(
  queryClient = createClient(),
  onCompleted?: () => void | Promise<void>,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SourceSyncControl onCompleted={onCompleted} />
    </QueryClientProvider>,
  );
}

function syncButton() {
  return screen.getByRole("button", { name: "同步图源" });
}

function inspectTarget() {
  return syncButton().parentElement!;
}

afterEach(() => {
  cleanup();
  while (clients.length) clients.pop()!.clear();
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("entry and remounts recover an existing run from progress without enqueueing", async () => {
  const active = snapshot();
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(response({ active, lastManual: null }) as never);
  const post = vi.spyOn(client, "POST");
  const cachedClient = createClient();
  const mounted = mount(cachedClient);

  await waitFor(() => expect(syncButton().hasAttribute("disabled")).toBe(true));
  await waitFor(() =>
    expect(cachedClient.getQueryData(queryKey)).toEqual({
      active,
      lastManual: null,
    }),
  );
  expect(syncButton().querySelector("svg.ui-spin")).toBeTruthy();
  fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  expect((await screen.findByRole("tooltip")).textContent).toMatch(
    /手动同步.*同步中/,
  );
  expect(post).not.toHaveBeenCalled();

  const readsBeforeRemount = get.mock.calls.length;
  mounted.unmount();
  const cachedMount = mount(cachedClient);
  await waitFor(() =>
    expect(get.mock.calls.length).toBeGreaterThan(readsBeforeRemount),
  );
  expect(syncButton().hasAttribute("disabled")).toBe(true);
  const readsBeforeFreshClient = get.mock.calls.length;
  cachedMount.unmount();
  mount(createClient());
  await waitFor(() =>
    expect(get.mock.calls.length).toBeGreaterThan(readsBeforeFreshClient),
  );
  fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  expect((await screen.findByRole("tooltip")).textContent).toMatch(
    /手动同步.*同步中/,
  );
  expect(post).not.toHaveBeenCalled();
  expect(
    (get.mock.calls as unknown as [string][]).every(
      ([path]) => path === "/api/source-fetch/progress",
    ),
  ).toBe(true);
});

test.each([true, false])(
  "viewing manual history (present: %s) never creates a run",
  async (hasHistory) => {
    const lastManual = hasHistory
      ? snapshot({
          status: "partial_failed",
          completedAt: "2026-10-27T01:04:00.000Z",
        })
      : null;
    vi.spyOn(client, "GET").mockResolvedValue(
      response({ active: null, lastManual }) as never,
    );
    const post = vi.spyOn(client, "POST");
    mount();
    await waitFor(() =>
      expect(syncButton().hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    if (hasHistory) {
      expect(tooltip.textContent).toMatch(/上次手动同步|最近手动同步/);
      expect(tooltip.textContent).toMatch(/部分失败/);
      expect(tooltip.textContent).toMatch(/3/);
      expect(tooltip.textContent).toMatch(/2/);
      expect(tooltip.textContent).toMatch(/4/);
      expect(tooltip.textContent).toMatch(/2026|10[/-]27/);
      expect(tooltip.textContent).not.toContain(lastManual!.id);
      expect(tooltip.textContent).not.toContain("adapter");
    } else {
      expect(tooltip.textContent).toContain("暂无手动同步记录");
    }
    expect(post).not.toHaveBeenCalled();
  },
);

test("a scheduled active batch blocks enqueue and preserves the last manual result", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    response({
      active: snapshot({ trigger: "scheduled", status: "queued" }),
      lastManual: snapshot({
        id: "previous-manual",
        status: "succeeded",
        completedAt: "2026-10-27T00:02:00.000Z",
      }),
    }) as never,
  );
  const post = vi.spyOn(client, "POST");
  const queryClient = createClient();
  mount(queryClient);
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKey)).toHaveProperty(
      "active.trigger",
      "scheduled",
    ),
  );
  expect(syncButton().hasAttribute("disabled")).toBe(true);
  fireEvent.click(syncButton());
  fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toMatch(/定时|当前同步/);
  expect(tooltip.textContent).toMatch(/上次手动同步|最近手动同步/);
  expect(post).not.toHaveBeenCalled();
});

test("unreadable progress stays disabled and inspection retries GET before permitting a sync", async () => {
  const initial = deferred<ReturnType<typeof response<Progress>>>();
  const get = vi
    .spyOn(client, "GET")
    .mockImplementationOnce(() => initial.promise as never)
    .mockResolvedValue(response({ active: null, lastManual: null }) as never);
  const post = vi.spyOn(client, "POST");
  const queryClient = createClient();
  mount(queryClient);
  expect(syncButton().hasAttribute("disabled")).toBe(true);
  fireEvent.click(syncButton());
  expect(post).not.toHaveBeenCalled();

  await act(async () => {
    initial.resolve({
      data: undefined as never,
      error: { message: "暂时无法读取同步状态" },
      response: new Response(null, { status: 503 }),
    } as never);
  });
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKey)?.status).toBe("error"),
  );
  expect(syncButton().hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(syncButton());
  expect(post).not.toHaveBeenCalled();
  fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  expect(post).not.toHaveBeenCalled();
});

test("same-tick double clicks enqueue once and an active run cannot enqueue again", async () => {
  let progress: Progress = { active: null, lastManual: null };
  vi.spyOn(client, "GET").mockImplementation(
    async () => response(progress) as never,
  );
  const pending = deferred<ReturnType<typeof response<RunSnapshot>>>();
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(() => pending.promise as never);
  const queryClient = createClient();
  mount(queryClient);
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  const button = syncButton();
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith("/api/source-fetch/runs", { body: {} });
  expect(syncButton().hasAttribute("disabled")).toBe(true);
  progress = { active: snapshot({ status: "queued" }), lastManual: null };
  await act(async () => {
    pending.resolve(response(progress.active!));
  });
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKey)).toEqual(progress),
  );
  await waitFor(() =>
    expect(syncButton().querySelector("svg.ui-spin")).toBeTruthy(),
  );
  fireEvent.click(syncButton());
  expect(post).toHaveBeenCalledTimes(1);
  fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  expect((await screen.findByRole("tooltip")).textContent).toMatch(/已排队/);
  expect(screen.queryByText(/同步成功/)).toBeNull();
});

test("polling completion refreshes candidates and invokes onCompleted once", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  focusManager.setFocused(true);
  const active = snapshot();
  let progress: Progress = { active, lastManual: null };
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async () => response(progress) as never);
  const queryClient = createClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const onCompleted = vi.fn();
  mount(queryClient, onCompleted);
  await waitFor(() =>
    expect(syncButton().querySelector("svg.ui-spin")).toBeTruthy(),
  );
  await act(async () => {});
  progress = {
    active: null,
    lastManual: snapshot({
      status: "succeeded",
      completedAt: "2026-10-27T01:05:00.000Z",
    }),
  };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  // React Query batches notifications with a real timeout; flush the rendered
  // transition's passive effect after advancing only the polling interval.
  await act(async () => {});
  expect(get).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  expect(
    invalidate.mock.calls.filter(
      ([filters]) => filters?.queryKey?.[0] === "candidates",
    ),
  ).toHaveLength(1);
  expect(syncButton().hasAttribute("disabled")).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(onCompleted).toHaveBeenCalledTimes(1);
  expect(
    invalidate.mock.calls.filter(
      ([filters]) => filters?.queryKey?.[0] === "candidates",
    ),
  ).toHaveLength(1);
});

test("a run finishing before the first post-enqueue GET still refreshes candidates", async () => {
  let progress: Progress = { active: null, lastManual: null };
  vi.spyOn(client, "GET").mockImplementation(
    async () => response(progress) as never,
  );
  vi.spyOn(client, "POST").mockImplementation(async () => {
    const completed = snapshot({
      status: "succeeded",
      completedAt: "2026-10-27T01:05:00.000Z",
    });
    progress = { active: null, lastManual: completed };
    return response(completed) as never;
  });
  const queryClient = createClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const onCompleted = vi.fn();
  mount(queryClient, onCompleted);
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(syncButton());
  await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  expect(
    invalidate.mock.calls.filter(
      ([filters]) => filters?.queryKey?.[0] === "candidates",
    ),
  ).toHaveLength(1);
  expect(queryClient.getQueryData(queryKey)).toEqual(progress);
});

test("post-enqueue refresh cancels an older status request before reading canonical progress", async () => {
  const oldRead = deferred<ReturnType<typeof response<Progress>>>();
  const active = snapshot({ status: "queued" });
  let reads = 0;
  let oldSignal: AbortSignal | undefined;
  const get = vi.spyOn(client, "GET").mockImplementation(((_path, init) => {
    reads += 1;
    if (reads === 1) {
      return Promise.resolve(response({ active: null, lastManual: null }));
    }
    if (reads === 2) {
      oldSignal = init?.signal ?? undefined;
      return oldRead.promise;
    }
    return Promise.resolve(response({ active, lastManual: null }));
  }) as typeof client.GET);
  vi.spyOn(client, "POST").mockResolvedValue(response(active) as never);
  const queryClient = createClient();
  mount(queryClient);
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  act(() => {
    void queryClient.refetchQueries({ queryKey });
  });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  fireEvent.click(syncButton());
  await waitFor(() => expect(oldSignal?.aborted).toBe(true));
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKey)).toEqual({
      active,
      lastManual: null,
    }),
  );
  await act(async () => {
    oldRead.resolve(response({ active: null, lastManual: null }));
  });
  expect(queryClient.getQueryData(queryKey)).toEqual({
    active,
    lastManual: null,
  });
  expect(syncButton().hasAttribute("disabled")).toBe(true);
});

test("polls active runs at two seconds, pauses in the background and stops on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  focusManager.setFocused(true);
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(
      response({ active: snapshot(), lastManual: null }) as never,
    );
  const mounted = mount();
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(syncButton().querySelector("svg.ui-spin")).toBeTruthy(),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1999);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => {
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => {
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  mounted.unmount();
  const readsAfterUnmount = get.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  expect(get).toHaveBeenCalledTimes(readsAfterUnmount);
  expect(vi.getTimerCount()).toBe(0);
});

test("idle progress polls every fifteen seconds", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  focusManager.setFocused(true);
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(response({ active: null, lastManual: null }) as never);
  mount();
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_999);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(get).toHaveBeenCalledTimes(2);
});

test("status uses the existing sync button hover or focus and never stays pinned by clicking", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    response({
      active: snapshot({
        status: "queued",
        nextRetryAt: "2026-10-27T01:06:00.000Z",
      }),
      lastManual: null,
    }) as never,
  );
  const post = vi.spyOn(client, "POST");
  mount();
  const inspect = inspectTarget();
  expect(screen.queryByRole("button", { name: "查看同步状态" })).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.pointerEnter(inspect, { pointerType: "mouse" });
  await waitFor(() =>
    expect(screen.getByRole("tooltip").textContent).toMatch(/等待重试/),
  );
  fireEvent.pointerLeave(inspect, { pointerType: "mouse" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  fireEvent.focus(inspect);
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  fireEvent.keyDown(inspect, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(inspect);
  fireEvent.pointerEnter(inspect, { pointerType: "mouse" });
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  fireEvent.pointerLeave(inspect, { pointerType: "mouse" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(inspect);
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

test("an enqueue error is shown only in the status popover and does not announce success", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    response({ active: null, lastManual: null }) as never,
  );
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    error: { message: "同步请求暂时不可用" },
    response: new Response(null, { status: 503 }),
  } as never);
  mount();
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(syncButton());
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  if (!screen.queryByRole("tooltip"))
    fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  const tooltip = await screen.findByRole("tooltip");
  await waitFor(() =>
    expect(tooltip.textContent).toContain("同步请求暂时不可用"),
  );
  expect(screen.queryByText(/同步成功/)).toBeNull();
  fireEvent.keyDown(inspectTarget(), { key: "Escape" });
  expect(screen.queryByText("同步请求暂时不可用")).toBeNull();
});

test("a rejected overlapping manual request keeps its reason while canonical progress shows a scheduled run", async () => {
  let progress: Progress = { active: null, lastManual: null };
  vi.spyOn(client, "GET").mockImplementation(
    async () => response(progress) as never,
  );
  const rejection = "当前定时批次的账号范围与手动请求重叠，请等待其完成";
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    progress = {
      active: snapshot({
        id: "unrelated-scheduled-run",
        trigger: "scheduled",
      }),
      lastManual: null,
    };
    return {
      error: { message: rejection },
      response: new Response(null, { status: 409 }),
    } as never;
  });
  const queryClient = createClient();
  const onCompleted = vi.fn();
  mount(queryClient, onCompleted);
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(syncButton());
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKey)).toEqual(progress),
  );
  await waitFor(() =>
    expect(syncButton().querySelector("svg.ui-spin")).toBeTruthy(),
  );
  if (!screen.queryByRole("tooltip"))
    fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  const tooltip = await screen.findByRole("tooltip");
  await waitFor(() => expect(tooltip.textContent).toContain(rejection));
  expect(tooltip.textContent).toContain("定时同步");
  expect(syncButton().hasAttribute("disabled")).toBe(true);
  expect(post).toHaveBeenCalledTimes(1);
  expect(onCompleted).not.toHaveBeenCalled();
});

test("an enqueue error survives an unrelated update to the last manual run", async () => {
  let progress: Progress = {
    active: null,
    lastManual: snapshot({
      id: "earlier-manual-run",
      status: "succeeded",
      completedAt: "2026-10-27T01:03:00.000Z",
    }),
  };
  vi.spyOn(client, "GET").mockImplementation(
    async () => response(progress) as never,
  );
  const rejection = "手动同步请求被拒绝，请稍后重试";
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    progress = {
      active: null,
      lastManual: snapshot({
        id: "another-users-manual-run",
        status: "succeeded",
        completedAt: "2026-10-27T01:05:00.000Z",
      }),
    };
    return {
      error: { message: rejection },
      response: new Response(null, { status: 503 }),
    } as never;
  });
  const queryClient = createClient();
  const onCompleted = vi.fn();
  mount(queryClient, onCompleted);
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(syncButton());
  await waitFor(() =>
    expect(queryClient.getQueryData(queryKey)).toEqual(progress),
  );
  await waitFor(() =>
    expect(syncButton().hasAttribute("disabled")).toBe(false),
  );
  if (!screen.queryByRole("tooltip"))
    fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  const tooltip = await screen.findByRole("tooltip");
  await waitFor(() => expect(tooltip.textContent).toContain(rejection));
  expect(tooltip.textContent).toContain("上次手动同步");
  expect(post).toHaveBeenCalledTimes(1);
  expect(onCompleted).not.toHaveBeenCalled();
});

test("a status popover near a narrow viewport edge stays within its margins", async () => {
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 568);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip"
        ? new DOMRect(0, 0, 288, 170)
        : new DOMRect(180, 520, 124, 32);
    },
  );
  vi.spyOn(client, "GET").mockResolvedValue(
    response({ active: null, lastManual: null }) as never,
  );
  const post = vi.spyOn(client, "POST");
  mount();
  fireEvent.pointerEnter(inspectTarget(), { pointerType: "mouse" });
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.style.left).toBe("16px");
  expect(tooltip.style.top).toBe("342px");
  expect(Number.parseFloat(tooltip.style.left) + 288).toBeLessThanOrEqual(304);
  expect(Number.parseFloat(tooltip.style.top) + 170).toBeLessThanOrEqual(552);
  expect(post).not.toHaveBeenCalled();
});

test("waiting platform summary exposes progress without a request spinner or new badges", async () => {
  const active = snapshot({
    status: "queued",
    targetCount: 2,
    completedTargets: 1,
    waitingTargets: 1,
    waitingReason: "credential_unavailable",
  });
  vi.spyOn(client, "GET").mockResolvedValue(
    response({ active, lastManual: null }) as never,
  );
  mount();
  await waitFor(() => expect(syncButton().hasAttribute("disabled")).toBe(true));
  fireEvent.focus(inspectTarget());
  await screen.findByText(/等待凭据复验/);
  expect(screen.getByText(/账号 1\/2/)).toBeTruthy();
  expect(syncButton().querySelector("svg.ui-spin")).toBeNull();
  expect(document.querySelector(".ui-badge")).toBeNull();
});
