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
import type { components } from "@comiku/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { SourceFetchHistory } from "./SourceFetchHistory";

type Run = components["schemas"]["SourceRunSummaryDto"];
const observedAt = "2026-11-10T12:00:00Z";
const run = (extra: Partial<Run> = {}): Run => ({
  id: "run",
  trigger: "scheduled",
  status: "failed",
  startedAt: observedAt,
  completedAt: observedAt,
  legacy: false,
  targetCount: 345,
  completedTargets: 345,
  succeededTargets: 344,
  failedTargets: 1,
  runningTargets: 0,
  queuedTargets: 0,
  waitingTargets: 0,
  anomalyTargets: 1,
  pagesFetched: 2,
  candidatesCreated: 3,
  mediaStored: 4,
  ...extra,
});
const task: components["schemas"]["SourceTaskRowDto"] = {
  id: "task",
  accountId: "account",
  authorName: "Fixture author",
  platform: "pixiv",
  handle: "fixture",
  externalUserId: "123",
  status: "failed",
  failureCode: "auth_failed",
  startedAt: observedAt,
  completedAt: observedAt,
  deferredUntil: null,
  legacy: false,
  pagesFetched: 2,
  candidatesCreated: 3,
  mediaStored: 4,
};
const detail: components["schemas"]["SourceTaskDetailDto"] = {
  original: task,
  current: {
    fetchEnabled: true,
    deletedAt: null,
    adapterHealth: "healthy",
    unresolvedGapCount: 7,
    excludedGapCount: 2,
  },
  followupSuccess: {
    taskId: "later-task",
    runId: "later-run",
    completedAt: observedAt,
  },
  job: {
    status: "failed",
    attempts: 3,
    nextAvailableAt: null,
    nextRetryAt: null,
  },
  executionHistoryAvailable: false,
  observedAt,
};
function mockHistory(runs = [run()], executions: unknown[] = []) {
  return vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options: {
      params?: { query?: Record<string, unknown>; path?: { id: string } };
    },
  ) => {
    const data = path.endsWith("/executions")
      ? {
          items: executions,
          nextCursor: null,
          observedAt,
          scope: "scan",
          legacy: false,
        }
      : path.endsWith("/{taskId}")
        ? detail
        : path.endsWith("/tasks")
          ? {
              items: [task],
              nextCursor: options.params?.query?.cursor ? null : "tasks-next",
              observedAt,
              legacy: false,
            }
          : path.endsWith("/{id}")
            ? runs.find((item) => item.id === options.params?.path?.id)
            : { items: runs, nextCursor: null, observedAt };
    return { data, response: new Response() };
  }) as never);
}
function mount(enabled = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SourceFetchHistory enabled={enabled} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("failure badge reads only scan diagnostics on demand and exposes concrete protocol facts", async () => {
  const get = mockHistory(
    [run()],
    [
      {
        id: "execution",
        kind: "scan",
        budgetAttempt: 3,
        budgetRefunded: false,
        admittedAt: observedAt,
        businessOutcome: "failed",
        businessFinishedAt: observedAt,
        settledAt: observedAt,
        diagnostics: {
          samples: [
            {
              stage: "fetch_page",
              reason: "invalid_response",
              scope: "protocol",
              occurredAt: observedAt,
              httpStatus: 404,
              exceptionType: "KeyError",
              missingField: "result",
              responseBytes: 0,
              responseFormat: "empty",
              requestOperation: "UserTweets",
              runtimeVersion: "1.32.11",
            },
            {
              stage: "fetch_page",
              reason: "connector_failed",
              scope: "protocol",
              occurredAt: observedAt,
              exceptionType: "HttpError",
              transportError: "tls_unexpected_eof",
              responseFormat: "html",
            },
          ],
          omitted: 0,
        },
      },
    ],
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /查看批次详情/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "查看错误详情 Fixture author" }),
  );
  expect(await screen.findByText("HTTP 404")).toBeTruthy();
  expect(screen.getByText("响应缺少 result 字段（KeyError）")).toBeTruthy();
  expect(screen.getByText("返回 0 字节 · 空响应")).toBeTruthy();
  expect(screen.getByText("请求 UserTweets")).toBeTruthy();
  expect(screen.getByText("TLS 连接提前关闭（EOF）")).toBeTruthy();
  expect(screen.getByText("响应格式 HTML")).toBeTruthy();
  expect(
    get.mock.calls.some((call) => String(call[0]).endsWith("/{taskId}")),
  ).toBe(false);
  expect(
    get.mock.calls.filter((call) => String(call[0]).endsWith("/executions")),
  ).toHaveLength(1);
});

test("old failures explicitly report missing diagnostics instead of inventing a cause", async () => {
  mockHistory();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /查看批次详情/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "查看错误详情 Fixture author" }),
  );
  expect(
    await screen.findByText("该批未保留详细诊断，只有历史结果摘要。"),
  ).toBeTruthy();
});

test("entry reads ten summaries and loads one server-filtered account page only on opening", async () => {
  const get = mockHistory();
  mount();
  const button = await screen.findByRole("button", { name: /查看批次详情/ });
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]?.[1]).toMatchObject({
    params: { query: { limit: 10 } },
    signal: expect.any(AbortSignal),
  });
  expect(screen.queryByText("Fixture author")).toBeNull();
  fireEvent.click(button);
  expect(await screen.findByText("Fixture author")).toBeTruthy();
  expect(
    get.mock.calls.find((call) => String(call[0]).endsWith("/tasks"))?.[1],
  ).toMatchObject({
    params: { path: { id: "run" }, query: { limit: 20, status: "anomalies" } },
  });
  expect(screen.getByText("认证失败")).toBeTruthy();
  expect(screen.queryByText(/尝试.*次/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一页账号" }));
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) =>
          (call[1] as { params?: { query?: { cursor?: string } } })?.params
            ?.query?.cursor === "tasks-next",
      ),
    ).toBe(true),
  );
});

test("single-account facts separate the original failure, later success, and current account-wide gaps", async () => {
  const get = mockHistory();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /查看批次详情/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "查看账号详情 Fixture author" }),
  );
  expect(await screen.findByText("后续同步成功")).toBeTruthy();
  expect(screen.getByText(/当前仍有 7 条缺口/)).toBeTruthy();
  expect(screen.getByText(/不限定于本批/)).toBeTruthy();
  expect(screen.getByText("该时段仅保留结果摘要")).toBeTruthy();
  expect(screen.queryByText(/原批已恢复/)).toBeNull();
  expect(
    get.mock.calls.filter((call) => String(call[0]).endsWith("/{taskId}")),
  ).toHaveLength(1);
});

test("opening another run closes the previous account panel and success defaults to all", async () => {
  const get = mockHistory([
    run(),
    run({
      id: "success",
      status: "succeeded",
      startedAt: "2026-11-09T12:00:00Z",
    }),
  ]);
  mount();
  const buttons = await screen.findAllByRole("button", {
    name: /查看批次详情/,
  });
  fireEvent.click(buttons[0]!);
  await screen.findByText("Fixture author");
  fireEvent.click(buttons[1]!);
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) =>
          String(call[0]).endsWith("/tasks") &&
          (
            call[1] as {
              params: { path: { id: string }; query: { status: string } };
            }
          ).params.path.id === "success" &&
          (call[1] as { params: { query: { status: string } } }).params.query
            .status === "all",
      ),
    ).toBe(true),
  );
  expect(
    screen
      .getAllByRole("button", { name: /查看批次详情/ })
      .filter((button) => button.getAttribute("aria-expanded") === "true"),
  ).toHaveLength(1);
});

test("search waits for debounce and consumes cancellation when replaced", async () => {
  const get = mockHistory();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /查看批次详情/ }));
  await screen.findByText("Fixture author");
  let releaseFirst: ((value: unknown) => void) | undefined;
  get.mockImplementationOnce(
    (() =>
      new Promise((resolve) => {
        releaseFirst = resolve;
      })) as never,
  );
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索作者或账号" }), {
    target: { value: "first" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(299);
  });
  expect(
    get.mock.calls.some(
      (call) =>
        (call[1] as { params?: { query?: { search?: string } } })?.params?.query
          ?.search === "first",
    ),
  ).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const searchCall = get.mock.calls.find(
    (call) =>
      (call[1] as { params?: { query?: { search?: string } } })?.params?.query
        ?.search === "first",
  );
  expect(searchCall?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  fireEvent.change(screen.getByRole("textbox", { name: "搜索作者或账号" }), {
    target: { value: "second" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301);
  });
  expect(
    (searchCall?.[1] as unknown as { signal: AbortSignal }).signal.aborted,
  ).toBe(true);
  await act(async () => {
    releaseFirst?.({
      data: {
        items: [{ ...task, authorName: "Late first result" }],
        nextCursor: null,
        observedAt,
        legacy: false,
      },
      response: new Response(),
    });
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.queryByText("Late first result")).toBeNull();
  expect(screen.getByText("Fixture author")).toBeTruthy();
});

test("only active summaries poll; terminal account pages stay fixed and hidden panels stop", async () => {
  vi.useFakeTimers();
  const get = mockHistory([
    run({ status: "running", completedAt: null, completedTargets: 1 }),
  ]);
  const view = mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  fireEvent.click(screen.getByRole("button", { name: /查看批次详情/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(
    get.mock.calls.find((call) => String(call[0]).endsWith("/tasks"))?.[1],
  ).toMatchObject({ params: { query: { status: "active" } } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(
    get.mock.calls.filter((call) => String(call[0]).endsWith("/{id}")),
  ).toHaveLength(1);
  expect(
    get.mock.calls.filter((call) => call[0] === "/api/source-fetch/runs"),
  ).toHaveLength(1);
  expect(
    get.mock.calls.filter((call) => String(call[0]).endsWith("/tasks")),
  ).toHaveLength(1);
  const count = get.mock.calls.length;
  view.rerender(
    <QueryClientProvider client={view.queryClient}>
      <SourceFetchHistory enabled={false} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(get.mock.calls).toHaveLength(count);
});

test("a terminal summary update retains the chosen account filter and page", async () => {
  vi.useFakeTimers();
  const get = mockHistory([run({ status: "running", completedAt: null })]);
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  fireEvent.click(screen.getByRole("button", { name: /查看批次详情/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  fireEvent.click(screen.getByRole("combobox", { name: "账号状态" }));
  fireEvent.click(screen.getByRole("option", { name: "本批异常" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  fireEvent.click(screen.getByRole("button", { name: "下一页账号" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const taskCalls = get.mock.calls.filter((call) =>
    String(call[0]).endsWith("/tasks"),
  ).length;
  get.mockResolvedValueOnce({
    data: run({ status: "succeeded" }),
    response: new Response(),
  } as never);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(
    screen.getByRole("combobox", { name: "账号状态" }).textContent,
  ).toContain("本批异常");
  expect(screen.getByRole("button", { name: "上一页账号" })).toBeTruthy();
  expect(
    get.mock.calls.filter((call) => String(call[0]).endsWith("/tasks")),
  ).toHaveLength(taskCalls);
  const summaries = get.mock.calls.filter((call) =>
    String(call[0]).endsWith("/{id}"),
  ).length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(
    get.mock.calls.filter((call) => String(call[0]).endsWith("/{id}")),
  ).toHaveLength(summaries);
});

test("legacy account summaries and read failures stay explicit without fabricated retries", async () => {
  const get = mockHistory([run({ legacy: true })]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /查看批次详情/ }));
  expect(await screen.findByText(/仅保留旧版结果摘要/)).toBeTruthy();
  await screen.findByText("Fixture author");
  get.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "刷新账号" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "账号记录读取失败，请刷新账号重试。",
  );
  fireEvent.click(screen.getByRole("button", { name: "刷新账号" }));
  expect(await screen.findByText("Fixture author")).toBeTruthy();
});

test("refreshing accounts resets the cursor chain with one bounded read", async () => {
  const get = mockHistory();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /查看批次详情/ }));
  await screen.findByText("Fixture author");
  fireEvent.click(screen.getByRole("button", { name: "下一页账号" }));
  await screen.findByRole("button", { name: "上一页账号" });
  const before = get.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "刷新账号" }));
  await screen.findByRole("button", { name: "下一页账号" });
  expect(screen.queryByRole("button", { name: "上一页账号" })).toBeNull();
  expect(get.mock.calls).toHaveLength(before + 1);
  expect(get.mock.calls.at(-1)?.[1]).toMatchObject({
    params: { query: { cursor: undefined, limit: 20 } },
  });
});

test("a background browser tab neither starts reads nor keeps active-summary polling", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const get = mockHistory([run({ status: "queued" })]);
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(get).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_001);
  });
  expect(
    get.mock.calls.filter((call) => String(call[0]).endsWith("/{id}")),
  ).toHaveLength(1);
  const count = get.mock.calls.length;
  visibility.mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(get.mock.calls).toHaveLength(count);
});

test("completed scanning with known media gaps does not present the account as complete", async () => {
  const get = mockHistory([run({ status: "succeeded" })]);
  mount();
  const button = await screen.findByRole("button", { name: /查看批次详情/ });
  get.mockResolvedValueOnce({
    data: {
      items: [{ ...task, status: "succeeded", failureCode: "discovery_gaps" }],
      nextCursor: null,
      observedAt,
      legacy: false,
    },
    response: new Response(),
  } as never);
  fireEvent.click(button);
  const row = (await screen.findByText("Fixture author")).closest("article")!;
  expect(within(row).queryByText("完成")).toBeNull();
  expect(within(row).getByText("媒体有缺口")).toBeTruthy();
});
