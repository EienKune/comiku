import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountLayout } from "./AccountApp";
import { LoginPage } from "./LoginPage";
import { PasswordPage } from "./ProfilePage";

const mocks = vi.hoisted(() => ({ current: null as unknown, post: vi.fn() }));
vi.mock("./api", () => ({
  publicSiteQueryKey: ["site"],
  clearAccountCache: () => {
    mocks.current = null;
  },
  useMe: () => ({ data: mocks.current, isPending: false, isError: false }),
  client: { POST: mocks.post, GET: vi.fn() },
  authenticatedFetch: vi.fn(),
  unwrap: async (result: { data: unknown }) => result.data,
  queryClient: {
    clear: () => {
      mocks.current = null;
    },
    setQueryData: (_key: unknown, value: unknown) => {
      mocks.current = value;
    },
  },
}));
vi.mock("./use-session-activity", () => ({
  useSessionActivity: () => undefined,
}));
const workPath =
  "/works/00000000-0000-4000-8000-000000000001?from=notification#history";
function member(mustChangePassword = false) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    username: "syntheticmember",
    displayName: "测试成员",
    avatarVersion: null,
    roles: ["translator"],
    permissions: ["works:read"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword,
    revision: 0,
    canSkipProofreading: false,
  };
}
function Destination({ label }: { label: string }) {
  const location = useLocation();
  return (
    <p>
      {label}:{location.pathname + location.search + location.hash}
    </p>
  );
}
function setup(
  initial: string | { pathname: string; state: unknown } = workPath,
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AccountLayout />}>
            <Route
              path="/works/:id"
              element={<Destination label="作品目标" />}
            />
            <Route path="/settings/password" element={<PasswordPage />} />
            <Route path="/" element={<Destination label="首页" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function login() {
  fireEvent.change(await screen.findByLabelText("账户名"), {
    target: { value: "syntheticmember" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-old-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
}
async function changePassword(temporary = true) {
  fireEvent.change(
    await screen.findByLabelText(
      temporary ? "管理员提供的临时密码" : "当前密码",
    ),
    { target: { value: "synthetic-old-password" } },
  );
  fireEvent.change(screen.getByLabelText("新密码"), {
    target: { value: "synthetic-new-password" },
  });
  fireEvent.change(screen.getByLabelText("再次输入新密码"), {
    target: { value: "synthetic-new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认修改密码" }));
}
beforeEach(() => {
  mocks.current = null;
  mocks.post.mockImplementation(async () => ({ data: member() }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.post.mockReset();
});

test("unauthenticated notification link returns to its work including query and hash after login", async () => {
  setup();
  await login();
  await screen.findByText("作品目标:" + workPath);
});
test("notification login preserves target through mandatory password change", async () => {
  mocks.post.mockImplementation(async (path: string) => ({
    data: member(path === "/api/auth/login"),
  }));
  setup();
  await login();
  await changePassword();
  await screen.findByText("作品目标:" + workPath);
});
test("already authenticated temporary-password account returns after changing password", async () => {
  mocks.current = member(true);
  setup();
  await changePassword();
  await screen.findByText("作品目标:" + workPath);
});
test("already logged-in login page honors the validated return target", async () => {
  mocks.current = member();
  setup({ pathname: "/login", state: { returnTo: workPath } });
  await screen.findByText("作品目标:" + workPath);
});
test("direct login without a saved target still opens the home page", async () => {
  setup("/login");
  await login();
  await screen.findByText("首页:/");
});
test("ordinary password settings remain on the page and show success", async () => {
  mocks.current = member();
  setup({ pathname: "/settings/password", state: { returnTo: workPath } });
  await changePassword(false);
  await screen.findByText("密码已更新");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "修改密码" })).toBeTruthy();
  expect(screen.queryByText("作品目标:" + workPath)).toBeNull();
});
for (const target of [
  "https://outside.invalid/works/1",
  "//outside.invalid",
  "/\\outside.invalid",
  "/%2f%2foutside.invalid",
  "/%5coutside.invalid",
  "/login",
  "/api/auth/logout",
  "/works/%0aevil",
  " /works/1",
  "javascript:alert(1)",
  42,
]) {
  test(`login ignores unsafe return target ${JSON.stringify(target)}`, async () => {
    setup({ pathname: "/login", state: { returnTo: target } });
    await login();
    await screen.findByText("首页:/");
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  });
}
