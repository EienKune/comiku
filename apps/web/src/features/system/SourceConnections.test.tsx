import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { SourceConnections } from "./SourceConnections";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const source = (platform: string, available = true) => ({
  platform,
  adapterKey: `${platform}_gallery_dl`,
  available,
  priority: 1,
  metered: false,
  supportedFirstSyncModes: ["none"],
});
const state = (platform: string, status: string, extra = {}) => ({
  platform,
  status,
  credentialGeneration: "private-generation-not-for-display",
  errorCode: null,
  cooldownUntil: null,
  revision: 0,
  ...extra,
});
function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SourceConnections />
    </QueryClientProvider>,
  );
  return queryClient;
}
function mock(sources: unknown[], states: unknown[]) {
  return vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data: path === "/api/authors/sources" ? sources : states,
        response: new Response(),
      }) as never,
  );
}

test("platform cards use actual authentication and cooldown state instead of adapter availability", async () => {
  mock(
    [source("x"), source("pixiv")],
    [
      state("x", "auth_paused", { errorCode: "auth_failed" }),
      state("pixiv", "cooling_down", {
        errorCode: "rate_limited",
        cooldownUntil: "2099-01-01T00:00:00Z",
      }),
    ],
  );
  mount();
  expect(await screen.findByText("认证暂停")).toBeTruthy();
  expect(screen.getByText("冷却中")).toBeTruthy();
  const x = screen.getByRole("article", { name: "X 图源接入" });
  expect(within(x).getByRole("heading", { name: "X" })).toBeTruthy();
  expect(within(x).getByText("gallery-dl", { exact: true })).toBeTruthy();
  expect(screen.queryByText("X · gallery-dl")).toBeNull();
  expect(screen.getByText("平台认证未通过，请更新凭据后验证。")).toBeTruthy();
  expect(screen.queryByText("private-generation-not-for-display")).toBeNull();
});

test("a configured adapter with no platform observation is awaiting validation, never healthy", async () => {
  mock([source("x")], []);
  mount();
  expect(await screen.findByText("待验证")).toBeTruthy();
  expect(screen.getByText("未配置")).toBeTruthy();
  expect(screen.queryByText("正常", { exact: true })).toBeNull();
});

test("state read failure never presents configured sources as healthy and refresh is read-only", async () => {
  let unavailable = true;
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/source-fetch/platforms" && unavailable)
      throw new TypeError("network unavailable");
    return {
      data:
        path === "/api/authors/sources"
          ? [source("x")]
          : [state("x", "healthy")],
      response: new Response(),
    } as never;
  });
  const post = vi.spyOn(client, "POST");
  mount();
  await screen.findByText("平台状态读取失败，请刷新重试。");
  expect(screen.queryByText("正常", { exact: true })).toBeNull();
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "刷新平台状态" }));
  expect(await screen.findByText("正常", { exact: true })).toBeTruthy();
  expect(
    get.mock.calls.filter((call) => call[0] === "/api/source-fetch/platforms"),
  ).toHaveLength(2);
  expect(post).not.toHaveBeenCalled();
});

test("unavailable current configuration takes precedence over old healthy observations", async () => {
  mock([source("x", false)], [state("x", "healthy")]);
  mount();
  expect(await screen.findByText("接入不可用")).toBeTruthy();
  expect(screen.queryByText("正常", { exact: true })).toBeNull();
});

test("maintenance is the primary platform state and credentials remain discoverable", async () => {
  mock([source("x")], [state("x", "auth_paused", { maintenancePaused: true })]);
  mount();
  const card = await screen.findByRole("article", { name: "X 图源接入" });
  expect(await within(card).findByText("维护中")).toBeTruthy();
  expect(within(card).queryByText("认证暂停", { exact: true })).toBeNull();
  expect(
    within(card).getByRole("button", { name: "管理 X 凭据" }),
  ).toBeTruthy();
});
