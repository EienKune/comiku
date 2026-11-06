import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client } from "../account/api";
import { SystemManagementPage } from "./SystemManagementPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function openPage(permissions: string[], url = "/settings/system") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route element={<Outlet context={{ permissions }} />}>
            <Route path="/settings/system" element={<SystemManagementPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("a source user cannot open technical management or request its history", () => {
  const get = vi.spyOn(client, "GET");
  openPage(["candidates:read", "candidates:manage"]);
  expect(screen.getByRole("heading", { name: "无权访问" })).toBeTruthy();
  expect(get).not.toHaveBeenCalled();
});

test("a system administrator can read collection history in the dedicated page", async () => {
  vi.spyOn(client, "GET").mockImplementation((async (path: string) => ({
    data: path.endsWith("/configuration")
      ? {
          enabled: false,
          configurationError: null,
          connections: [],
          eventTypes: [],
          channels: [],
        }
      : path.endsWith("/deliveries")
        ? { items: [], nextCursor: null }
        : [],
    response: new Response(),
  })) as never);
  openPage(["system:manage"]);
  expect(screen.getByRole("heading", { name: "系统管理" })).toBeTruthy();
  expect(await screen.findByText("暂无同步记录。")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "图源采集" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "推送通知" })).toBeNull();
});

function mockManagement() {
  return vi.spyOn(client, "GET").mockImplementation((async (path: string) => ({
    data: path.endsWith("/configuration")
      ? {
          enabled: false,
          configurationError: null,
          connections: [{ key: "bot", name: "测试连接", available: true }],
          eventTypes: [{ type: "imported", label: "导入作品" }],
          channels: [],
        }
      : path.endsWith("/deliveries")
        ? { items: [], nextCursor: null }
        : [],
    response: new Response(),
  })) as never);
}

test("collection is the default tab and never requests notification data", async () => {
  const get = mockManagement();
  openPage(["system:manage"]);
  await screen.findByText("暂无同步记录。");
  expect(
    screen.getByRole("tab", { name: "图源采集" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    get.mock.calls.every((call) => call[0] === "/api/source-fetch/runs"),
  ).toBe(true);
});

test("notification URL opens only its panel and preserves drafts across tabs", async () => {
  const get = mockManagement();
  openPage(["system:manage"], "/settings/system?tab=notifications&keep=yes");
  fireEvent.click(await screen.findByRole("button", { name: "新增群目标" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "未保存草稿" },
  });
  expect(
    get.mock.calls.some((call) => call[0] === "/api/source-fetch/runs"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "图源采集" }));
  expect(screen.queryByRole("textbox", { name: "名称" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "推送通知" }));
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
    "未保存草稿",
  );
});

test("tab arrows wrap and Home/End activate and focus their panels", async () => {
  mockManagement();
  openPage(["system:manage"]);
  const collection = screen.getByRole("tab", { name: "图源采集" });
  const notifications = screen.getByRole("tab", { name: "推送通知" });
  collection.focus();
  fireEvent.keyDown(collection, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(notifications);
  expect(notifications.getAttribute("aria-selected")).toBe("true");
  const panel = screen.getByRole("tabpanel", { name: "推送通知" });
  expect(panel.getAttribute("aria-labelledby")).toBe(notifications.id);
  expect(notifications.getAttribute("aria-controls")).toBe(panel.id);
  fireEvent.keyDown(notifications, { key: "Home" });
  expect(document.activeElement).toBe(collection);
  fireEvent.keyDown(collection, { key: "End" });
  expect(document.activeElement).toBe(notifications);
  fireEvent.keyDown(notifications, { key: "ArrowRight" });
  expect(document.activeElement).toBe(collection);
  await act(async () => {});
});

test("direct notification URL does not bypass system permission", () => {
  const get = mockManagement();
  openPage(["candidates:manage"], "/settings/system?tab=notifications");
  expect(screen.getByRole("heading", { name: "无权访问" })).toBeTruthy();
  expect(get).not.toHaveBeenCalled();
});

test("collection polling pauses while notifications is active and resumes on return", async () => {
  const get = mockManagement();
  openPage(["system:manage"]);
  await screen.findByText("暂无同步记录。");
  fireEvent.click(screen.getByRole("tab", { name: "推送通知" }));
  await screen.findByText("暂无群目标。");
  const count = () =>
    get.mock.calls.filter((call) => call[0] === "/api/source-fetch/runs")
      .length;
  const before = count();
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_000);
  });
  expect(count()).toBe(before);
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("tab", { name: "图源采集" }));
  await act(async () => {});
  expect(count()).toBe(before + 1);
});
