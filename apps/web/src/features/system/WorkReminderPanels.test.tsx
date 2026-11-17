// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { WorkReminderSubscriptions } from "./WorkReminderPanels";
import { useWorkReminderConfiguration } from "./use-work-reminder-configuration";

function configuration(revision = 1) {
  return {
    settings: {
      enabled: false,
      sendTimes: ["09:00", "18:00"],
      note: "原提示",
      revision,
    },
    channels: [
      {
        id: "group1",
        name: "合成群",
        groupId: "123",
        connectionKey: "bot",
        enabled: false,
        revision,
        subscription: {
          revision,
          digestEnabled: false,
          readyEnabled: false,
          overdueEnabled: false,
          mentionsEnabled: true,
        },
      },
    ],
  };
}
const ok = (data: unknown) => ({ data, response: new Response() }) as never;
function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15000 } },
  });
  const get = vi.spyOn(client, "GET").mockResolvedValue(ok(configuration()));
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(ok(configuration()));
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (_path, options) =>
      ok({
        text:
          (options as { body: { kind: string } }).body.kind === "ready"
            ? "【任务交接提醒】\n#12 合成作品\n可以开始校对"
            : `【工作摘要】\n翻译10部（待认领4）\n${(options as { body: { note: string } }).body.note}`,
      }),
    );
  const wrap = (enabled: boolean, template = false) => (
    <QueryClientProvider client={cache}>
      <WorkReminderSubscriptions
        enabled={enabled}
        mode={template ? "channel" : "all"}
        selectedId="group1"
      />
    </QueryClientProvider>
  );
  return { cache, get, patch, post, wrap };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each([false, true])(
  "pending work reads abort only after their final active observer hides (shared=%s)",
  async (shared) => {
    let signal: AbortSignal | undefined;
    vi.spyOn(client, "GET").mockImplementation(((
      _path: unknown,
      options: { signal: AbortSignal },
    ) => {
      signal = options.signal;
      return new Promise(() => {});
    }) as never);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Reader({ enabled }: { enabled: boolean }) {
      useWorkReminderConfiguration(enabled, "subscriptions");
      return null;
    }
    const panel = (enabled: boolean) => (
      <QueryClientProvider client={cache}>
        <Reader enabled={enabled} />
        {shared && <Reader enabled />}
      </QueryClientProvider>
    );
    const view = render(panel(true));
    await waitFor(() => expect(signal).toBeTruthy());
    view.rerender(panel(false));
    await waitFor(() => expect(signal!.aborted).toBe(!shared));
  },
);

test("hidden panels do not read; tab changes cannot cancel the other panel request", async () => {
  const { get, wrap } = setup();
  const view = render(wrap(false));
  expect(get).not.toHaveBeenCalled();
  view.rerender(wrap(true));
  await screen.findByLabelText("启用工作提醒");
  expect(get).toHaveBeenCalledTimes(1);
  expect((get.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(
    false,
  );
  view.rerender(wrap(true, true));
  await screen.findByRole("form", { name: "合成群的工作提醒" });
  expect(get).toHaveBeenCalledTimes(1);
  expect((get.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(
    false,
  );
  view.rerender(wrap(false));
  expect(get).toHaveBeenCalledTimes(1);
});

test("one settings editor saves times and note together with automatic server-rendered preview", async () => {
  const { patch, post, wrap } = setup();
  render(wrap(true));
  const note = await screen.findByLabelText("工作摘要提示语");
  fireEvent.change(note, { target: { value: "新提示" } });
  fireEvent.change(screen.getByLabelText("北京时间 1"), {
    target: { value: "10:00" },
  });
  await screen.findByText(/新提示/, { selector: "pre" });
  fireEvent.click(screen.getByRole("combobox", { name: "预览消息" }));
  fireEvent.click(screen.getByRole("option", { name: "任务交接提醒" }));
  await screen.findByText(/可以开始校对/, { selector: "pre" });
  expect(screen.getByText(/预认领任务具备制作条件后/)).toBeTruthy();
  const previewBodies = post.mock.calls.map(
    (call) => (call[1] as { body: { kind: string; note?: string } }).body,
  );
  expect(previewBodies).toContainEqual({ kind: "digest", note: "新提示" });
  expect(previewBodies).toContainEqual({ kind: "ready" });
  expect(previewBodies.filter((body) => body?.kind === "ready")).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByLabelText("启用工作提醒"));
  expect(patch).not.toHaveBeenCalled();
  const group = screen.getByRole("form", { name: "合成群的工作提醒" });
  expect(
    (within(group).getByLabelText("每日摘要") as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "添加时段" }));
  expect((screen.getByLabelText("北京时间 3") as HTMLInputElement).value).toBe(
    "12:00",
  );
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  fireEvent.click(screen.getByRole("button", { name: "保存工作提醒" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: {
      enabled: true,
      sendTimes: ["10:00", "18:00"],
      note: "新提示",
      expectedRevision: 1,
    },
  });
  expect(
    post.mock.calls.every(
      (call) => call[0] === "/api/notifications/work-reminders/preview",
    ),
  ).toBe(true);
});

test("settings CAS conflict retains fields and requires explicit version adoption", async () => {
  const { get, patch, wrap } = setup();
  render(wrap(true));
  fireEvent.change(await screen.findByLabelText("工作摘要提示语"), {
    target: { value: "草稿" },
  });
  get.mockResolvedValue(
    ok({
      ...configuration(2),
      settings: { ...configuration(2).settings, note: "别人保存" },
    }),
  );
  patch.mockResolvedValueOnce({
    response: new Response(null, { status: 409 }),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存工作提醒" }));
  const retry = await screen.findByRole("button", {
    name: "保留草稿并以当前版本重试",
  });
  expect(
    (screen.getByLabelText("工作摘要提示语") as HTMLInputElement).value,
  ).toBe("草稿");
  expect(screen.getByText(/当前设置：.*别人保存/)).toBeTruthy();
  expect(patch).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  fireEvent.click(screen.getByRole("button", { name: "保存工作提醒" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][1]).toMatchObject({
    body: { expectedRevision: 2, note: "草稿" },
  });
});

test("group CAS keeps draft and compares both channel and subscription revisions", async () => {
  const { get, patch, wrap } = setup();
  render(wrap(true));
  const form = await screen.findByRole("form", { name: "合成群的工作提醒" });
  expect(within(form).getByText(/群推送已关闭/)).toBeTruthy();
  fireEvent.click(within(form).getByLabelText("每日摘要"));
  get.mockResolvedValue(ok(configuration(4)));
  patch.mockResolvedValueOnce({
    response: new Response(null, { status: 409 }),
  } as never);
  fireEvent.click(within(form).getByRole("button", { name: "保存工作提醒" }));
  const adopt = await within(form).findByRole("button", {
    name: "保留草稿并以当前版本重试",
  });
  expect(
    (within(form).getByLabelText("每日摘要") as HTMLInputElement).checked,
  ).toBe(true);
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: {
      expectedRevision: 1,
      expectedChannelRevision: 1,
      digestEnabled: true,
      readyEnabled: false,
      overdueEnabled: false,
      mentionsEnabled: true,
    },
  });
  fireEvent.click(adopt);
  fireEvent.click(within(form).getByRole("button", { name: "保存工作提醒" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][1]).toMatchObject({
    body: {
      expectedRevision: 4,
      expectedChannelRevision: 4,
      digestEnabled: true,
    },
  });
});

test("ordinary group save failures preserve drafts without offering stale revision adoption", async () => {
  const { patch, wrap } = setup();
  render(wrap(true));
  const form = await screen.findByRole("form", { name: "合成群的工作提醒" });
  patch.mockRejectedValueOnce(new Error("网络断开"));
  fireEvent.click(within(form).getByLabelText("任务交接提醒"));
  fireEvent.click(within(form).getByRole("button", { name: "保存工作提醒" }));
  await within(form).findByText("网络断开");
  expect(within(form).queryByRole("button", { name: /当前版本/ })).toBeNull();
  expect(
    (within(form).getByLabelText("任务交接提醒") as HTMLInputElement).checked,
  ).toBe(true);
});

test("group work reminder reads expose an error and an explicit retry", async () => {
  const { get, patch, wrap } = setup();
  get.mockRejectedValueOnce(new Error("合成读取失败"));
  render(wrap(true, true));
  const panel = screen.getByRole("region", { name: "工作提醒设置" });
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toContain("工作提醒读取失败");
  expect(within(panel).queryByRole("form")).toBeNull();
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  await within(panel).findByRole("form", { name: "合成群的工作提醒" });
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(get).toHaveBeenCalledTimes(2);
  expect(patch).not.toHaveBeenCalled();
});

test.each(["http", "network"])(
  "a clean group save retains its latest channel revision after a %s failure",
  async (failure) => {
    const { cache, patch, wrap } = setup();
    render(wrap(true, true));
    const form = await screen.findByRole("form", { name: "合成群的工作提醒" });
    const updated = configuration();
    updated.channels[0].revision = 4;
    cache.setQueryData(["work-reminders", "subscriptions"], updated);
    await waitFor(() =>
      expect(
        cache.getQueryData<typeof updated>(["work-reminders", "subscriptions"])
          ?.channels[0].revision,
      ).toBe(4),
    );
    if (failure === "http")
      patch.mockResolvedValueOnce({
        error: { message: "合成保存失败" },
        response: new Response(null, { status: 500 }),
      } as never);
    else patch.mockRejectedValueOnce(new Error("合成网络断开"));
    fireEvent.click(within(form).getByRole("button", { name: "保存工作提醒" }));
    await within(form).findByRole("alert");
    expect(patch.mock.calls[0][1]).toMatchObject({
      body: { expectedChannelRevision: 4, expectedRevision: 1 },
    });
    fireEvent.click(within(form).getByRole("button", { name: "保存工作提醒" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1][1]).toMatchObject({
      body: { expectedChannelRevision: 4, expectedRevision: 1 },
    });
  },
);

test("preview switches display one server-rendered kind and cancel inactive requests", async () => {
  const { post, wrap } = setup();
  const requests: { body: { kind: string }; signal: AbortSignal }[] = [];
  post.mockImplementation((_path, options) => {
    requests.push(options as (typeof requests)[number]);
    return new Promise(() => {});
  });
  const view = render(wrap(true));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].body.kind).toBe("digest");
  fireEvent.click(screen.getByRole("combobox", { name: "预览消息" }));
  fireEvent.click(screen.getByRole("option", { name: "任务交接提醒" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests[1].body.kind).toBe("ready");
  expect(requests[1].signal.aborted).toBe(false);
  view.rerender(wrap(false));
  await waitFor(() =>
    expect(requests.every((request) => request.signal.aborted)).toBe(true),
  );
});
