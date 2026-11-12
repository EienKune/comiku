vi.mock("./WorkReminderPanels", () => ({
  WorkReminderSubscriptions: () => null,
  WorkReminderTemplate: () => null,
}));
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { NotificationManagement } from "./NotificationManagement";
import {
  SavedSample,
  TemplateEditor,
  type Template,
} from "./NotificationTemplateEditor";

const channel = {
  id: "c1",
  name: "合成群",
  groupId: "123",
  connectionKey: "bot",
  enabled: true,
  eventTypes: ["imported"],
  receiverMode: "legacy",
  subscriptionRules: [{ eventType: "imported", stages: null }],
  includeDetails: false,
  revision: 3,
  audienceGeneration: 1,
};
const delivery = {
  id: "d1",
  channelId: "c1",
  channelName: "合成群",
  groupId: "123",
  connectionKey: "bot",
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
function setup(enabled = true, available = true, mode = "legacy") {
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
                eventTypes: [
                  {
                    type: "imported",
                    label: "导入作品",
                    supportsStages: false,
                    allowedStages: [],
                  },
                  {
                    type: "stage_submitted",
                    label: "阶段提交",
                    supportsStages: true,
                    allowedStages: ["translate", "proofread", "typeset"],
                  },
                ],
                templates: ["imported", "stage_submitted"].map((eventType) => ({
                  eventType,
                  titleEnabled: false,
                  authorEnabled: false,
                  actorEnabled: false,
                  note: "",
                  revision: 0,
                  contentRevision: 0,
                  referencedGroupCount: 1,
                })),
                channels: [{ ...channel, receiverMode: mode }],
              }
            : { items: [delivery], nextCursor: null },
        response: new Response(),
      }) as never,
  );
  const post = vi
    .spyOn(client, "POST")
    .mockResolvedValue({ data: delivery, response: new Response() } as never);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderManagement = (active = true) => (
    <QueryClientProvider client={queryClient}>
      <NotificationManagement enabled={active} />
    </QueryClientProvider>
  );
  const view = render(renderManagement());
  return {
    get,
    post,
    setActive: (active: boolean) => view.rerender(renderManagement(active)),
  };
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
  expect((await screen.findAllByText("通知服务已关闭")).length).toBeGreaterThan(
    0,
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑 合成群" }));
  expect((screen.getByLabelText("群号") as HTMLInputElement).value).toBe("123");
  expect(post).not.toHaveBeenCalled();
});

test("shows unavailable connection and keeps edit accessible while disabling test", async () => {
  setup(true, false);
  expect(await screen.findByText("测试连接（不可用）")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "发送样例" }) as HTMLButtonElement)
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

test.each([false, true])(
  "group conflict recovery explicitly reapplies the current revision while preserving adoption=%s and selected rules",
  async (adopted) => {
    const { get, post } = setup();
    const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
      response: new Response(null, { status: 409 }),
    } as never);
    post.mockResolvedValue({
      data: { text: "群草稿预览" },
      response: new Response(),
    } as never);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "我的群草稿" },
    });
    fireEvent.change(screen.getByLabelText("群号"), {
      target: { value: "456" },
    });
    fireEvent.click(screen.getByLabelText("启用此群通知"));
    fireEvent.click(screen.getByLabelText("包含作者、标题和操作昵称"));
    fireEvent.click(screen.getByLabelText("导入作品"));
    fireEvent.click(screen.getByLabelText("阶段提交"));
    fireEvent.click(screen.getByLabelText("阶段提交：指定职责"));
    fireEvent.click(screen.getByLabelText("阶段提交：校对"));
    if (adopted) {
      fireEvent.click(
        screen.getByRole("button", { name: "预览并切换事件模板" }),
      );
      await screen.findByText("群草稿预览");
      fireEvent.click(screen.getByRole("button", { name: "确认使用事件模板" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/配置已被其他管理员修改/);
    const initial = (await get.mock.results[0].value) as { data: object };
    get.mockResolvedValue({
      data: {
        ...initial.data,
        connections: [
          { key: "bot", name: "测试连接", available: true },
          { key: "other", name: "他人连接", available: true },
        ],
        channels: [
          {
            ...channel,
            revision: 4,
            name: "服务器群名",
            groupId: "789",
            connectionKey: "other",
            includeDetails: true,
          },
        ],
      },
      response: new Response(),
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
    await screen.findByRole("button", { name: "编辑 服务器群名" });
    if (adopted) await confirmAdoption();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ expectedRevision: 3 }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "比较当前版本" }));
    const comparison = await screen.findByRole("region", {
      name: "当前群配置",
    });
    expect(within(comparison).getByText("当前服务器版本 4")).toBeTruthy();
    expect(within(comparison).getByText(/服务器群名.*789/)).toBeTruthy();
    expect(within(comparison).getByText(/他人连接/)).toBeTruthy();
    expect(within(comparison).getByText(/已启用/)).toBeTruthy();
    expect(within(comparison).getByText(/导入作品/)).toBeTruthy();
    expect(
      within(comparison).getByText(/包含作者、标题和操作昵称/),
    ).toBeTruthy();
    if (!adopted) {
      fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
      await screen.findByText("群草稿预览");
      fireEvent.click(
        screen.getByRole("button", { name: "预览并切换事件模板" }),
      );
      await screen.findByRole("button", { name: "确认使用事件模板" });
    }
    fireEvent.click(
      screen.getByRole("button", { name: "保留草稿并以当前版本重试" }),
    );
    expect(screen.queryByText("群草稿预览")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "确认使用事件模板" }),
    ).toBeNull();
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "我的群草稿",
    );
    expect((screen.getByLabelText("群号") as HTMLInputElement).value).toBe(
      "456",
    );
    expect(
      (screen.getByLabelText("阶段提交：校对") as HTMLInputElement).checked,
    ).toBe(true);
    patch.mockResolvedValueOnce({
      data: channel,
      response: new Response(),
    } as never);
    if (adopted) {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      expect(patch).toHaveBeenCalledTimes(2);
      await screen.findByText(/重新预览并确认/);
      await confirmAdoption();
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("配置已保存");
    expect(patch.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        body: {
          expectedRevision: 4,
          name: "我的群草稿",
          groupId: "456",
          connectionKey: "bot",
          enabled: false,
          includeDetails: true,
          eventTypes: ["stage_submitted"],
          subscriptionRules: [
            { eventType: "stage_submitted", stages: ["proofread"] },
          ],
          receiverMode: adopted ? "templates" : "legacy",
          ...(adopted
            ? {
                expectedTemplateRevisions: [
                  { eventType: "stage_submitted", revision: 0 },
                ],
              }
            : {}),
        },
      }),
    );
  },
);

test("group comparison without manual refresh updates the audience warning without automatically rebasing the draft", async () => {
  const { get } = setup();
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    response: new Response(null, { status: 409 }),
  } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "仅修改我的群名" },
  });
  expect(screen.queryByText(/包括仍符合新条件的消息/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText(/配置已被其他管理员修改/);
  const initial = (await get.mock.results[0].value) as { data: object };
  get.mockResolvedValue({
    data: {
      ...initial.data,
      channels: [{ ...channel, groupId: "789", revision: 4 }],
    },
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "比较当前版本" }));
  await screen.findByRole("region", { name: "当前群配置" });
  expect(screen.getByText(/包括仍符合新条件的消息/)).toBeTruthy();
  expect((screen.getByLabelText("群号") as HTMLInputElement).value).toBe("123");
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "仅修改我的群名",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][1]).toEqual(
    expect.objectContaining({
      body: expect.objectContaining({ expectedRevision: 3, groupId: "123" }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "比较当前版本" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "保留草稿并以当前版本重试" }),
  );
  expect(screen.getByText(/包括仍符合新条件的消息/)).toBeTruthy();
  patch.mockResolvedValueOnce({
    data: channel,
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("配置已保存");
  expect(patch.mock.calls[2][1]).toEqual(
    expect.objectContaining({
      body: expect.objectContaining({
        expectedRevision: 4,
        groupId: "123",
        name: "仅修改我的群名",
      }),
    }),
  );
  expect(get).toHaveBeenCalledTimes(4); // Initial load, two comparisons, successful-save invalidation.
});

test("explicit template Edit opens a modal without page scrolling and refresh retains input focus", async () => {
  const scroll = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  try {
    const { get } = setup();
    fireEvent.click(await screen.findByRole("tab", { name: "消息模板" }));
    const opener = screen.getByRole("button", { name: "编辑模板 阶段提交" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "阶段提交模板" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "阶段提交模板" }),
    );
    const input = screen.getByLabelText("事件提示语");
    input.focus();
    fireEvent.change(input, { target: { value: "保留输入焦点" } });
    fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    expect(
      (screen.getByLabelText("事件提示语") as HTMLInputElement).value,
    ).toBe("保留输入焦点");
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    if (previous)
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previous);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

test("synthetic sample history uses the notification test product label", async () => {
  const { get } = setup();
  await screen.findByRole("button", { name: "编辑 合成群" });
  get.mockResolvedValueOnce({
    data: {
      items: [{ ...delivery, eventType: "notification.test" }],
      nextCursor: null,
    },
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
  expect(await screen.findByText("通知测试")).toBeTruthy();
  expect(screen.queryByText("notification.test")).toBeNull();
});

test("requires duplicate confirmation and reuses idempotency key after uncertain retry", async () => {
  const { post } = setup();
  post.mockRejectedValueOnce(new TypeError("network"));
  fireEvent.click(await screen.findByRole("tab", { name: "投递记录" }));
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

test("shows configuration summary without claiming QQ online and labels delivery events", async () => {
  setup();
  fireEvent.click(await screen.findByText("连接配置"));
  expect(screen.getByText("配置可用")).toBeTruthy();
  expect(screen.queryByText(/在线/)).toBeNull();
  expect(screen.getByRole("heading", { name: "群订阅" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
  expect((await screen.findAllByText("导入作品")).length).toBeGreaterThan(0);
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
  await screen.findByText("暂无群目标。");
  expect(get).toHaveBeenCalledTimes(1);
  view.rerender(panel(false));
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  expect(get).toHaveBeenCalledTimes(1);
  view.rerender(panel(true));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
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
  expect(screen.getByText("使用公共事件模板")).toBeTruthy();
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
      receiverMode: "templates",
      subscriptionRules: [],
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
  expect(get).toHaveBeenCalledTimes(1);
});

test("tabs gate record reads and retain group and template drafts", async () => {
  const { get } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "新增群目标" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "保留群草稿" },
  });
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("tab", { name: "消息模板" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 导入作品" }));
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "保留模板草稿" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "群订阅" }));
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "保留群草稿",
  );
  fireEvent.click(screen.getByRole("tab", { name: "消息模板" }));
  expect((screen.getByLabelText("事件提示语") as HTMLInputElement).value).toBe(
    "保留模板草稿",
  );
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
  await screen.findByText("结果未知");
  expect(get).toHaveBeenCalledTimes(2);
});

test("template fields are independent and conflicts preserve Unicode draft", async () => {
  const { post } = setup();
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    response: new Response(null, { status: 409 }),
  } as never);
  fireEvent.click(await screen.findByRole("tab", { name: "消息模板" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 导入作品" }));
  fireEvent.click(screen.getByLabelText("作品标题"));
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "😀".repeat(120) },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  await screen.findByText(/草稿已保留/);
  expect(patch).toHaveBeenCalledWith(
    "/api/notifications/templates/{eventType}",
    expect.objectContaining({
      body: expect.objectContaining({
        expectedRevision: 0,
        titleEnabled: true,
        authorEnabled: false,
        actorEnabled: false,
        note: "😀".repeat(120),
      }),
    }),
  );
  expect((screen.getByLabelText("事件提示语") as HTMLInputElement).value).toBe(
    "😀".repeat(120),
  );
  expect(
    post.mock.calls.every((call) => call[0] === "/api/notifications/preview"),
  ).toBe(true);
});

test("stage rules save real selected stages and warn about every old unsent message", async () => {
  const { post } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "新增群目标" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "制作群" },
  });
  fireEvent.change(screen.getByLabelText("群号"), { target: { value: "456" } });
  fireEvent.click(screen.getByLabelText("阶段提交"));
  fireEvent.click(screen.getByLabelText("阶段提交：指定职责"));
  fireEvent.click(screen.getByLabelText("阶段提交：翻译"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/notifications/channels",
      expect.objectContaining({
        body: expect.objectContaining({
          subscriptionRules: [
            { eventType: "stage_submitted", stages: ["translate"] },
          ],
        }),
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑 合成群" }));
  fireEvent.click(screen.getByLabelText("导入作品"));
  expect(screen.getByText(/包括仍符合新条件的消息/)).toBeTruthy();
});

test("legacy adoption requires preview and explicit confirmation", async () => {
  const { post } = setup();
  post.mockResolvedValue({
    data: { text: "模板合成正文" },
    response: new Response(),
  } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.click(screen.getByRole("button", { name: "预览并切换事件模板" }));
  expect(await screen.findByText("模板合成正文")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认使用事件模板" }));
  expect(screen.getByText("使用公共事件模板")).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(1);
});

test("sample requires saved event target and body confirmation before queuing", async () => {
  const { post } = setup();
  post.mockImplementation((async (path: string) => ({
    data: path.endsWith("preview") ? { text: "已保存合成正文" } : delivery,
    response: new Response(),
  })) as never);
  fireEvent.click(await screen.findByRole("button", { name: "发送样例" }));
  fireEvent.click(screen.getByRole("button", { name: "预览已保存样例" }));
  expect(await screen.findByText("已保存合成正文")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "确认排队" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("确认目标群与以上正文"));
  fireEvent.click(screen.getByRole("button", { name: "确认排队" }));
  await screen.findByText(/样例已排队/);
  expect(post).toHaveBeenCalledWith(
    "/api/notifications/channels/{id}/test",
    expect.objectContaining({
      body: expect.objectContaining({
        eventType: "imported",
        expectedRevision: 3,
        idempotencyKey: expect.any(String),
      }),
    }),
  );
});

test("saved template sample pins preview revision and requires a new preview after conflict", async () => {
  const { post } = setup(true, true, "templates");
  post.mockImplementation((async (path: string) =>
    path.endsWith("preview")
      ? { data: { text: "保存模板样例" }, response: new Response() }
      : {
          error: { message: "conflict" },
          response: new Response(null, { status: 409 }),
        }) as never);
  fireEvent.click(await screen.findByRole("button", { name: "发送样例" }));
  fireEvent.click(screen.getByRole("button", { name: "预览已保存样例" }));
  await screen.findByText("保存模板样例");
  fireEvent.click(screen.getByLabelText("确认目标群与以上正文"));
  fireEvent.click(screen.getByRole("button", { name: "确认排队" }));
  await screen.findByText(/重新预览/);
  expect(post).toHaveBeenCalledWith(
    "/api/notifications/channels/{id}/test",
    expect.objectContaining({
      body: expect.objectContaining({ expectedTemplateRevision: 0 }),
    }),
  );
  expect(
    (screen.getByRole("button", { name: "确认排队" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("template sample selects stage and missing metadata without saving and clears stale preview", async () => {
  const { post } = setup();
  post.mockResolvedValue({
    data: { text: "缺少资料样例" },
    response: new Response(),
  } as never);
  fireEvent.click(await screen.findByRole("tab", { name: "消息模板" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 阶段提交" }));
  fireEvent.click(screen.getByLabelText("作者"));
  fireEvent.click(screen.getByLabelText("样例资料"));
  fireEvent.click(await screen.findByRole("option", { name: "缺少资料" }));
  // Native SelectField is custom; choose through its accessible options.
  fireEvent.click(screen.getByLabelText("样例职责"));
  fireEvent.click(await screen.findByRole("option", { name: "嵌字" }));
  await screen.findByText("缺少资料样例");
  expect(post).toHaveBeenCalledWith(
    "/api/notifications/preview",
    expect.objectContaining({
      body: expect.objectContaining({
        stage: "typeset",
        template: expect.objectContaining({
          authorEnabled: true,
          titleEnabled: false,
          actorEnabled: false,
        }),
      }),
    }),
  );
  fireEvent.click(screen.getByLabelText("作者"));
  expect(screen.queryByText("缺少资料样例")).toBeNull();
});

const sampleTemplate: Template = {
  eventType: "imported",
  titleEnabled: false,
  authorEnabled: false,
  actorEnabled: false,
  note: "",
  revision: 0,
  contentRevision: 0,
  referencedGroupCount: 1,
};

test("refreshed saved target invalidates old consent and late preview completion", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: { text: "旧群正文" },
    response: new Response(),
  } as never);
  const sample = (revision: number, groupId: string) => (
    <SavedSample
      channel={
        {
          ...channel,
          receiverMode: "templates",
          eventTypes: ["imported"],
          revision,
          groupId,
        } as never
      }
      templates={[sampleTemplate]}
      events={[{ type: "imported", label: "已导入", allowedStages: [] }]}
      unavailableReason=""
      onUpdated={() => {}}
    />
  );
  const view = render(sample(3, "123"));
  fireEvent.click(screen.getByRole("button", { name: "发送样例" }));
  fireEvent.click(screen.getByRole("button", { name: "预览已保存样例" }));
  await screen.findByText("旧群正文");
  fireEvent.click(screen.getByLabelText("确认目标群与以上正文"));
  view.rerender(sample(4, "456"));
  fireEvent.click(screen.getByRole("button", { name: "发送样例" }));
  expect(screen.queryByText("旧群正文")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "确认排队" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  let complete!: (value: never) => void;
  post.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览已保存样例" }));
  view.rerender(sample(5, "789"));
  fireEvent.click(screen.getByRole("button", { name: "发送样例" }));
  await act(async () => {
    complete({ data: { text: "迟到正文" }, response: new Response() } as never);
  });
  expect(screen.queryByText("迟到正文")).toBeNull();
});

test("adoption preview is invalidated by edits and stale async results", async () => {
  const { post } = setup();
  post.mockResolvedValue({
    data: { text: "旧采用正文" },
    response: new Response(),
  } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.click(screen.getByRole("button", { name: "预览并切换事件模板" }));
  await screen.findByText("旧采用正文");
  fireEvent.click(screen.getByLabelText("导入作品"));
  expect(screen.queryByRole("button", { name: "确认使用事件模板" })).toBeNull();
  fireEvent.click(screen.getByLabelText("导入作品"));
  let complete!: (value: never) => void;
  post.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览并切换事件模板" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "变更群草稿" },
  });
  await act(async () => {
    complete({
      data: { text: "迟到采用正文" },
      response: new Response(),
    } as never);
  });
  expect(screen.queryByText("迟到采用正文")).toBeNull();
  expect(screen.queryByRole("button", { name: "确认使用事件模板" })).toBeNull();
});

test("template conflict offers explicit current version comparison and preserves editable fields", async () => {
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValueOnce({
      response: new Response(null, { status: 409 }),
    } as never)
    .mockResolvedValue({
      data: { ...sampleTemplate, revision: 3, note: "我的修改" },
      response: new Response(),
    } as never);
  vi.spyOn(client, "GET").mockResolvedValue({
    data: { templates: [{ ...sampleTemplate, revision: 2, note: "他人修改" }] },
    response: new Response(),
  } as never);
  const editor = (revision: number) => (
    <TemplateEditor
      templates={[
        { ...sampleTemplate, revision, note: revision ? "他人修改" : "" },
      ]}
      events={[{ type: "imported", label: "已导入" }]}
      onUpdated={() => {}}
    />
  );
  const view = render(editor(0));
  fireEvent.click(screen.getByRole("button", { name: "编辑模板 已导入" }));
  fireEvent.change(screen.getByLabelText("事件提示语"), {
    target: { value: "我的修改" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  await screen.findByText(/草稿已保留/);
  view.rerender(editor(2));
  expect((screen.getByLabelText("事件提示语") as HTMLInputElement).value).toBe(
    "我的修改",
  );
  fireEvent.click(screen.getByRole("button", { name: "比较当前版本" }));
  await screen.findByText(/他人修改/);
  fireEvent.click(
    screen.getByRole("button", { name: "保留草稿并以当前版本重试" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][1]).toEqual(
    expect.objectContaining({
      body: expect.objectContaining({ expectedRevision: 2, note: "我的修改" }),
    }),
  );
});

test("saved sample can choose each subscribed stage without offering unsubscribed stages", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: { text: "校对样例" },
    response: new Response(),
  } as never);
  render(
    <SavedSample
      channel={
        {
          ...channel,
          eventTypes: ["stage_submitted"],
          subscriptionRules: [
            {
              eventType: "stage_submitted",
              stages: ["translate", "proofread"],
            },
          ],
        } as never
      }
      templates={[]}
      events={[
        {
          type: "stage_submitted",
          label: "阶段提交",
          supportsStages: true,
          allowedStages: ["translate", "proofread", "typeset"],
        },
      ]}
      unavailableReason=""
      onUpdated={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "发送样例" }));
  fireEvent.click(screen.getByLabelText("样例职责"));
  expect(screen.queryByRole("option", { name: "嵌字" })).toBeNull();
  fireEvent.click(await screen.findByRole("option", { name: "校对" }));
  fireEvent.click(screen.getByRole("button", { name: "预览已保存样例" }));
  await screen.findByText("校对样例");
  expect(post).toHaveBeenCalledWith(
    "/api/notifications/preview",
    expect.objectContaining({
      body: expect.objectContaining({ stage: "proofread" }),
    }),
  );
});

test("refreshed templates invalidate adoption consent and pending adoption previews while preserving group draft", async () => {
  const { get, post } = setup();
  post.mockResolvedValue({
    data: { text: "采用旧字段正文" },
    response: new Response(),
  } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "保留群草稿" },
  });
  fireEvent.click(screen.getByRole("button", { name: "预览并切换事件模板" }));
  await screen.findByText("采用旧字段正文");
  const config = (revision: number) => ({
    enabled: true,
    configurationError: null,
    connections: [{ key: "bot", name: "测试连接", available: true }],
    channels: [channel],
    eventTypes: [
      {
        type: "imported",
        label: "导入作品",
        supportsStages: false,
        allowedStages: [],
      },
    ],
    templates: [
      {
        ...sampleTemplate,
        revision,
        titleEnabled: true,
        note: String(revision),
      },
    ],
  });
  get.mockResolvedValueOnce({
    data: config(1),
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "确认使用事件模板" }),
    ).toBeNull(),
  );
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "保留群草稿",
  );
  let complete!: (value: never) => void;
  post.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览并切换事件模板" }));
  get.mockResolvedValueOnce({
    data: config(2),
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  await act(async () => {
    complete({
      data: { text: "刷新后迟到采用正文" },
      response: new Response(),
    } as never);
  });
  expect(screen.queryByRole("button", { name: "确认使用事件模板" })).toBeNull();
  expect(screen.queryByText("刷新后迟到采用正文")).toBeNull();
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "保留群草稿",
  );
});

async function confirmAdoption() {
  fireEvent.click(screen.getByRole("button", { name: "预览并切换事件模板" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "确认使用事件模板" }),
  );
}

test("adoption PATCH sends the exact previewed revisions for every selected template including zero", async () => {
  const { get, post } = setup();
  post.mockResolvedValue({
    data: { text: "模板预览" },
    response: new Response(),
  } as never);
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue({ data: channel, response: new Response() } as never);
  await screen.findByRole("button", { name: "编辑 合成群" });
  const initial = (await get.mock.results[0].value) as {
    data: { templates: Template[] };
  };
  get.mockResolvedValueOnce({
    data: {
      ...initial.data,
      templates: initial.data.templates.map((template) => ({
        ...template,
        revision: template.eventType === "stage_submitted" ? 7 : 0,
      })),
    },
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "刷新配置" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑 合成群" }));
  fireEvent.click(screen.getByLabelText("阶段提交"));
  await confirmAdoption();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("配置已保存");
  expect(patch).toHaveBeenCalledWith(
    "/api/notifications/channels/{id}",
    expect.objectContaining({
      body: expect.objectContaining({
        expectedTemplateRevisions: [
          { eventType: "imported", revision: 0 },
          { eventType: "stage_submitted", revision: 7 },
        ],
      }),
    }),
  );
});

test("an unseen server template update rejects adoption, keeps fields and rules and requires a fresh preview map", async () => {
  const { get, post } = setup();
  post.mockResolvedValue({
    data: { text: "模板预览" },
    response: new Response(),
  } as never);
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValueOnce({
      error: { message: "事件模板已变更，请重新预览并确认后重试" },
      response: new Response(null, { status: 409 }),
    } as never)
    .mockResolvedValue({ data: channel, response: new Response() } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "保留采用草稿" },
  });
  fireEvent.click(screen.getByLabelText("阶段提交"));
  fireEvent.click(screen.getByLabelText("阶段提交：指定职责"));
  fireEvent.click(screen.getByLabelText("阶段提交：校对"));
  await confirmAdoption();
  const initial = (await get.mock.results[0].value) as {
    data: { templates: Template[] };
  };
  get.mockResolvedValue({
    data: {
      ...initial.data,
      templates: initial.data.templates.map((t) => ({
        ...t,
        revision: 1,
        titleEnabled: true,
      })),
    },
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText(/事件模板已变更/);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "保留采用草稿",
  );
  expect(
    (screen.getByLabelText("阶段提交：校对") as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(patch).toHaveBeenCalledTimes(1);
  await confirmAdoption();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("配置已保存");
  expect(patch.mock.calls[1][1]).toEqual(
    expect.objectContaining({
      body: expect.objectContaining({
        name: "保留采用草稿",
        expectedRevision: 3,
        expectedTemplateRevisions: [
          { eventType: "imported", revision: 1 },
          { eventType: "stage_submitted", revision: 1 },
        ],
      }),
    }),
  );
});

test.each(["template refresh", "field edit", "rule edit"])(
  "confirmed adoption is invalidated after %s and cannot save until previewed again",
  async (change) => {
    const { get, post } = setup();
    post.mockResolvedValue({
      data: { text: "模板预览" },
      response: new Response(),
    } as never);
    const patch = vi
      .spyOn(client, "PATCH")
      .mockResolvedValue({ data: channel, response: new Response() } as never);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
    await confirmAdoption();
    if (change === "template refresh") {
      const initial = (await get.mock.results[0].value) as {
        data: { templates: Template[] };
      };
      get.mockResolvedValueOnce({
        data: {
          ...initial.data,
          templates: initial.data.templates.map((t) => ({ ...t, revision: 2 })),
        },
        response: new Response(),
      } as never);
      fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: "刷新配置",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
    } else if (change === "field edit") {
      fireEvent.change(screen.getByLabelText("名称"), {
        target: { value: "更改草稿" },
      });
    } else {
      fireEvent.click(screen.getByLabelText("阶段提交"));
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(patch).not.toHaveBeenCalled();
    await screen.findByText(/重新预览并确认/);
    await confirmAdoption();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("配置已保存");
  },
);

test("history identifies the frozen destination even when the current management name and target changed", async () => {
  const { get } = setup();
  await screen.findByRole("button", { name: "编辑 合成群" });
  get.mockResolvedValueOnce({
    data: {
      items: [
        {
          ...delivery,
          channelName: "新管理名称",
          groupId: "111222",
          connectionKey: "retired-bot",
        },
      ],
      nextCursor: null,
    },
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
  expect(await screen.findByText(/当前管理名称：新管理名称/)).toBeTruthy();
  expect(screen.getByText(/原投递目标：QQ 群 111222/)).toBeTruthy();
  expect(screen.getByText(/连接标识：retired-bot/)).toBeTruthy();
});

test("disabled adoption with no selected events sends an explicit empty revision map", async () => {
  setup();
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue({ data: channel, response: new Response() } as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  fireEvent.click(screen.getByLabelText("启用此群通知"));
  fireEvent.click(screen.getByLabelText("导入作品"));
  await confirmAdoption();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("配置已保存");
  expect(patch.mock.calls[0][1]).toEqual(
    expect.objectContaining({
      body: expect.objectContaining({
        expectedTemplateRevisions: [],
        eventTypes: [],
        enabled: false,
      }),
    }),
  );
});

test("missing selected template configuration cannot produce adoption consent", async () => {
  const { get, post } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
  const initial = (await get.mock.results[0].value) as { data: object };
  get.mockResolvedValueOnce({
    data: { ...initial.data, templates: [] },
    response: new Response(),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "刷新配置" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览并切换事件模板" }));
  await screen.findByText(/事件模板配置缺失/);
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "确认使用事件模板" })).toBeNull();
});

test.each([false, true])(
  "explicit group rebase keeps an already modern server group in template mode with prior adoption=%s",
  async (adopted) => {
    const { get, post } = setup();
    post.mockResolvedValue({
      data: { text: "模板预览" },
      response: new Response(),
    } as never);
    const patch = vi
      .spyOn(client, "PATCH")
      .mockResolvedValueOnce({
        response: new Response(null, { status: 409 }),
      } as never)
      .mockResolvedValue({ data: channel, response: new Response() } as never);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "保留现代表单" },
    });
    if (adopted) await confirmAdoption();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/配置已被其他管理员修改/);
    const initial = (await get.mock.results[0].value) as { data: object };
    get.mockResolvedValue({
      data: {
        ...initial.data,
        channels: [{ ...channel, revision: 4, receiverMode: "templates" }],
      },
      response: new Response(),
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "比较当前版本" }));
    await screen.findByText("当前服务器版本 4");
    fireEvent.click(
      screen.getByRole("button", { name: "保留草稿并以当前版本重试" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("配置已保存");
    expect(patch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          name: "保留现代表单",
          expectedRevision: 4,
          receiverMode: "templates",
        }),
      }),
    );
    expect(patch.mock.calls[1][1]).not.toHaveProperty(
      "body.expectedTemplateRevisions",
    );
  },
);

test.each(["history", "outer panel"])(
  "a late adoption conflict retains the draft with the active catalogue boundary for %s",
  async (hiddenBy) => {
    const { get, post, setActive } = setup();
    post.mockResolvedValue({
      data: { text: "旧模板预览" },
      response: new Response(),
    } as never);
    let complete!: (value: never) => void;
    const patch = vi
      .spyOn(client, "PATCH")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      )
      .mockResolvedValue({ data: channel, response: new Response() } as never);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "隐藏期间保留草稿" },
    });
    await confirmAdoption();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const initial = (await get.mock.results[0].value) as {
      data: { templates: Template[] };
    };
    get.mockImplementation((async (path: string) => ({
      data: path.endsWith("/configuration")
        ? {
            ...initial.data,
            templates: initial.data.templates.map((template) => ({
              ...template,
              revision: 5,
              titleEnabled: true,
            })),
          }
        : { items: [delivery], nextCursor: null },
      response: new Response(),
    })) as never);
    if (hiddenBy === "history") {
      fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
      await screen.findByText(/原投递目标/);
    } else {
      setActive(false);
    }
    await act(async () => {
      complete({
        error: { message: "事件模板已变更，请重新预览并确认后重试" },
        response: new Response(null, { status: 409 }),
      } as never);
    });
    const configurationReads = () =>
      get.mock.calls.filter(
        (call) => call[0] === "/api/notifications/configuration",
      ).length;
    await screen.findByText(/事件模板已变更/);
    expect(configurationReads()).toBe(hiddenBy === "history" ? 2 : 1);
    if (hiddenBy === "history")
      fireEvent.click(screen.getByRole("tab", { name: "群订阅" }));
    else setActive(true);
    await waitFor(() => expect(configurationReads()).toBe(2));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "刷新配置" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "隐藏期间保留草稿",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(patch).toHaveBeenCalledTimes(1);
    await confirmAdoption();
    expect(post).toHaveBeenLastCalledWith(
      "/api/notifications/preview",
      expect.objectContaining({
        body: expect.objectContaining({
          template: expect.objectContaining({ titleEnabled: true }),
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("配置已保存");
    expect(patch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          name: "隐藏期间保留草稿",
          expectedRevision: 3,
          expectedTemplateRevisions: [{ eventType: "imported", revision: 5 }],
        }),
      }),
    );
  },
);

test("running status tab keeps drafts, gates configuration and supports four-tab keyboard navigation", async () => {
  const { get, setActive } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "新增群目标" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "状态页切换保留" },
  });
  get.mockImplementation(
    async (path) =>
      ({
        data: String(path).endsWith("/status")
          ? {
              enabled: false,
              state: "disabled",
              sourceSince: null,
              expandedSourceSince: null,
              lastMaintenanceAt: null,
              lastCaptureAt: null,
              lastRegistrationAt: null,
              lastErrorAt: null,
              lastErrorCode: null,
              counts: {
                uncaptured: null,
                pending: { count: 0, capped: false, oldestAt: null },
                retryWait: { count: 0, capped: false, oldestAt: null },
                invalid: { count: 0, capped: false, oldestAt: null },
              },
            }
          : { items: [], nextCursor: null },
        response: new Response(),
      }) as never,
  );
  fireEvent.keyDown(screen.getByRole("tab", { name: "群订阅" }), {
    key: "End",
  });
  await screen.findByText("通知已关闭");
  expect(
    screen.getByRole("tab", { name: "运行状态" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    get.mock.calls.filter(
      (call) => call[0] === "/api/notifications/configuration",
    ),
  ).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "刷新配置" })).toBeNull();
  setActive(false);
  const reads = get.mock.calls.length;
  await act(async () => {});
  expect(get).toHaveBeenCalledTimes(reads);
  fireEvent.keyDown(screen.getByRole("tab", { name: "运行状态" }), {
    key: "ArrowRight",
  });
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "状态页切换保留",
  );
});
