// @vitest-environment jsdom
import { useState } from "react";
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { NotificationManagement } from "./NotificationManagement";
import { NotificationEventSettings } from "./NotificationEventSettings";
import { NotificationStatusPanel } from "./NotificationStatusPanel";
import { categories } from "./notification-event-categories";
import type {
  EventOption,
  SubscriptionRule,
} from "./NotificationTemplateEditor";

const events: EventOption[] = categories
  .flatMap((category) =>
    category.ids.map((type) => ({
      type: type as EventOption["type"],
      label: type,
      supportsStages: type === "stage_submitted",
      allowedStages:
        type === "stage_submitted"
          ? (["translate", "proofread", "typeset"] as const)
          : [],
    })),
  )
  .map((event) => ({ ...event, allowedStages: [...event.allowedStages] }));
const channel = {
  id: "g1",
  name: "合成群一",
  groupId: "12345",
  connectionKey: "bot",
  enabled: true,
  eventTypes: ["stage_submitted"],
  receiverMode: "templates",
  includeDetails: false,
  subscriptionRules: [{ eventType: "stage_submitted", stages: ["proofread"] }],
  revision: 3,
  audienceGeneration: 1,
};
const configuration = {
  enabled: true,
  configurationError: null,
  connections: [
    { key: "bot", name: "合成连接", available: true, adapter: "onebot_v11" },
  ],
  channels: [
    channel,
    {
      ...channel,
      id: "g2",
      name: "合成群二",
      groupId: "12346",
      enabled: false,
    },
  ],
  eventTypes: events,
  templates: events.map((event) => ({
    eventType: event.type,
    titleEnabled: false,
    authorEnabled: false,
    actorEnabled: false,
    note: "",
    revision: 1,
    contentRevision: 1,
    referencedGroupCount: 1,
  })),
};
const work = {
  settings: {
    enabled: true,
    sendTimes: ["09:00", "18:00"],
    note: "",
    revision: 1,
  },
  channels: configuration.channels.map((item) => ({
    ...item,
    subscription: {
      digestEnabled: true,
      overdueEnabled: false,
      readyEnabled: true,
      mentionsEnabled: false,
      revision: 2,
    },
  })),
};
const birthdayChannels = configuration.channels.map((item) => ({
  ...item,
  birthdayEnabled: false,
  birthdayRevision: 4,
}));
const birthdaySettings = {
  available: true,
  settings: {
    revision: 5,
    displayEnabled: true,
    remindersEnabled: true,
    sendTime: "09:00",
    offsetDays: [0, 1],
  },
  personCount: 1,
  lastCheckedAt: null,
  dataUpdatedAt: null,
};
const reply = (data: unknown, status = 200) => ({
  data,
  response: new Response(null, { status }),
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(inheritedOffsets = [0, 1]) {
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
  ) =>
    reply(
      path === "/api/notifications/configuration"
        ? configuration
        : path === "/api/notifications/work-reminders"
          ? work
          : path === "/api/birthdays/subscriptions"
            ? birthdayChannels
            : path === "/api/birthdays/settings"
              ? {
                  ...birthdaySettings,
                  settings: {
                    ...birthdaySettings.settings,
                    offsetDays: inheritedOffsets,
                  },
                }
              : path === "/api/birthdays/template"
                ? { note: "", revision: 6 }
                : path === "/api/birthdays/preview"
                  ? { text: "服务端生日预览" }
                  : { items: [], nextCursor: null },
    )) as never);
  const post = vi
    .spyOn(client, "POST")
    .mockResolvedValue(reply({ text: "服务端合成预览" }) as never);
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(reply(channel) as never);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const component = (enabled: boolean) => (
    <QueryClientProvider client={cache}>
      <NotificationManagement enabled={enabled} />
    </QueryClientProvider>
  );
  const view = render(component(true));
  return {
    get,
    post,
    patch,
    cache,
    setEnabled: (value: boolean) => view.rerender(component(value)),
  };
}

function openGroupControls(name: string) {
  const roster = within(document.querySelector(".notification-channels")!);
  const row = roster
    .getByText(name, { selector: "strong" })
    .closest("article")!;
  fireEvent.click(within(row).getByRole("button", { name: `编辑 ${name}` }));
  const element = screen.getByRole("dialog");
  const dialog = within(element);
  return {
    ...dialog,
    navigation: within(dialog.getByRole("navigation", { name: "群设置类别" })),
    footer: within(element.querySelector("footer")!),
    close: () =>
      fireEvent.click(
        within(element.querySelector("header")!).getByRole("button", {
          name: "关闭群设置",
        }),
      ),
  };
}

test("four navigation entries, compact saved summaries and focusable disabled sample reason", async () => {
  mount();
  expect(await screen.findAllByText("作品 1 类 · 工作 2 项")).toHaveLength(2);
  expect(screen.getByRole("heading", { name: "通知推送" })).toBeTruthy();
  expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
    "接收群",
    "全局规则",
    "发送记录",
    "运行状态",
  ]);
  expect(screen.queryByRole("tab", { name: "消息模板" })).toBeNull();
  const disabled = screen.getByLabelText("发送样例：此群已停用");
  expect(disabled.getAttribute("tabindex")).toBe("0");
  expect(
    within(disabled)
      .getByRole("button", { name: "发送样例" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("搜索接收群"), {
    target: { value: "12346" },
  });
  expect(screen.queryByRole("button", { name: "编辑 合成群一" })).toBeNull();
  expect(screen.getByRole("button", { name: "编辑 合成群二" })).toBeTruthy();
});

test("all 24 grouped capabilities retain selected stages under presets and guard the final stage", () => {
  const changes = vi.fn();
  function Harness() {
    const [rules, setRules] = useState<SubscriptionRule[]>([
      { eventType: "stage_submitted", stages: ["proofread"] },
    ]);
    return (
      <NotificationEventSettings
        events={events}
        rules={rules}
        onChange={(next) => {
          changes(next);
          setRules(next);
        }}
        onPreview={() => {}}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "全部事件" }));
  expect(changes.mock.lastCall?.[0]).toHaveLength(24);
  expect(changes.mock.lastCall?.[0]).toContainEqual({
    eventType: "stage_submitted",
    stages: ["proofread"],
  });
  fireEvent.click(screen.getByRole("button", { name: /制作进度/ }));
  fireEvent.click(screen.getByRole("button", { name: "全选本组" }));
  expect(changes.mock.lastCall?.[0]).toContainEqual({
    eventType: "stage_submitted",
    stages: ["proofread"],
  });
  fireEvent.click(screen.getByRole("button", { name: "适用环节：校对" }));
  fireEvent.click(screen.getByLabelText("stage_submitted：校对"));
  expect(
    (screen.getByLabelText("stage_submitted：校对") as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("至少保留一个适用环节。");
  fireEvent.click(screen.getByRole("button", { name: "资料变更 3 / 3 ⌄" }));
  fireEvent.click(screen.getByRole("button", { name: "清空本组" }));
  expect(changes.mock.lastCall?.[0]).toHaveLength(21);
  expect(changes.mock.lastCall?.[0]).toContainEqual({
    eventType: "stage_submitted",
    stages: ["proofread"],
  });
});

test("group categories retain independent drafts across close and another group and save only the chosen scope", async () => {
  const { patch, get, cache } = mount();
  await screen.findByText("合成群一", { selector: "strong" });
  let group = openGroupControls("合成群一");
  fireEvent.click(group.navigation.getByRole("button", { name: "基本信息" }));
  fireEvent.change(group.getByLabelText("名称"), {
    target: { value: "群一草稿" },
  });
  fireEvent.click(group.navigation.getByRole("button", { name: "工作提醒" }));
  fireEvent.click(
    within(
      await group.findByRole("form", { name: "合成群一的工作提醒" }),
    ).getByLabelText("72 小时未交稿"),
  );
  fireEvent.click(group.navigation.getByRole("button", { name: "生日提醒" }));
  fireEvent.click(await group.findByLabelText("合成群一接收生日提醒"));
  group.close();
  group = openGroupControls("合成群二");
  group.close();
  group = openGroupControls("合成群一");
  expect((group.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "群一草稿",
  );
  fireEvent.click(group.navigation.getByRole("button", { name: "生日提醒" }));
  expect(
    (group.getByLabelText("合成群一接收生日提醒") as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(group.footer.getByRole("button", { name: "保存生日订阅" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch).toHaveBeenLastCalledWith(
    "/api/birthdays/subscriptions/{id}",
    expect.objectContaining({
      body: {
        enabled: true,
        expectedChannelRevision: 3,
        expectedScopeRevision: 4,
      },
    }),
  );
  fireEvent.click(group.navigation.getByRole("button", { name: "工作提醒" }));
  expect(
    (
      within(
        group.getByRole("form", { name: "合成群一的工作提醒" }),
      ).getByLabelText("72 小时未交稿") as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(group.footer.getByRole("button", { name: "保存工作提醒" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch).toHaveBeenLastCalledWith(
    "/api/notifications/work-reminders/subscriptions/{id}",
    expect.objectContaining({
      body: expect.objectContaining({
        overdueEnabled: true,
        expectedChannelRevision: 3,
        expectedRevision: 2,
      }),
    }),
  );
  group.close();
  fireEvent.click(
    within(screen.getByRole("tablist", { name: "推送通知分类" })).getByRole(
      "tab",
      { name: "发送记录" },
    ),
  );
  await screen.findByText("暂无投递记录。");
  const before = get.mock.calls.length;
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ["work-reminders"] });
    await cache.invalidateQueries({ queryKey: ["birthdays"] });
  });
  expect(get).toHaveBeenCalledTimes(before);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("birthday group conflict compares and explicitly adopts both revisions without overwriting its draft", async () => {
  const { get, patch } = mount();
  patch.mockResolvedValueOnce(reply({}, 409) as never);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群一" }));
  fireEvent.click(screen.getByRole("button", { name: "生日提醒" }));
  fireEvent.click(await screen.findByLabelText("合成群一接收生日提醒"));
  get.mockImplementation((async (path: string) =>
    reply(
      path === "/api/birthdays/subscriptions"
        ? birthdayChannels.map((item) => ({
            ...item,
            revision: 8,
            birthdayRevision: 9,
          }))
        : birthdaySettings,
    )) as never);
  fireEvent.click(screen.getByRole("button", { name: "保存生日订阅" }));
  await screen.findByText(/生日订阅已变化/);
  expect(
    (screen.getByLabelText("合成群一接收生日提醒") as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "保留草稿并以当前版本重试" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存生日订阅" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch).toHaveBeenLastCalledWith(
    "/api/birthdays/subscriptions/{id}",
    expect.objectContaining({
      body: {
        enabled: true,
        expectedChannelRevision: 8,
        expectedScopeRevision: 9,
      },
    }),
  );
});

test("advanced registration reads stay lazy until opened", async () => {
  const get = vi.spyOn(client, "GET").mockResolvedValue(
    reply({
      enabled: false,
      state: "disabled",
      deliveries: {},
      counts: {},
    }) as never,
  );
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <NotificationStatusPanel enabled />
    </QueryClientProvider>,
  );
  await screen.findByText("通知已关闭");
  expect(get).toHaveBeenCalledTimes(1);
  const details = document.querySelector("details")!;
  get.mockResolvedValue(reply({ items: [], nextCursor: null }) as never);
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      "/api/notifications/receipts",
      expect.anything(),
    ),
  );
});

test("birthday group preview starts at an inherited offset and only offers configured dates", async () => {
  const { get } = mount([7]);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群一" }));
  fireEvent.click(screen.getByRole("button", { name: "生日提醒" }));
  await screen.findByText("服务端生日预览");
  expect(
    get.mock.calls
      .filter((call) => call[0] === "/api/birthdays/preview")
      .map((call) => call[1]),
  ).toEqual([
    expect.objectContaining({ params: { query: { offsetDays: 7 } } }),
  ]);
  fireEvent.click(screen.getByRole("combobox", { name: "预览日期" }));
  expect(screen.getByRole("option", { name: "提前 7 天" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "生日当天" })).toBeNull();
});

test.each(["work", "birthday"] as const)(
  "own general save refreshes clean %s revision before a delayed dependent read",
  async (scope) => {
    const { get, patch } = mount();
    await screen.findAllByText("作品 1 类 · 工作 2 项");
    const savedChannel = { ...channel, name: "本次保存群名", revision: 4 };
    let written = false;
    const read = get.getMockImplementation() as unknown as (
      path: string,
      options: unknown,
    ) => unknown;
    get.mockImplementation((async (path: string, options: never) => {
      if (
        written &&
        (path === "/api/notifications/work-reminders" ||
          path === "/api/birthdays/subscriptions")
      )
        return new Promise(() => {});
      if (written && path === "/api/notifications/configuration")
        return reply({
          ...configuration,
          channels: [savedChannel, configuration.channels[1]],
        });
      return read(path as never, options);
    }) as never);
    patch.mockImplementation((async (path: string) => {
      if (path === "/api/notifications/channels/{id}") {
        written = true;
        return reply(savedChannel);
      }
      return reply({});
    }) as never);
    fireEvent.click(screen.getByRole("button", { name: "编辑 合成群一" }));
    fireEvent.click(screen.getByRole("button", { name: "基本信息" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: savedChannel.name },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存群设置" }));
    await screen.findByText("配置已保存");
    fireEvent.click(screen.getByRole("button", { name: "关闭群设置" }));
    fireEvent.click(
      await screen.findByRole("button", { name: `编辑 ${savedChannel.name}` }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: scope === "work" ? "工作提醒" : "生日提醒",
      }),
    );
    if (scope === "work") {
      const form = await screen.findByRole("form", {
        name: /(合成群一|本次保存群名)的工作提醒/,
      });
      fireEvent.click(within(form).getByLabelText("任务交接提醒"));
      fireEvent.click(screen.getByRole("button", { name: "保存工作提醒" }));
    } else {
      fireEvent.click(
        await screen.findByRole("checkbox", { name: /接收生日提醒/ }),
      );
      fireEvent.click(screen.getByRole("button", { name: "保存生日订阅" }));
    }
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ expectedChannelRevision: 4 }),
      }),
    );
  },
);

test("discarding one group's general draft preserves every work and birthday scope draft", async () => {
  const { patch } = mount();
  await screen.findByText("合成群一", { selector: "strong" });
  let group = openGroupControls("合成群一");
  fireEvent.click(group.navigation.getByRole("button", { name: "工作提醒" }));
  fireEvent.click(
    within(
      await group.findByRole("form", { name: "合成群一的工作提醒" }),
    ).getByLabelText("72 小时未交稿"),
  );
  group.close();
  group = openGroupControls("合成群二");
  fireEvent.click(group.navigation.getByRole("button", { name: "生日提醒" }));
  fireEvent.click(await group.findByLabelText("合成群二接收生日提醒"));
  fireEvent.click(group.navigation.getByRole("button", { name: "基本信息" }));
  fireEvent.change(group.getByLabelText("名称"), {
    target: { value: "丢弃的名称" },
  });
  fireEvent.click(group.footer.getByRole("button", { name: "放弃草稿" }));
  group = openGroupControls("合成群一");
  fireEvent.click(group.navigation.getByRole("button", { name: "工作提醒" }));
  expect(
    (
      within(
        await group.findByRole("form", { name: "合成群一的工作提醒" }),
      ).getByLabelText("72 小时未交稿") as HTMLInputElement
    ).checked,
  ).toBe(true);
  group.close();
  group = openGroupControls("合成群二");
  expect((group.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "合成群二",
  );
  fireEvent.click(group.navigation.getByRole("button", { name: "生日提醒" }));
  expect(
    (group.getByLabelText("合成群二接收生日提醒") as HTMLInputElement).checked,
  ).toBe(true);
  expect(patch).not.toHaveBeenCalled();
});

test.each(["work", "birthday"] as const)(
  "own channel metadata adoption never rebases an existing dirty %s draft",
  async (scope) => {
    const { get, patch } = mount();
    await screen.findAllByText("作品 1 类 · 工作 2 项");
    const group = openGroupControls("合成群一");
    const section = scope === "work" ? "工作提醒" : "生日提醒";
    const reminder =
      scope === "work" ? "72 小时未交稿" : "合成群一接收生日提醒";
    const save = scope === "work" ? "保存工作提醒" : "保存生日订阅";
    fireEvent.click(group.navigation.getByRole("button", { name: section }));
    const reminderControls =
      scope === "work"
        ? within(await group.findByRole("form", { name: "合成群一的工作提醒" }))
        : group;
    fireEvent.click(await reminderControls.findByLabelText(reminder));
    const fresh = { ...channel, revision: 4 };
    const read = get.getMockImplementation() as unknown as (
      path: string,
      options: unknown,
    ) => unknown;
    get.mockImplementation((async (path: string, options: never) =>
      path === "/api/notifications/configuration"
        ? reply({
            ...configuration,
            channels: [fresh, configuration.channels[1]],
          })
        : path === "/api/notifications/work-reminders"
          ? reply({
              ...work,
              channels: work.channels.map((item) => ({ ...item, revision: 4 })),
            })
          : path === "/api/birthdays/subscriptions"
            ? reply(birthdayChannels.map((item) => ({ ...item, revision: 4 })))
            : read(path as never, options)) as never);
    patch.mockImplementation((async (path: string) =>
      path === "/api/notifications/channels/{id}"
        ? reply(fresh)
        : reply({}, 409)) as never);
    fireEvent.click(group.navigation.getByRole("button", { name: "作品通知" }));
    fireEvent.click(group.footer.getByRole("button", { name: "保存群设置" }));
    await group.findByText("配置已保存");
    fireEvent.click(group.navigation.getByRole("button", { name: section }));
    fireEvent.click(group.footer.getByRole("button", { name: save }));
    await group.findByText(
      scope === "work" ? /群订阅已变化/ : /生日订阅已变化/,
    );
    expect(patch.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ expectedChannelRevision: 3 }),
      }),
    );
    expect(
      (reminderControls.getByLabelText(reminder) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(
      group.getByRole("button", { name: "保留草稿并以当前版本重试" }),
    );
    patch.mockResolvedValue(reply({}) as never);
    fireEvent.click(group.footer.getByRole("button", { name: save }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(3));
    expect(patch.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ expectedChannelRevision: 4 }),
      }),
    );
  },
);

test("discarding a new unsaved group also preserves existing group scope drafts", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群一" }));
  fireEvent.click(screen.getByRole("button", { name: "工作提醒" }));
  fireEvent.click(
    within(
      await screen.findByRole("form", { name: "合成群一的工作提醒" }),
    ).getByLabelText("72 小时未交稿"),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭群设置" }));
  fireEvent.click(screen.getByRole("button", { name: "新增群目标" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "新群草稿" },
  });
  fireEvent.click(screen.getByRole("button", { name: "放弃草稿" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑 合成群一" }));
  fireEvent.click(screen.getByRole("button", { name: "工作提醒" }));
  expect(
    (
      within(
        await screen.findByRole("form", { name: "合成群一的工作提醒" }),
      ).getByLabelText("72 小时未交稿") as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test("confirmed channel DTO fields do not leak into the next general PATCH", async () => {
  const { patch } = mount();
  patch.mockResolvedValue(
    reply({ ...channel, revision: 4, audienceGeneration: 2 }) as never,
  );
  fireEvent.click(await screen.findByRole("button", { name: "编辑 合成群一" }));
  fireEvent.click(screen.getByRole("button", { name: "保存群设置" }));
  await screen.findByText("配置已保存");
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "再次修改" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存群设置" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  const body = (patch.mock.calls[1][1] as { body: object }).body;
  expect(body).toMatchObject({ expectedRevision: 4, name: "再次修改" });
  expect(body).not.toHaveProperty("revision");
  expect(body).not.toHaveProperty("audienceGeneration");
});
