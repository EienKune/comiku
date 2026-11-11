import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { client, queryClient } from "./api";
import { WorkspaceRoutes } from "./WorkspaceRoutes";

const member = vi.hoisted(() => ({
  id: "00000000-0000-4000-8000-000000000002",
  username: "syntheticmember",
  displayName: "测试成员",
  avatarVersion: null,
  roles: ["translator"],
  permissions: ["self"],
  languageCapabilities: [],
  isActive: true,
  mustChangePassword: false,
  revision: 0,
  canSkipProofreading: false,
}));
vi.mock("./account-context", () => ({ useAccount: () => member }));
const ok = (data: unknown) => ({ data, response: new Response() }) as never;
const readPaths = (get: { mock: { calls: unknown[] } }) =>
  get.mock.calls.map((call) => (call as [string])[0]);
const scrollDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search + location.hash}
    </output>
  );
}
function setup(path: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceRoutes />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  member.permissions = ["self"];
  member.roles = ["translator"];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  if (scrollDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

test("personal settings are a full page and expose QQ only once inside the current member's profile", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/users/me/qq-binding")
      return ok({ qqNumber: "720000001", revision: 0 });
    throw new Error("Unexpected read: " + path);
  });
  setup("/settings?tab=appearance");
  expect(screen.getByRole("heading", { name: "个人设置" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(get).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "QQ 绑定" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "个人资料" }));
  const input = await screen.findByLabelText("QQ 号（选填）");
  await waitFor(() =>
    expect((input as HTMLInputElement).value).toBe("720000001"),
  );
  expect(screen.getAllByLabelText("QQ 号（选填）")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "关闭设置" })).toBeNull();
  expect(readPaths(get)).toEqual(["/api/users/me/qq-binding"]);
});

test("the old QQ URL redirects to the sole profile field and retains unrelated query parameters", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    ok({ qqNumber: null, revision: 0 }),
  );
  setup("/settings?tab=qq&keep=yes");
  await screen.findByLabelText("QQ 号（选填）");
  expect(screen.getByTestId("location").textContent).toBe(
    "/settings?tab=profile&keep=yes#qq-binding",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the legacy account route opens the authorized system tab without a personal QQ shortcut", async () => {
  member.permissions = ["self", "accounts:manage", "members:read"];
  member.roles = ["admin"];
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/users") return ok([member]);
    if (path === "/api/users/roles")
      return ok([{ value: "admin", label: "管理员" }]);
    throw new Error("Unexpected read: " + path);
  });
  setup("/settings/users?keep=yes#history");
  await screen.findByRole("heading", { name: "分发新账号" });
  expect(
    screen.getByRole("tab", { name: "账号管理" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByTestId("location").textContent).toBe(
    "/settings/system?keep=yes&tab=accounts#history",
  );
  expect(screen.queryByText("我的 QQ 绑定")).toBeNull();
  expect(screen.queryByRole("tab", { name: "图源采集" })).toBeNull();
  expect(
    readPaths(get).every((path) =>
      ["/api/users", "/api/users/roles"].includes(path),
    ),
  ).toBe(true);
});
