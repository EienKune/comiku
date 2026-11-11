import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import { SourceHistoryTaskDetail } from "./SourceHistoryTaskDetail";

const observedAt = "2026-11-10T12:00:00Z";
const detail: components["schemas"]["SourceTaskDetailDto"] = {
  original: {
    id: "task",
    accountId: "account",
    authorName: "Fixture author",
    platform: "pixiv",
    handle: "fixture",
    externalUserId: "123",
    status: "failed",
    failureCode: "discovery_gaps",
    startedAt: observedAt,
    completedAt: observedAt,
    deferredUntil: null,
    legacy: false,
    pagesFetched: 1,
    candidatesCreated: 2,
    mediaStored: 3,
  },
  current: {
    fetchEnabled: true,
    deletedAt: null,
    adapterHealth: "healthy",
    unresolvedGapCount: 1,
    excludedGapCount: 0,
  },
  job: {
    status: "failed",
    attempts: 3,
    nextAvailableAt: null,
    nextRetryAt: null,
  },
  followupSuccess: null,
  executionHistoryAvailable: true,
  observedAt,
};
const execution: components["schemas"]["SourceExecutionDto"] = {
  id: "execution",
  kind: "scan",
  budgetAttempt: 3,
  budgetRefunded: true,
  admittedAt: observedAt,
  businessOutcome: "failed",
  businessFinishedAt: observedAt,
  settledAt: null,
  diagnostics: {
    samples: [
      {
        stage: "download",
        reason: "media_size_limit",
        scope: "media",
        occurredAt: observedAt,
        httpStatus: 413,
        limitBytes: 104857600,
        observedBytes: 104857601,
        durationMs: 20000,
        timeout: true,
      },
    ],
    omitted: 2,
  },
};
const gap: components["schemas"]["SourceGapDto"] = {
  id: "gap",
  postId: "123456",
  platform: "pixiv",
  state: "media_pending",
  failureCode: "media_network_error",
  attempts: 2,
  nextRetryAt: observedAt,
  createdAt: observedAt,
  updatedAt: observedAt,
  campaign: {
    number: 2,
    state: "running",
    failureCode: null,
    startedAt: observedAt,
    completedAt: null,
  },
};
function setup() {
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options: { params: { query?: { cursor?: string } } },
  ) => ({
    data: path.endsWith("/executions")
      ? {
          items: [execution],
          nextCursor: options.params.query?.cursor ? null : "execution-next",
          observedAt,
          scope: "scan",
          legacy: false,
        }
      : path.endsWith("/gaps")
        ? {
            items: [gap],
            nextCursor: options.params.query?.cursor ? null : "gap-next",
            observedAt,
            scope: "current_account",
            legacy: false,
          }
        : detail,
    response: new Response(),
  })) as never);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SourceHistoryTaskDetail runId="run" taskId="task" enabled />
    </QueryClientProvider>,
  );
  return get;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("scan evidence is read on demand and does not claim an unsettled process has ended", async () => {
  const get = setup();
  fireEvent.click(
    await screen.findByRole("button", { name: "查看本次扫描记录" }),
  );
  expect(await screen.findByText("预算第 3 次（已退还）")).toBeTruthy();
  expect(screen.getByText("执行结束尚未确认")).toBeTruthy();
  expect(screen.getByText(/HTTP 413/)).toBeTruthy();
  expect(screen.getByText(/限制 100 MiB/)).toBeTruthy();
  expect(screen.getByText(/另有 2 条诊断未展示/)).toBeTruthy();
  expect(get.mock.calls.some((call) => String(call[0]).endsWith("/gaps"))).toBe(
    false,
  );
  expect(
    get.mock.calls.find((call) => String(call[0]).endsWith("/executions"))?.[1],
  ).toMatchObject({
    params: { path: { id: "run", taskId: "task" }, query: { limit: 20 } },
    signal: expect.any(AbortSignal),
  });
  fireEvent.click(screen.getByRole("button", { name: "下一页扫描记录" }));
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) =>
          (call[1] as { params: { query?: { cursor?: string } } }).params.query
            ?.cursor === "execution-next",
      ),
    ).toBe(true),
  );
});

test("current gaps keep failed compensation rounds separate from scan budget", async () => {
  const get = setup();
  await screen.findByRole("button", { name: "查看本次扫描记录" });
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "查看当前缺口" }));
  expect(await screen.findByText("帖子 123456")).toBeTruthy();
  expect(screen.getByText("第 2 轮补偿")).toBeTruthy();
  expect(screen.getByText("已失败 2 轮补偿")).toBeTruthy();
  expect(screen.queryByText(/原批已恢复/)).toBeNull();
  expect(
    get.mock.calls.some((call) => String(call[0]).endsWith("/executions")),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "下一页缺口" }));
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) =>
          (call[1] as { params: { query?: { cursor?: string } } }).params.query
            ?.cursor === "gap-next",
      ),
    ).toBe(true),
  );
});
