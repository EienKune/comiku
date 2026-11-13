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
import { MemoryRouter } from "react-router";
import { client } from "../account/api";
import { BirthdayStrip } from "./BirthdayStrip";
import { BirthdaySettings } from "./BirthdaySettings";
import { BirthdayReminderSettings } from "./BirthdayReminderSettings";
import {
  BirthdaySubscriptions,
  BirthdayTemplate,
} from "./BirthdayNotificationPanels";
import type { ReactNode } from "react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const person = (key: string, name: string, overrides = {}) => ({
  key,
  name,
  aliases: [],
  month: 11,
  day: 11,
  avatarUrl: "https://example.invalid/avatar.webp",
  nextDate: "2026-11-11",
  daysUntil: 0,
  ...overrides,
});
const summary = {
  enabled: true,
  today: "2026-11-11",
  windowEnd: "2026-11-18",
  timezone: "Asia/Shanghai",
  people: [
    person("one", "星野", { aliases: ["ホシノ", "Hoshino"] }),
    person("two", "👩‍🚀测试"),
  ],
};
const settings = {
  revision: 4,
  displayEnabled: true,
  remindersEnabled: true,
  sendTime: "09:00",
  offsetDays: [0],
};
const reply = (data: unknown, status = 200) => ({
  data,
  response: new Response(null, { status }),
});
function mount(children: ReactNode) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return {
    ...render(
      <QueryClientProvider client={cache}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>,
    ),
    cache,
  };
}

test("a visible birthday strip changes its date at Shanghai midnight without regular polling", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T15:59:59Z"));
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(reply(summary) as never);
  mount(<BirthdayStrip />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(900);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(get).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(get).toHaveBeenCalledTimes(2);
});

test("summary keeps all same-day people, original avatars and grapheme fallback; calendar is lazy and searchable by aliases", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
  ) =>
    reply(
      path.endsWith("calendar")
        ? {
            ...summary,
            people: [
              ...summary.people,
              person("unknown", "未知学生", {
                month: null,
                day: null,
                nextDate: null,
                daysUntil: null,
              }),
            ],
          }
        : summary,
    )) as never);
  mount(<BirthdayStrip />);
  await screen.findByText("星野");
  expect(screen.getAllByText("今天 · 11 月 11 日")).toHaveLength(2);
  expect(get).toHaveBeenCalledTimes(1);
  const avatar = screen.getByRole("img", { name: "👩‍🚀测试的头像" });
  expect(avatar.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.invalid/avatar.webp",
  );
  fireEvent.error(avatar.querySelector("img")!);
  expect(avatar.textContent).toBe("👩‍🚀");
  fireEvent.click(screen.getByRole("button", { name: "全部生日" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    await within(dialog).findByText("生日未知", { selector: "h3" }),
  ).toBeTruthy();
  fireEvent.change(within(dialog).getByRole("searchbox"), {
    target: { value: "ホシノ" },
  });
  expect(within(dialog).getByText("星野")).toBeTruthy();
  expect(within(dialog).queryByText("👩‍🚀测试")).toBeNull();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "全部生日" }),
  );
});

test("rail supports horizontal arrows and Home/End", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(reply(summary) as never);
  mount(<BirthdayStrip />);
  const rail = await screen.findByRole("region", {
    name: "近期生日，可左右滚动",
  });
  const scroll = vi.fn();
  Object.defineProperty(rail, "scrollTo", { value: scroll });
  Object.defineProperty(rail, "scrollWidth", { value: 1200 });
  Object.defineProperty(rail, "clientWidth", { value: 300 });
  fireEvent.keyDown(rail, { key: "End" });
  expect(scroll).toHaveBeenLastCalledWith({ left: 900, behavior: "smooth" });
  fireEvent.keyDown(rail, { key: "Home" });
  expect(scroll).toHaveBeenLastCalledWith({ left: 0, behavior: "smooth" });
  fireEvent.keyDown(rail, { key: "ArrowRight" });
  expect(scroll).toHaveBeenLastCalledWith({ left: 210, behavior: "smooth" });
});

test("disabled, empty, failed and background summaries remain silent; inactive panels do not read", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(reply({ ...summary, enabled: false }) as never);
  const view = mount(<BirthdayStrip enabled={false} />);
  expect(get).not.toHaveBeenCalled();
  view.rerender(
    <QueryClientProvider client={view.cache}>
      <MemoryRouter>
        <BirthdayStrip />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  expect(screen.queryByLabelText("角色生日")).toBeNull();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => {
    await view.cache.invalidateQueries({ queryKey: ["birthdays"] });
  });
  expect(get).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

test("settings retain draft across background reads and submit revision fence; sync failures do not surface", async () => {
  const get = vi.spyOn(client, "GET").mockResolvedValue(
    reply({
      available: true,
      settings,
      personCount: 10,
      lastCheckedAt: null,
      dataUpdatedAt: null,
    }) as never,
  );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(
      reply({ ...settings, revision: 5, sendTime: "10:30" }) as never,
    );
  vi.spyOn(client, "POST").mockRejectedValue(
    new Error("private upstream synchronization detail"),
  );
  const view = mount(
    <>
      <BirthdaySettings />
      <BirthdayReminderSettings enabled />
    </>,
  );
  fireEvent.change(await screen.findByLabelText("提醒时刻"), {
    target: { value: "10:30" },
  });
  get.mockResolvedValue(
    reply({
      available: true,
      settings: { ...settings, revision: 8, sendTime: "12:00" },
      personCount: 12,
    }) as never,
  );
  await act(async () => {
    await view.cache.invalidateQueries({ queryKey: ["birthdays", "settings"] });
  });
  expect((screen.getByLabelText("提醒时刻") as HTMLInputElement).value).toBe(
    "10:30",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存生日提醒" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("/api/birthdays/settings", {
      body: {
        expectedRevision: 4,
        displayEnabled: true,
        remindersEnabled: true,
        sendTime: "10:30",
        offsetDays: [0],
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "手动同步" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "手动同步" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(screen.queryByText(/private upstream/)).toBeNull();
});

test("birthday subscriptions reuse channel targets and send independent revision fences", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    reply([
      {
        id: "channel",
        name: "既有群",
        groupId: "12345",
        connectionKey: "existing",
        enabled: true,
        revision: 9,
        birthdayEnabled: false,
        birthdayRevision: 3,
      },
    ]) as never,
  );
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue(reply({}) as never);
  mount(<BirthdaySubscriptions enabled />);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "既有群的生日提醒" }),
  );
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("/api/birthdays/subscriptions/{id}", {
      params: { path: { id: "channel" } },
      body: {
        expectedChannelRevision: 9,
        expectedScopeRevision: 3,
        enabled: true,
      },
    }),
  );
});

test("birthday template preserves draft conflicts and previews only real saved server text", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation((async (path: string) =>
      reply(
        path.endsWith("preview")
          ? { text: "真实生日摘要" }
          : { note: "生日快乐", revision: 2 },
      )) as never);
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(reply({}, 409) as never);
  mount(<BirthdayTemplate enabled />);
  fireEvent.click(await screen.findByRole("button", { name: "预览生日消息" }));
  expect(await screen.findByText("真实生日摘要")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("生日提示语"), {
    target: { value: "新的祝福" },
  });
  expect(screen.queryByText("真实生日摘要")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "预览生日消息" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存生日模板" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("/api/birthdays/template", {
      body: { expectedRevision: 2, note: "新的祝福" },
    }),
  );
  expect((screen.getByLabelText("生日提示语") as HTMLInputElement).value).toBe(
    "新的祝福",
  );
  get.mockResolvedValue(reply({ note: "其他管理员", revision: 4 }) as never);
  fireEvent.click(
    await screen.findByRole("button", { name: "核对当前生日模板" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "保留提示语并采用当前版本" }),
  );
  patch.mockResolvedValue(reply({ note: "新的祝福", revision: 5 }) as never);
  fireEvent.click(screen.getByRole("button", { name: "保存生日模板" }));
  await waitFor(() =>
    expect(patch).toHaveBeenLastCalledWith("/api/birthdays/template", {
      body: { expectedRevision: 4, note: "新的祝福" },
    }),
  );
});

test.each(["empty", "failure"])(
  "%s summaries quietly hide the strip",
  async (mode) => {
    const get = vi.spyOn(client, "GET");
    if (mode === "empty")
      get.mockResolvedValue(reply({ ...summary, people: [] }) as never);
    else get.mockRejectedValue(new Error("technical private detail"));
    mount(<BirthdayStrip />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("角色生日")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

test("a preview completed after hiding the panel cannot populate the editor", async () => {
  let resolvePreview!: (value: ReturnType<typeof reply>) => void;
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
  ) =>
    path.endsWith("preview")
      ? new Promise((resolve) => {
          resolvePreview = resolve;
        })
      : reply({ note: "生日快乐", revision: 1 })) as never);
  const view = mount(<BirthdayTemplate enabled />);
  fireEvent.click(await screen.findByRole("button", { name: "预览生日消息" }));
  await waitFor(() => expect(resolvePreview).toBeTruthy());
  view.rerender(
    <QueryClientProvider client={view.cache}>
      <MemoryRouter>
        <BirthdayTemplate enabled={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(async () => {
    resolvePreview(reply({ text: "过期的消息预览" }));
  });
  expect(screen.queryByText("过期的消息预览")).toBeNull();
  const count = get.mock.calls.length;
  await act(async () => {
    await view.cache.invalidateQueries({ queryKey: ["birthdays"] });
  });
  expect(get).toHaveBeenCalledTimes(count);
});

test("settings conflict requires explicit current-version adoption before retrying preserved fields", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(
      reply({ available: true, settings, personCount: 8 }) as never,
    );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(reply({}, 409) as never);
  mount(<BirthdayReminderSettings enabled />);
  fireEvent.change(await screen.findByLabelText("提醒时刻"), {
    target: { value: "10:45" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存生日提醒" }));
  fireEvent.click(await screen.findByRole("button", { name: "核对当前设置" }));
  await waitFor(() =>
    expect(
      get.mock.calls.filter((call) => call[0] === "/api/birthdays/settings"),
    ).toHaveLength(2),
  );
  get.mockResolvedValue(
    reply({
      available: true,
      settings: {
        ...settings,
        revision: 9,
        sendTime: "11:30",
        displayEnabled: false,
      },
      personCount: 8,
    }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "核对当前设置" }));
  await screen.findByText(/11:30/);
  expect((screen.getByLabelText("提醒时刻") as HTMLInputElement).value).toBe(
    "10:45",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "保留草稿并采用当前版本" }),
  );
  patch.mockResolvedValue(
    reply({
      ...settings,
      revision: 10,
      sendTime: "10:45",
      displayEnabled: false,
    }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存生日提醒" }));
  await waitFor(() =>
    expect(patch).toHaveBeenLastCalledWith("/api/birthdays/settings", {
      body: {
        expectedRevision: 9,
        displayEnabled: false,
        remindersEnabled: true,
        sendTime: "10:45",
        offsetDays: [0],
      },
    }),
  );
});

test("sequential scope saves use current server fields without restoring the other scope", async () => {
  let server = { ...settings };
  vi.spyOn(client, "GET").mockImplementation((async (path: string) =>
    reply(
      path === "/api/birthdays/settings"
        ? { available: true, settings: server, personCount: 8 }
        : [],
    )) as never);
  const patch = vi.spyOn(client, "PATCH").mockImplementation((async (
    _path: string,
    input: { body: typeof settings & { expectedRevision: number } },
  ) => {
    const { expectedRevision, ...fields } = input.body;
    expect(expectedRevision).toBe(server.revision);
    server = { ...server, ...fields, revision: server.revision + 1 };
    return reply(server);
  }) as never);
  mount(
    <>
      <BirthdaySettings />
      <BirthdayReminderSettings enabled />
    </>,
  );
  fireEvent.click(await screen.findByLabelText("启用工作台生日"));
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText("工作台展示已保存。");
  fireEvent.change(screen.getByLabelText("提醒时刻"), {
    target: { value: "10:15" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存生日提醒" }));
  await screen.findByText("生日提醒已保存。");
  expect(patch).toHaveBeenLastCalledWith("/api/birthdays/settings", {
    body: {
      expectedRevision: 5,
      displayEnabled: false,
      remindersEnabled: true,
      sendTime: "10:15",
      offsetDays: [0],
    },
  });
  fireEvent.click(screen.getByLabelText("启用工作台生日"));
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(3));
  expect(patch).toHaveBeenLastCalledWith("/api/birthdays/settings", {
    body: {
      expectedRevision: 6,
      displayEnabled: true,
      remindersEnabled: true,
      sendTime: "10:15",
      offsetDays: [0],
    },
  });
});

test("display conflicts preserve only the display draft and adopt the latest reminder fields", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(
      reply({ available: true, settings, personCount: 8 }) as never,
    );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(reply({}, 409) as never);
  mount(<BirthdaySettings />);
  expect(screen.queryByLabelText("提醒时刻")).toBeNull();
  expect(screen.queryByLabelText("启用生日提醒")).toBeNull();
  fireEvent.click(await screen.findByLabelText("启用工作台生日"));
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByRole("button", { name: "核对当前设置" });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  expect(patch).toHaveBeenCalledTimes(1);
  get.mockResolvedValue(
    reply({
      available: true,
      settings: {
        ...settings,
        revision: 9,
        remindersEnabled: false,
        sendTime: "11:30",
        offsetDays: [1, 7],
      },
      personCount: 8,
    }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "核对当前设置" }));
  await screen.findByText(/11:30/);
  expect(
    (screen.getByLabelText("启用工作台生日") as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "保留草稿并采用当前版本" }),
  );
  expect(patch).toHaveBeenCalledTimes(1);
  patch.mockResolvedValue(
    reply({
      ...settings,
      revision: 10,
      displayEnabled: false,
      remindersEnabled: false,
      sendTime: "11:30",
      offsetDays: [1, 7],
    }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch).toHaveBeenLastCalledWith("/api/birthdays/settings", {
    body: {
      expectedRevision: 9,
      displayEnabled: false,
      remindersEnabled: false,
      sendTime: "11:30",
      offsetDays: [1, 7],
    },
  });
});

test("saving without a draft takes owned fields and revision from the same cache snapshot", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    reply({ available: true, settings, personCount: 8 }) as never,
  );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(reply(settings) as never);
  const { cache } = mount(<BirthdayReminderSettings enabled />);
  await screen.findByLabelText("提醒时刻");
  act(() => {
    cache.setQueryData(["birthdays", "settings"], {
      available: true,
      personCount: 8,
      settings: {
        ...settings,
        revision: 9,
        remindersEnabled: false,
        sendTime: "11:30",
        offsetDays: [7],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存生日提醒" }));
  });
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(patch).toHaveBeenCalledWith("/api/birthdays/settings", {
    body: {
      expectedRevision: 9,
      displayEnabled: true,
      remindersEnabled: false,
      sendTime: "11:30",
      offsetDays: [7],
    },
  });
});
