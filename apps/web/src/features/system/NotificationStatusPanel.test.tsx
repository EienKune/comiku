// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { NotificationStatusPanel } from "./NotificationStatusPanel";

const metric = { count: 0, capped: false, oldestAt: null };
const status = {
  enabled: true,
  state: "healthy",
  sourceSince: null,
  expandedSourceSince: null,
  lastMaintenanceAt: "2026-11-10T00:00:00Z",
  lastCaptureAt: null,
  lastRegistrationAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  deliveries: {
    pending: metric,
    retryWait: metric,
    sending: metric,
    failedUnresolved: metric,
    unknownUnresolved: metric,
  },
  counts: {
    uncaptured: null,
    pending: metric,
    retryWait: { ...metric, count: 1000, capped: true },
    invalid: metric,
  },
};
const receipt = {
  id: "r1",
  sourceEventId: "e1",
  resourceId: "work-1",
  workNumber: 42,
  eventType: "imported",
  eventLabel: "导入作品",
  status: "retry_wait",
  attempts: 2,
  errorCode: "registration_temporarily_unavailable",
  nextAttemptAt: "2026-11-10T01:00:00Z",
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  notificationEventId: null,
};
function setup(active = true, snapshot = status) {
  const get = vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data: String(path).endsWith("/status")
          ? snapshot
          : { items: [receipt], nextCursor: null },
        response: new Response(),
      }) as never,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const component = (enabled: boolean) => (
    <QueryClientProvider client={queryClient}>
      <NotificationStatusPanel enabled={enabled} />
    </QueryClientProvider>
  );
  const view = render(component(active));
  return {
    get,
    queryClient,
    setActive: (enabled: boolean) => view.rerender(component(enabled)),
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("shows maintenance evidence, bounded metrics and safe linked receipts", async () => {
  setup();
  await screen.findByText("维护正常");
  expect(screen.getByText("1000+")).toBeTruthy();
  expect(screen.getByText("未捕获").closest("div")?.textContent).toContain("—");
  expect(screen.getByRole("link", { name: "#42" }).getAttribute("href")).toBe(
    "/works/work-1",
  );
  expect(screen.getByText("登记暂时不可用")).toBeTruthy();
  expect(screen.getByText("导入作品")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /重放|重置|补发/ })).toBeNull();
});

test("filters and pages receipts using the selected state and server cursor", async () => {
  const { get } = setup();
  await screen.findByText("导入作品");
  get.mockImplementation(async (path, options: unknown) => {
    const cursor = (options as { params?: { query?: { cursor?: string } } })
      ?.params?.query?.cursor;
    return {
      data: String(path).endsWith("/status")
        ? status
        : {
            items: [
              {
                ...receipt,
                id: cursor ? "r3" : "r2",
                workNumber: cursor ? 44 : 43,
                status: "invalid",
              },
            ],
            nextCursor: cursor ? null : "page-2",
          },
      response: new Response(),
    } as never;
  });
  fireEvent.click(screen.getByRole("combobox", { name: "登记状态" }));
  fireEvent.click(screen.getByRole("option", { name: "已隔离" }));
  await screen.findByRole("link", { name: "#43" });
  expect(screen.queryByRole("link", { name: "#42" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "加载更多登记记录" }));
  await screen.findByRole("link", { name: "#44" });
  expect(get).toHaveBeenLastCalledWith(
    "/api/notifications/receipts",
    expect.objectContaining({
      params: { query: { status: "invalid", limit: 20, cursor: "page-2" } },
    }),
  );
});

test("failed refresh preserves evidence and offers retry without displaying raw errors", async () => {
  const { get } = setup();
  await screen.findByText("维护正常");
  get.mockRejectedValue(new Error("secret debug material"));
  fireEvent.click(screen.getByRole("button", { name: "刷新运行状态" }));
  await screen.findByText("运行状态读取失败，请刷新重试。");
  expect(screen.getByText("维护正常")).toBeTruthy();
  expect(screen.queryByText(/secret debug/)).toBeNull();
  get.mockImplementation(
    async (path) =>
      ({
        data: String(path).endsWith("/status")
          ? status
          : { items: [], nextCursor: null },
        response: new Response(),
      }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "刷新运行状态" }));
  await screen.findByText("暂无等待重试的登记记录。");
});

test("inactive reads and invalidations are gated; late results do not restart hidden polling", async () => {
  const { get, queryClient, setActive } = setup(false);
  expect(get).not.toHaveBeenCalled();
  let complete!: (value: never) => void;
  get.mockImplementation((path) =>
    String(path).endsWith("/status")
      ? new Promise<never>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve({
          data: { items: [], nextCursor: null },
          response: new Response(),
        } as never),
  );
  setActive(true);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  setActive(false);
  vi.useFakeTimers();
  await act(async () => {
    complete({ data: status, response: new Response() } as never);
    await vi.advanceTimersByTimeAsync(1);
  });
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["notification-status"] });
    await queryClient.invalidateQueries({
      queryKey: ["notification-receipts"],
    });
    await vi.advanceTimersByTimeAsync(45000);
  });
  expect(get).toHaveBeenCalledTimes(2);
});

test("global disable stops polling while retaining explicit refresh", async () => {
  vi.useFakeTimers();
  const { get } = setup(true, { ...status, enabled: false, state: "disabled" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText("通知已关闭")).toBeTruthy();
  const initial = get.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45000);
  });
  expect(get).toHaveBeenCalledTimes(initial);
  fireEvent.click(screen.getByRole("button", { name: "刷新运行状态" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(get.mock.calls.length).toBeGreaterThan(initial);
});

test("visible enabled polling stops on deactivation and resumes with the same filter", async () => {
  vi.useFakeTimers();
  const { get, setActive } = setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText("维护正常")).toBeTruthy();
  const initial = get.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(get.mock.calls.length).toBeGreaterThan(initial);
  expect(
    get.mock.calls.filter((call) => call[0] === "/api/notifications/receipts"),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("combobox", { name: "登记状态" }));
  fireEvent.click(screen.getByRole("option", { name: "已隔离" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  setActive(false);
  const hiddenReads = get.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45000);
  });
  expect(get.mock.calls.length).toBe(hiddenReads);
  expect(screen.getByRole("link", { name: "#42" })).toBeTruthy();
  setActive(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(get.mock.calls.length).toBeGreaterThan(hiddenReads);
  expect(screen.getByRole("combobox", { name: "登记状态" }).textContent).toBe(
    "已隔离",
  );
});

test.each([
  ["not_started", "尚未开始维护"],
  ["stale", "维护记录已过期"],
  ["error", "最近维护失败"],
])("renders controlled worker state %s", async (state, label) => {
  setup(true, { ...status, state });
  await screen.findByText(label);
  expect(screen.queryByText(/机器人离线|机器人在线/)).toBeNull();
});

test("shows bounded outgoing metrics separately from source counts without the retired defensive sentence", async () => {
  setup(true, {
    ...status,
    deliveries: {
      pending: { ...metric, count: 12 },
      retryWait: metric,
      sending: metric,
      failedUnresolved: { ...metric, count: 1000, capped: true },
      unknownUnresolved: metric,
    },
  });
  await screen.findByText("维护正常");
  expect(screen.getByRole("heading", { name: "外发队列" })).toBeTruthy();
  expect(screen.getByText("12")).toBeTruthy();
  expect(screen.getByText("未核对失败")).toBeTruthy();
  expect(screen.queryByText("维护记录不代表 QQ 在线或消息已送达。")).toBeNull();
});
