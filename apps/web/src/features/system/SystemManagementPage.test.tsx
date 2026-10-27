import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client } from "../account/api";
import { SystemManagementPage } from "./SystemManagementPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openPage(permissions: string[]) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/settings/system"]}>
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
  expect(screen.getByRole("heading", { name: "图源采集" })).toBeTruthy();
});
