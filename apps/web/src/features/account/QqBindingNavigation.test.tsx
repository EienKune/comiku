import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { client, queryClient } from "./api";
import { SettingsRoutingProvider } from "./SettingsRoutingProvider";
import { WorkspaceRoutes } from "./WorkspaceRoutes";

const member = vi.hoisted(() => ({
  id: "00000000-0000-4000-8000-000000000002",
  username: "syntheticmember",
  displayName: "测试成员",
  avatarVersion: null,
  roles: ["admin"],
  permissions: ["self", "accounts:manage"],
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
const dialogMethods = ["showModal", "close"] as const;
const originalDialogMethods = dialogMethods.map((name) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
);
function setup(path: string) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SettingsRoutingProvider>
          <WorkspaceRoutes />
        </SettingsRoutingProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  member.permissions = ["self", "accounts:manage"];
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  dialogMethods.forEach((name, index) => {
    const descriptor = originalDialogMethods[index];
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
});

test("account-management shortcut opens only the current binding and restores its background and trigger", async () => {
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/users") return ok([member]);
    if (path === "/api/users/roles")
      return ok([{ value: "admin", label: "管理员" }]);
    if (path === "/api/users/audit") return ok([]);
    if (path === "/api/users/me/qq-binding")
      return ok({ qqNumber: "720000001", revision: 0 });
    throw new Error("Unexpected read: " + path);
  });
  setup("/settings/users");
  const trigger = await screen.findByRole("link", { name: "我的 QQ 绑定" });
  expect(
    readPaths(get).some((path) => path === "/api/users/me/qq-binding"),
  ).toBe(false);
  trigger.focus();
  fireEvent.click(trigger);
  const input = await screen.findByLabelText("QQ 号（选填）");
  await waitFor(() =>
    expect((input as HTMLInputElement).value).toBe("720000001"),
  );
  expect(
    screen.getByRole("link", { name: "QQ 绑定" }).getAttribute("href"),
  ).toBe("/settings?tab=qq");
  expect(screen.getByRole("heading", { name: "账号管理" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(readPaths(get).filter((path) => path.includes("qq-binding"))).toEqual([
    "/api/users/me/qq-binding",
  ]);
});

test("a member without account-management permission can open QQ binding from personal settings", async () => {
  member.permissions = ["self"];
  const get = vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/users/me/qq-binding")
      return ok({ qqNumber: null, revision: 0 });
    throw new Error("Unexpected read: " + path);
  });
  setup("/settings?tab=appearance");
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "QQ 绑定" }));
  const input = await screen.findByLabelText("QQ 号（选填）");
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  expect(screen.queryByRole("link", { name: "我的 QQ 绑定" })).toBeNull();
  expect(readPaths(get)).toEqual(["/api/users/me/qq-binding"]);
});
