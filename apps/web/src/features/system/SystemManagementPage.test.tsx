import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client } from "../account/api";
import { SystemManagementPage } from "./SystemManagementPage";
import { SourceManagement } from "./SourceManagement";

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
  vi.spyOn(client, "GET").mockResolvedValue({
    data: [],
    response: new Response(),
  } as never);
  openPage(["system:manage"]);
  expect(screen.getByRole("heading", { name: "系统管理" })).toBeTruthy();
  expect(await screen.findByText("暂无同步记录。")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "同步记录" })).toBeTruthy();
});

test("connections expose pending verification separately from configuration and no second collection switch", async () => {
  vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data:
          path === "/api/authors/sources"
            ? [
                {
                  platform: "x",
                  adapterKey: "x_gallery_dl",
                  available: true,
                  priority: 1,
                  metered: false,
                  supportedFirstSyncModes: ["none"],
                },
              ]
            : [],
        response: new Response(),
      }) as never,
  );
  openPage(["system:manage"]);
  expect(await screen.findByText("待验证")).toBeTruthy();
  expect(screen.getByText("未配置")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /启用|停用/ })).toBeNull();
});

test("the source tab uses the notification branch URL contract and safely handles unknown tabs", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue({ data: [], response: new Response() } as never);
  openPage(["system:manage"], "/settings/system?tab=future&keep=yes");
  expect(
    screen.getByRole("tab", { name: "图源采集" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    "system-tab-collection",
  );
  await screen.findByText("暂无同步记录。");
  expect(
    get.mock.calls.every(
      (call) =>
        call[0] === "/api/authors/sources" ||
        call[0] === "/api/source-fetch/runs" ||
        call[0] === "/api/source-fetch/platforms",
    ),
  ).toBe(true);
});

test("an inactive source panel performs no capability reads or history polling, then resumes when enabled", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue({ data: [], response: new Response() } as never);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = (enabled: boolean) => (
    <QueryClientProvider client={queryClient}>
      <SourceManagement enabled={enabled} />
    </QueryClientProvider>
  );
  const view = render(page(false));
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_000);
  });
  expect(get).not.toHaveBeenCalled();
  vi.useRealTimers();
  view.rerender(page(true));
  await screen.findByText("暂无同步记录。");
  expect(get.mock.calls.map((call) => call[0]).sort()).toEqual([
    "/api/authors/sources",
    "/api/source-fetch/platforms",
    "/api/source-fetch/runs",
  ]);
  view.rerender(page(false));
  const before = get.mock.calls.length;
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_000);
  });
  expect(get.mock.calls.length).toBe(before);
});
