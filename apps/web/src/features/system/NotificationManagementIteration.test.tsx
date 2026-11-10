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
import { TemplateEditor, type Template } from "./NotificationTemplateEditor";
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
const ok = (text: string) =>
  ({ data: { text }, response: new Response() }) as never;
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
test("template uses a modal, automatically previews, closes without losing draft and explicitly discards", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue(ok("自动正文"));
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  render(
    <TemplateEditor
      templates={[template]}
      events={events}
      onUpdated={() => {}}
    />,
  );
  const opener = screen.getByRole("button", { name: "编辑模板 导入作品" });
  opener.focus();
  fireEvent.click(opener);
  expect(screen.getByRole("dialog", { name: "导入作品模板" })).toBeTruthy();
  await screen.findByText("自动正文");
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "保留我" },
  });
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("");
  fireEvent.click(opener);
  expect((screen.getByLabelText("事件提示语") as HTMLInputElement).value).toBe(
    "保留我",
  );
  fireEvent.click(screen.getByRole("button", { name: "放弃草稿" }));
  fireEvent.click(opener);
  expect((screen.getByLabelText("事件提示语") as HTMLInputElement).value).toBe(
    "",
  );
  expect(
    post.mock.calls.every((call) => call[0] === "/api/notifications/preview"),
  ).toBe(true);
});
test("preview debounces notes and rejects stale errors/finally after edit and hiding", async () => {
  let rejectFirst!: (reason: Error) => void;
  const post = vi
    .spyOn(client, "POST")
    .mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectFirst = reject;
        }),
    )
    .mockResolvedValue(ok("最新正文"));
  const component = (enabled: boolean) => (
    <TemplateEditor
      enabled={enabled}
      templates={[template]}
      events={events}
      onUpdated={() => {}}
    />
  );
  const view = render(component(true));
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 导入作品" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const firstSignal = requestSignal(post.mock.calls[0]);
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "新备注" },
  });
  expect(firstSignal?.aborted).toBe(true);
  await act(async () => {
    rejectFirst(new Error("过时错误"));
  });
  expect(screen.queryByText("过时错误")).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
  await screen.findByText("最新正文");
  expect(post).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "不应请求" },
  });
  view.rerender(component(false));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(post).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("history fetches twenty rows, applies filters explicitly and replaces pages with a back stack", async () => {
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
              items: [],
              nextCursor:
                options?.params?.query &&
                "cursor" in options.params.query &&
                options.params.query.cursor
                  ? null
                  : "second",
            },
        response: new Response(),
      }) as never,
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationManagement />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      "/api/notifications/deliveries",
      expect.objectContaining({
        params: { query: expect.objectContaining({ limit: 20 }) },
      }),
    ),
  );
  const before = get.mock.calls.length;
  fireEvent.change(screen.getByLabelText("原目标群号"), {
    target: { value: "987" },
  });
  expect(get).toHaveBeenCalledTimes(before);
  fireEvent.click(screen.getByRole("button", { name: "筛选" }));
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith(
      "/api/notifications/deliveries",
      expect.objectContaining({
        params: {
          query: expect.objectContaining({
            groupId: "987",
            cursor: undefined,
            limit: 20,
          }),
        },
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith(
      "/api/notifications/deliveries",
      expect.objectContaining({
        params: { query: expect.objectContaining({ cursor: "second" }) },
      }),
    ),
  );
  fireEvent.change(screen.getByLabelText("原目标群号"), {
    target: { value: "555" },
  });
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith(
      "/api/notifications/deliveries",
      expect.objectContaining({
        params: {
          query: expect.objectContaining({ cursor: undefined, groupId: "987" }),
        },
      }),
    ),
  );
  expect(
    (screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
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
test("history replaces twenty rows, back navigates, combines all filters, resets and ignores cancelled requests", async () => {
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
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
  await screen.findByText("#1");
  expect(document.querySelectorAll(".notification-delivery")).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("#101");
  expect(screen.queryByText("#1")).toBeNull();
  expect(document.querySelectorAll(".notification-delivery")).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByText("#1");
  expect(screen.queryByText("#101")).toBeNull();
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
            createdFrom: new Date("2026-03-08T00:00:00").toISOString(),
            createdBefore: new Date("2026-03-09T00:00:00").toISOString(),
          }),
        },
      }),
    ),
  );
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
test.each(["success", "error"] as const)(
  "closed preview ignores a late %s and keeps the newer request pending",
  async (outcome) => {
    vi.useFakeTimers();
    let complete!: (value: never) => void;
    let reject!: (error: Error) => void;
    const post = vi
      .spyOn(client, "POST")
      .mockImplementationOnce(
        () =>
          new Promise<never>((resolve, fail) => {
            complete = resolve;
            reject = fail;
          }),
      )
      .mockReturnValue(new Promise<never>(() => {}));
    render(
      <TemplateEditor
        templates={[template]}
        events={events}
        onUpdated={() => {}}
      />,
    );
    const opener = screen.getByRole("button", { name: "编辑模板 导入作品" });
    fireEvent.click(opener);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const signal = requestSignal(post.mock.calls[0]);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(signal?.aborted).toBe(true);
    fireEvent.click(opener);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("正在预览…")).toBeTruthy();
    await act(async () => {
      if (outcome === "success") complete(ok("过时正文"));
      else reject(new Error("过时错误"));
    });
    expect(screen.queryByText(/过时正文|过时错误/)).toBeNull();
    expect(screen.getByText("正在预览…")).toBeTruthy();
  },
);
test("note edits use 300ms debounce; document hiding aborts requests and resuming previews the current draft", async () => {
  vi.useFakeTimers();
  const post = vi
    .spyOn(client, "POST")
    .mockReturnValue(new Promise<never>(() => {}));
  render(
    <TemplateEditor
      templates={[template]}
      events={events}
      onUpdated={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 导入作品" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(post).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "first" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "second" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(299);
  });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(post).toHaveBeenCalledTimes(2);
  const signal = requestSignal(post.mock.calls.at(-1));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(post).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(false);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(post).toHaveBeenCalledTimes(3);
  expect(post).toHaveBeenLastCalledWith(
    "/api/notifications/preview",
    expect.objectContaining({
      body: expect.objectContaining({
        template: expect.objectContaining({ note: "second" }),
      }),
    }),
  );
});
test("template name search is local and Escape preserves separate event drafts with wrapped keyboard focus", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue(ok("正文"));
  render(
    <TemplateEditor
      templates={[template, { ...template, eventType: "stage_submitted" }]}
      events={[...events, { type: "stage_submitted", label: "阶段提交" }]}
      onUpdated={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("搜索事件名称"), {
    target: { value: "阶段" },
  });
  expect(
    screen.queryByRole("button", { name: "编辑模板 导入作品" }),
  ).toBeNull();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 阶段提交" }));
  const heading = screen.getByRole("heading", { name: "阶段提交模板" });
  fireEvent.keyDown(heading, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "比较当前版本" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "关闭" }),
  );
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "阶段草稿" },
  });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.change(screen.getByLabelText("搜索事件名称"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 导入作品" }));
  expect((screen.getByLabelText("事件提示语") as HTMLInputElement).value).toBe(
    "",
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 阶段提交" }));
  expect((screen.getByLabelText("事件提示语") as HTMLInputElement).value).toBe(
    "阶段草稿",
  );
});

test("choosing the current sample values retains an already current automatic preview", async () => {
  vi.spyOn(client, "POST").mockResolvedValue(ok("当前正文"));
  render(
    <TemplateEditor
      templates={[template]}
      events={events}
      onUpdated={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 导入作品" }));
  await screen.findByText("当前正文");
  fireEvent.click(screen.getByRole("combobox", { name: "样例资料" }));
  fireEvent.click(screen.getByRole("option", { name: "完整资料" }));
  expect(screen.getByText("当前正文")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
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

test.each([
  ["样例资料", false],
  ["样例职责", false],
  ["样例资料", true],
] as const)(
  "Escape closes expanded %s before the template modal (option focus=%s)",
  async (label, optionFocus) => {
    vi.spyOn(client, "POST").mockResolvedValue(ok("正文"));
    render(
      <TemplateEditor
        templates={[{ ...template, eventType: "stage_submitted" }]}
        events={[
          {
            type: "stage_submitted",
            label: "阶段提交",
            supportsStages: true,
            allowedStages: ["translate", "proofread"],
          },
        ]}
        onUpdated={() => {}}
      />,
    );
    const opener = screen.getByRole("button", { name: "编辑模板 阶段提交" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.change(screen.getByLabelText("事件提示语"), {
      target: { value: "Esc后保留的草稿" },
    });
    const selector = screen.getByRole("combobox", { name: label });
    selector.focus();
    fireEvent.click(selector);
    const target = optionFocus ? screen.getAllByRole("option")[0] : selector;
    target.focus();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(target, escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "阶段提交模板" })).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(selector);
    expect(
      (screen.getByLabelText("事件提示语") as HTMLInputElement).value,
    ).toBe("Esc后保留的草稿");
    fireEvent.keyDown(selector, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    expect(
      (screen.getByLabelText("事件提示语") as HTMLInputElement).value,
    ).toBe("Esc后保留的草稿");
  },
);
