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
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client } from "../account/api";
import { SystemManagementPage } from "../system/SystemManagementPage";

const settings = {
  revision: 1,
  displayEnabled: true,
  remindersEnabled: true,
  sendTime: "09:00",
  offsetDays: [0],
};
const configuration = {
  enabled: true,
  configurationError: null,
  connections: [{ key: "existing", name: "已配置连接", available: true }],
  eventTypes: [],
  templates: [],
  channels: [],
};
const reply = (data: unknown) => ({ data, response: new Response() });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function openPage(url = "/settings/system?tab=notifications") {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
  ) =>
    reply(
      path === "/api/birthdays/settings"
        ? {
            available: true,
            settings,
            personCount: 8,
            lastCheckedAt: null,
            dataUpdatedAt: null,
          }
        : path === "/api/birthdays/subscriptions"
          ? [
              {
                id: "group",
                name: "已有目标",
                groupId: "12345",
                connectionKey: "existing",
                enabled: true,
                revision: 2,
                birthdayEnabled: true,
                birthdayRevision: 1,
              },
            ]
          : path === "/api/birthdays/template"
            ? { note: "生日快乐", revision: 2 }
            : path === "/api/notifications/configuration"
              ? configuration
              : path === "/api/notifications/deliveries"
                ? {
                    items: [
                      {
                        id: "delivery",
                        channelName: "已有目标",
                        eventId: "event",
                        eventType: "birthday.reminder",
                        resourceKind: "birthday_digest",
                        birthday: {
                          sendLocalDate: "2026-11-11",
                          targetLocalDate: "2026-11-18",
                          offsetDays: 7,
                          count: 3,
                        },
                        workId: null,
                        workNumber: null,
                        status: "accepted",
                        revision: 1,
                        createdAt: "2026-11-11T01:00:00Z",
                        groupId: "12345",
                        connectionKey: "existing",
                        contentText: "生日摘要",
                        attempts: 1,
                        errorCode: null,
                        providerMessageId: "receipt",
                        resolvedAt: null,
                      },
                    ],
                    nextCursor: null,
                  }
                : path === "/api/source-fetch/runs"
                  ? { items: [], nextCursor: null }
                  : [],
    )) as never);
  const view = render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            element={<Outlet context={{ permissions: ["system:manage"] }} />}
          >
            <Route path="/settings/system" element={<SystemManagementPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { cache, get, ...view };
}

test("birthday panels preserve existing group and birthday drafts and pause reads outside their tabs", async () => {
  const { cache, get } = openPage();
  await screen.findByLabelText("已有目标的生日提醒");
  expect(
    get.mock.calls.some(
      (call) =>
        call[0] === "/api/birthdays/template" ||
        call[0] === "/api/birthdays/settings",
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "新增群目标" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "原通知未保存草稿" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "角色生日" }));
  fireEvent.change(await screen.findByLabelText("提醒时刻"), {
    target: { value: "10:15" },
  });
  const settingsReads = get.mock.calls.filter(
    (call) => call[0] === "/api/birthdays/settings",
  ).length;
  fireEvent.click(screen.getByRole("tab", { name: "推送通知" }));
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "原通知未保存草稿",
  );
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ["birthdays", "settings"] });
  });
  expect(
    get.mock.calls.filter((call) => call[0] === "/api/birthdays/settings"),
  ).toHaveLength(settingsReads);
  fireEvent.click(screen.getByRole("tab", { name: "消息模板" }));
  fireEvent.change(await screen.findByLabelText("生日提示语"), {
    target: { value: "未保存生日祝福" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "角色生日" }));
  expect((screen.getByLabelText("提醒时刻") as HTMLInputElement).value).toBe(
    "10:15",
  );
  fireEvent.click(screen.getByRole("tab", { name: "推送通知" }));
  expect((screen.getByLabelText("生日提示语") as HTMLInputElement).value).toBe(
    "未保存生日祝福",
  );
});

test("birthday delivery history reads the true resource kind and frozen digest metadata", async () => {
  openPage();
  fireEvent.click(screen.getByRole("tab", { name: "投递记录" }));
  expect(
    await screen.findByText("2026-11-18 · 3 位角色 · 提前 7 天"),
  ).toBeTruthy();
  expect(screen.queryByText("合成测试")).toBeNull();
  await waitFor(() =>
    expect(screen.getByText("角色生日", { selector: "strong" })).toBeTruthy(),
  );
});
