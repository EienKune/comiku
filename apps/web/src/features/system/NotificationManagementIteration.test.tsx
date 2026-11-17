vi.mock("./use-work-reminder-configuration", () => ({
  useWorkReminderConfiguration: () => ({}),
}));
vi.mock("./WorkReminderPanels", () => ({
  WorkReminderSubscriptions: () => null,
  WorkReminderTemplate: () => null,
}));
vi.mock("../birthdays/BirthdayReminderSettings", () => ({
  BirthdayReminderSettings: () => null,
}));
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
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import { type Template } from "./NotificationTemplateEditor";
import { NotificationManagement } from "./NotificationManagement";
type ReadOptions = {
  signal?: AbortSignal;
  params?: { query?: { cursor?: string } };
};
const requestSignal = (call: unknown) =>
  (call as [string, ReadOptions] | undefined)?.[1]?.signal;
const template: Template = {
  eventType: "imported",
  titleEnabled: false,
  authorEnabled: false,
  actorEnabled: false,
  note: "",
  revision: 0,
  contentRevision: 0,
  referencedGroupCount: 1,
};
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
const events = [{ type: "imported" as const, label: "导入作品" }];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollIntoView)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.useRealTimers();
});
const historyRow = (
  id: string,
  workNumber: number,
): components["schemas"]["NotificationDeliveryDto"] => ({
  id,
  channelId: "channel",
  channelName: "当前群名",
  groupId: "987",
  connectionKey: "bot",
  eventType: "imported",
  resourceKind: "work",
  birthday: null,
  workNumber,
  status: "pending" as const,
  attempts: 0,
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  errorCode: null,
  providerMessageId: null,
  preview: "冻结正文",
  revision: 0,
  resolvedAt: null,
  nextEligibleAt: null,
  metadataOrigin: null,
  contentRevision: 0,
  metadataObservedAt: null,
});
test("history replaces twenty rows, applies filters explicitly, refreshes without losing drafts and ignores cancelled requests", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation(
    async (path: string, options?: ReadOptions) =>
      ({
        data: path.endsWith("configuration")
          ? {
              enabled: true,
              connections: [],
              channels: [],
              templates: [template],
              eventTypes: events,
            }
          : {
              items: Array.from({ length: 20 }, (_, i) =>
                historyRow(
                  `${options?.params?.query && "cursor" in options.params.query && options.params.query.cursor ? "next" : "first"}-${i}`,
                  i +
                    (options?.params?.query &&
                    "cursor" in options.params.query &&
                    options.params.query.cursor
                      ? 101
                      : 1),
                ),
              ),
              nextCursor:
                options?.params?.query &&
                "cursor" in options.params.query &&
                options.params.query.cursor
                  ? null
                  : "next",
            },
        response: new Response(),
      }) as never,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const panel = (enabled: boolean) => (
    <QueryClientProvider client={queryClient}>
      <NotificationManagement enabled={enabled} />
    </QueryClientProvider>
  );
  const view = render(panel(true));
  fireEvent.click(screen.getByRole("tab", { name: "发送记录" }));
  await screen.findByText("#1");
  expect(document.querySelectorAll(".notification-delivery")).toHaveLength(20);
  expect(get).toHaveBeenCalledWith(
    "/api/notifications/deliveries",
    expect.objectContaining({
      params: { query: expect.objectContaining({ limit: 20 }) },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("#101");
  expect(screen.queryByText("#1")).toBeNull();
  expect(document.querySelectorAll(".notification-delivery")).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByText("#1");
  expect(screen.queryByText("#101")).toBeNull();
  const beforeFilter = get.mock.calls.length;
  fireEvent.change(screen.getByLabelText("原目标群号"), {
    target: { value: "987" },
  });
  fireEvent.change(screen.getByLabelText("作品编号"), {
    target: { value: "42" },
  });
  fireEvent.change(screen.getByLabelText("开始日期"), {
    target: { value: "2026-03-08" },
  });
  fireEvent.change(screen.getByLabelText("结束日期"), {
    target: { value: "2026-03-08" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "事件类型" }));
  fireEvent.click(screen.getByRole("option", { name: "通知测试" }));
  fireEvent.click(screen.getByRole("combobox", { name: "投递状态" }));
  fireEvent.click(screen.getByRole("option", { name: "排队中" }));
  expect(get).toHaveBeenCalledTimes(beforeFilter);
  fireEvent.click(screen.getByRole("button", { name: "筛选" }));
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith(
      "/api/notifications/deliveries",
      expect.objectContaining({
        params: {
          query: expect.objectContaining({
            groupId: "987",
            workNumber: 42,
            eventType: "notification.test",
            status: "pending",
            cursor: undefined,
            limit: 20,
            createdFrom: new Date("2026-03-08T00:00:00").toISOString(),
            createdBefore: new Date("2026-03-09T00:00:00").toISOString(),
          }),
        },
      }),
    ),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("#101");
  const beforeDraft = get.mock.calls.length;
  fireEvent.change(screen.getByLabelText("原目标群号"), {
    target: { value: "555" },
  });
  expect(get).toHaveBeenCalledTimes(beforeDraft);
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  await screen.findByText("#1");
  expect(get).toHaveBeenLastCalledWith(
    "/api/notifications/deliveries",
    expect.objectContaining({
      params: {
        query: expect.objectContaining({
          groupId: "987",
          workNumber: 42,
          status: "pending",
          eventType: "notification.test",
          cursor: undefined,
          limit: 20,
        }),
      },
    }),
  );
  expect((screen.getByLabelText("原目标群号") as HTMLInputElement).value).toBe(
    "555",
  );
  expect(
    (screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重置" }));
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith(
      "/api/notifications/deliveries",
      expect.objectContaining({
        params: {
          query: expect.objectContaining({
            groupId: undefined,
            workNumber: undefined,
            eventType: undefined,
            status: undefined,
            cursor: undefined,
            createdFrom: undefined,
            createdBefore: undefined,
          }),
        },
      }),
    ),
  );
  expect((screen.getByLabelText("原目标群号") as HTMLInputElement).value).toBe(
    "",
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "刷新记录" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  let complete!: (value: never) => void;
  get.mockImplementationOnce(
    () =>
      new Promise<never>((resolve) => {
        complete = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  const signal = requestSignal(get.mock.calls.at(-1));
  view.rerender(panel(false));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    complete({
      data: { items: [historyRow("late", 999)], nextCursor: null },
      response: new Response(),
    } as never);
  });
  expect(screen.queryByText("#999")).toBeNull();
});
test("history entered while inactive loads its own catalogue on activation and never relies on opening groups", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation(
    async (path: string) =>
      ({
        data: path.endsWith("configuration")
          ? {
              enabled: true,
              connections: [],
              channels: [],
              templates: [template],
              eventTypes: events,
            }
          : { items: [historyRow("d", 42)], nextCursor: null },
        response: new Response(),
      }) as never,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const panel = (enabled: boolean) => (
    <QueryClientProvider client={queryClient}>
      <NotificationManagement enabled={enabled} />
    </QueryClientProvider>
  );
  const view = render(panel(false));
  fireEvent.click(screen.getByRole("tab", { name: "发送记录" }));
  expect(get).not.toHaveBeenCalled();
  view.rerender(panel(true));
  await screen.findByText("#42");
  expect(
    document.querySelector(".notification-delivery-summary strong")
      ?.textContent,
  ).toBe("导入作品");
  expect(
    get.mock.calls.filter(
      (call) => call[0] === "/api/notifications/configuration",
    ),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("combobox", { name: "事件类型" }));
  expect(screen.getByRole("option", { name: "导入作品" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "通知测试" })).toBeTruthy();
});
