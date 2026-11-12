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
import {
  WorkReminderSubscriptions,
  WorkReminderTemplate,
} from "./WorkReminderPanels";

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
      <WorkReminderSubscriptions enabled={enabled && !template} />
      <WorkReminderTemplate enabled={enabled && template} onEdit={() => {}} />
    </QueryClientProvider>
  );
  return { cache, get, patch, post, wrap };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect((get.mock.calls[1][1] as { signal: AbortSignal }).signal.aborted).toBe(
    false,
  );
  view.rerender(wrap(false));
  expect(get).toHaveBeenCalledTimes(2);
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
  await screen.findByText(/可以开始校对/, { selector: "pre" });
  expect(screen.getByText(/独立发送任务交接提醒/)).toBeTruthy();
  const previewBodies = post.mock.calls.map(
    (call) => (call[1] as { body: { kind: string; note?: string } }).body,
  );
  expect(previewBodies).toContainEqual({ kind: "digest", note: "新提示" });
  expect(previewBodies).toContainEqual({ kind: "ready" });
  expect(previewBodies.filter((body) => body?.kind === "ready")).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByRole("button", { name: "添加时段" }));
  expect((screen.getByLabelText("北京时间 3") as HTMLInputElement).value).toBe(
    "12:00",
  );
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  fireEvent.click(screen.getByRole("button", { name: "保存工作提醒" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: {
      enabled: false,
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
  fireEvent.click(within(form).getByRole("button", { name: "保存群提醒" }));
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
  fireEvent.click(within(form).getByRole("button", { name: "保存群提醒" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1][1]).toMatchObject({
    body: {
      expectedRevision: 4,
      expectedChannelRevision: 4,
      digestEnabled: true,
    },
  });
});

test("template is a read-only preview and ordinary save failures never offer stale revision adoption", async () => {
  const { patch, wrap } = setup();
  const view = render(wrap(true, true));
  const panel = screen.getByRole("region", { name: "工作提醒模板" });
  await within(panel).findByText(/原提示/, { selector: "pre" });
  await within(panel).findByText(/可以开始校对/, { selector: "pre" });
  expect(within(panel).queryByText(/合并发送/)).toBeNull();
  expect(within(panel).queryByRole("textbox")).toBeNull();
  view.rerender(wrap(true));
  const form = await screen.findByRole("form", { name: "合成群的工作提醒" });
  patch.mockRejectedValueOnce(new Error("网络断开"));
  fireEvent.click(within(form).getByLabelText("任务交接提醒"));
  fireEvent.click(within(form).getByRole("button", { name: "保存群提醒" }));
  await within(form).findByText("网络断开");
  expect(within(form).queryByRole("button", { name: /当前版本/ })).toBeNull();
  expect(
    (within(form).getByLabelText("任务交接提醒") as HTMLInputElement).checked,
  ).toBe(true);
});

test("hidden preview requests cancel both kinds without cancelling the newly active panel", async () => {
  const { post, wrap } = setup();
  const requests: {
    body: { kind: string; note?: string };
    signal: AbortSignal;
  }[] = [];
  post.mockImplementation((_path, options) => {
    requests.push(options as (typeof requests)[number]);
    return new Promise(() => {});
  });
  const view = render(wrap(true));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.map((request) => request.body.kind).sort()).toEqual([
    "digest",
    "ready",
  ]);
  view.rerender(wrap(true, true));
  await waitFor(() => expect(requests).toHaveLength(4));
  expect(requests.slice(0, 2).every((request) => request.signal.aborted)).toBe(
    true,
  );
  expect(requests.slice(2).every((request) => !request.signal.aborted)).toBe(
    true,
  );
  view.rerender(wrap(false));
  await waitFor(() =>
    expect(requests.every((request) => request.signal.aborted)).toBe(true),
  );
});
