// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { NotificationManagement } from "./NotificationManagement";

const channel = {
  id: "c1",
  name: "合成群",
  groupId: "123",
  connectionKey: "bot",
  enabled: true,
  eventTypes: ["imported"],
  includeDetails: false,
  revision: 3,
  audienceGeneration: 1,
};
const delivery = {
  id: "d1",
  channelId: "c1",
  channelName: "合成群",
  eventType: "imported",
  workNumber: 1,
  status: "unknown",
  attempts: 1,
  createdAt: "2026-11-06T00:00:00Z",
  updatedAt: "2026-11-06T00:00:00Z",
  errorCode: "receipt_missing",
  providerMessageId: null,
  preview: "合成通知",
  revision: 2,
  resolvedAt: null,
};
function setup(enabled = true, available = true) {
  const get = vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data:
          path === "/api/notifications/configuration"
            ? {
                enabled,
                configurationError: null,
                connections: [
                  {
                    key: "bot",
                    name: "测试连接",
                    adapter: "onebot_v11",
                    available,
                  },
                ],
                eventTypes: [{ type: "imported", label: "导入作品" }],
                channels: [channel],
              }
            : { items: [delivery], nextCursor: null },
        response: new Response(),
      }) as never,
  );
  const post = vi
    .spyOn(client, "POST")
    .mockResolvedValue({ data: delivery, response: new Response() } as never);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NotificationManagement />
    </QueryClientProvider>,
  );
  return { get, post };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each([true, false])(
  "a pending create prevents editor switches and restores editing after %s",
  async (succeeds) => {
    const { post } = setup();
    let complete!: (value: never) => void;
    let fail!: (reason: Error) => void;
    const pending = new Promise<never>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    post.mockReturnValueOnce(pending);
    const edit = await screen.findByRole("button", { name: "编辑 合成群" });
    const add = screen.getByRole("button", { name: "新增群目标" });
    fireEvent.click(add);
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "新增草稿 A" },
    });
    fireEvent.change(screen.getByLabelText("群号"), {
      target: { value: "456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(edit);
    fireEvent.click(add);
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "新增草稿 A",
    );
    await act(async () => {
      if (succeeds)
        complete({ data: channel, response: new Response() } as never);
      else fail(new Error("A 保存失败"));
    });
    await screen.findByText(succeeds ? "配置已保存" : "A 保存失败");
    expect((edit as HTMLButtonElement).disabled).toBe(false);
    expect((add as HTMLButtonElement).disabled).toBe(false);
    if (!succeeds)
      expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
        "新增草稿 A",
      );
    fireEvent.click(edit);
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "合成群",
    );
    expect(screen.queryByText("A 保存失败")).toBeNull();
  },
);

test("loads read-only configuration and maintains disabled channels without sending", async () => {
  const { post } = setup(false);
  expect(await screen.findByText("通知服务已关闭")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑 合成群" }));
  expect((screen.getByLabelText("群号") as HTMLInputElement).value).toBe("123");
  expect(post).not.toHaveBeenCalled();
});

test("shows unavailable connection and keeps edit accessible while disabling test", async () => {
  setup(true, false);
  expect(await screen.findByText("测试连接（不可用）")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "发送测试" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "编辑 合成群" }));
  expect((screen.getByLabelText("群号") as HTMLInputElement).value).toBe("123");
});

test("preserves draft and reports CAS conflicts when saving without sending", async () => {
  const { post } = setup();
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    error: { message: "conflict" },
    response: new Response(null, { status: 409 }),
  } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "我的草稿" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText(/配置已被其他管理员修改/)).toBeTruthy();
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "我的草稿",
  );
  expect(patch).toHaveBeenCalledWith(
    "/api/notifications/channels/{id}",
    expect.objectContaining({
      body: expect.objectContaining({ expectedRevision: 3, name: "我的草稿" }),
    }),
  );
  expect(post).not.toHaveBeenCalled();
});

test("requires duplicate confirmation and reuses idempotency key after uncertain retry", async () => {
  const { post } = setup();
  post.mockRejectedValueOnce(new TypeError("network"));
  await screen.findByText("结果未知");
  const retry = screen.getByRole("button", {
    name: "补发",
  }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("我已核对，确认补发可能重复"));
  fireEvent.click(retry);
  await screen.findByRole("alert");
  fireEvent.click(retry);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  const first = post.mock.calls[0][1] as {
    body: { idempotencyKey: string; confirmPossibleDuplicate: boolean };
  };
  const second = post.mock.calls[1][1] as { body: { idempotencyKey: string } };
  expect(first.body.confirmPossibleDuplicate).toBe(true);
  expect(first.body.idempotencyKey).toBe(second.body.idempotencyKey);
});

test("previews synthetic content only on explicit action and invalidates stale content", async () => {
  const { post } = setup();
  post.mockResolvedValue({
    data: { text: "合成预览正文" },
    response: new Response(),
  } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.click(screen.getByLabelText("包含作者、标题和操作昵称"));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
  expect(await screen.findByText("合成预览正文")).toBeTruthy();
  expect(post).toHaveBeenCalledWith("/api/notifications/preview", {
    body: { eventType: "imported", includeDetails: true },
  });
  fireEvent.click(screen.getByLabelText("包含作者、标题和操作昵称"));
  expect(screen.queryByText("合成预览正文")).toBeNull();
});

test("explicit test queues with a stable retry key and says queued instead of read", async () => {
  const { post } = setup();
  post.mockRejectedValueOnce(new TypeError("network"));
  fireEvent.click(await screen.findByRole("button", { name: "发送测试" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "发送测试" }));
  expect(
    await screen.findByText("测试已排队，请刷新投递记录查看结果。"),
  ).toBeTruthy();
  const first = post.mock.calls[0][1] as { body: { idempotencyKey: string } };
  const second = post.mock.calls[1][1] as { body: { idempotencyKey: string } };
  expect(first.body.idempotencyKey).toBe(second.body.idempotencyKey);
  expect(screen.queryByText("已读")).toBeNull();
});

test("shows configuration summary without claiming QQ online and labels delivery events", async () => {
  setup();
  expect(await screen.findByRole("heading", { name: "连接配置" })).toBeTruthy();
  expect(screen.getByText("配置可用")).toBeTruthy();
  expect(screen.queryByText(/在线/)).toBeNull();
  expect(screen.getByRole("heading", { name: "群订阅" })).toBeTruthy();
  expect(await screen.findByText("导入作品")).toBeTruthy();
  expect(screen.getByText(/核心作品事件/)).toBeTruthy();
  expect(screen.queryByText(/尚未接入/)).toBeNull();
});

test("an inactive notification panel issues no reads", async () => {
  const get = vi.spyOn(client, "GET");
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationManagement enabled={false} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  expect(get).not.toHaveBeenCalled();
});

test("cached inactive notification queries ignore invalidation and resume when activated", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
  ) => ({
    data: path.endsWith("configuration")
      ? {
          enabled: false,
          configurationError: null,
          connections: [],
          eventTypes: [],
          channels: [],
        }
      : { items: [], nextCursor: null },
    response: new Response(),
  })) as never);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const panel = (enabled: boolean) => (
    <QueryClientProvider client={queryClient}>
      <NotificationManagement enabled={enabled} />
    </QueryClientProvider>
  );
  const view = render(panel(true));
  await screen.findByText("暂无投递记录。");
  expect(get).toHaveBeenCalledTimes(2);
  view.rerender(panel(false));
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  expect(get).toHaveBeenCalledTimes(2);
  view.rerender(panel(true));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
});

test("new group starts disabled with no subscriptions and saves only real content settings", async () => {
  const { post } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "新增群目标" }));
  expect(
    (screen.getByLabelText("启用此群通知") as HTMLInputElement).checked,
  ).toBe(false);
  expect((screen.getByLabelText("导入作品") as HTMLInputElement).checked).toBe(
    false,
  );
  expect(screen.getByRole("heading", { name: "消息内容" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: /模板/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "新群" },
  });
  fireEvent.change(screen.getByLabelText("群号"), { target: { value: "456" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("配置已保存");
  expect(post).toHaveBeenCalledWith("/api/notifications/channels", {
    body: {
      name: "新群",
      groupId: "456",
      connectionKey: "bot",
      enabled: false,
      eventTypes: [],
      includeDetails: false,
    },
  });
});

test("a save completed after deactivation does not refetch hidden configuration", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
  ) => ({
    data: path.endsWith("configuration")
      ? {
          enabled: false,
          configurationError: null,
          connections: [{ key: "bot", name: "测试连接", available: true }],
          eventTypes: [],
          channels: [],
        }
      : { items: [], nextCursor: null },
    response: new Response(),
  })) as never);
  let complete!: (value: never) => void;
  const post = vi.spyOn(client, "POST").mockReturnValue(
    new Promise<never>((resolve) => {
      complete = resolve;
    }),
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
  fireEvent.click(await screen.findByRole("button", { name: "新增群目标" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "新群" },
  });
  fireEvent.change(screen.getByLabelText("群号"), { target: { value: "456" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  view.rerender(panel(false));
  await act(async () => {
    complete({ data: channel, response: new Response() } as never);
  });
  expect(get).toHaveBeenCalledTimes(2);
});
