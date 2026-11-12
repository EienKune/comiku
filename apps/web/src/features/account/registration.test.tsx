import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { client, queryClient } from "./api";
import { LoginPage } from "./LoginPage";
import { RegisterPage } from "./RegisterPage";
import { registrationOptionsKey } from "./registration-options";

const user = {
  id: "registered-user",
  username: "member123",
  displayName: "新成员",
  roles: ["translator"],
  languageCapabilities: ["ja"],
  permissions: ["self", "works:read"],
  revision: 0,
  isActive: true,
  mustChangePassword: false,
  canSkipProofreading: false,
  activityIntervalSeconds: 300,
};
const initialOptions = {
  enabled: true,
  allowRoleSelection: true,
  revision: 3,
  roles: [
    { value: "translator", label: "翻译" },
    { value: "proofreader", label: "校对" },
  ],
  languageCapabilities: [
    { value: "ja", label: "日语" },
    { value: "ko", label: "韩语" },
  ],
};
let options = { ...initialOptions };
const result = (data: unknown, status = 200) =>
  ({
    ...(status < 400 ? { data } : { error: data }),
    response: new Response(null, { status }),
  }) as never;
const target =
  "/works/00000000-0000-4000-8000-000000000001?from=notice#history";
function Destination() {
  const location = useLocation();
  return <p>目标：{location.pathname + location.search + location.hash}</p>;
}
function setup(path = "/register", returnTo = target) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: path, state: { returnTo } }]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/works/:id" element={<Destination />} />
          <Route path="/settings" element={<Destination />} />
          <Route path="/" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function fill() {
  await screen.findByRole("checkbox", { name: "翻译" });
  fireEvent.change(screen.getByLabelText("账户名"), {
    target: { value: " Member123 " },
  });
  fireEvent.change(screen.getByLabelText("成员昵称"), {
    target: { value: " 新成员 " },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-password-123" },
  });
  fireEvent.change(screen.getByLabelText("再次输入密码"), {
    target: { value: "synthetic-password-123" },
  });
}
beforeEach(() => {
  options = { ...initialOptions };
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    path === "/api/auth/me"
      ? result({ message: "请先登录" }, 401)
      : result(options),
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

test("login-register-login preserves the safe return target and registration uses only selected capabilities", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue(result(user));
  setup("/login");
  fireEvent.click(await screen.findByRole("link", { name: "注册账号" }));
  fireEvent.click(await screen.findByRole("link", { name: "返回登录" }));
  fireEvent.click(await screen.findByRole("link", { name: "注册账号" }));
  await fill();
  fireEvent.click(screen.getByRole("checkbox", { name: "翻译" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "日语" }));
  fireEvent.click(screen.getByRole("button", { name: "注册并登录" }));
  await screen.findByText("目标：" + target);
  expect(post).toHaveBeenCalledWith("/api/auth/register", {
    body: {
      username: "member123",
      displayName: "新成员",
      password: "synthetic-password-123",
      roles: ["translator"],
      languageCapabilities: ["ja"],
      expectedSettingsRevision: 3,
    },
  });
});

test("stale registration settings keep every field and require an explicit retry with the refreshed contract", async () => {
  const post = vi
    .spyOn(client, "POST")
    .mockImplementationOnce(async () => {
      options = { ...options, allowRoleSelection: false, revision: 4 };
      return result({ message: "注册设置已更新，请确认后重试" }, 409);
    })
    .mockResolvedValueOnce(
      result({
        ...user,
        roles: [],
        languageCapabilities: [],
        permissions: ["self"],
      }),
    );
  setup();
  await fill();
  fireEvent.click(screen.getByRole("checkbox", { name: "翻译" }));
  fireEvent.click(screen.getByRole("button", { name: "注册并登录" }));
  await screen.findByText("注册设置已更新，请确认后重试");
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe(
    "synthetic-password-123",
  );
  expect((screen.getByLabelText("成员昵称") as HTMLInputElement).value).toBe(
    " 新成员 ",
  );
  expect(screen.queryByRole("checkbox", { name: "翻译" })).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "注册并登录" }));
  await screen.findByText("目标：/settings?tab=profile");
  expect(post).toHaveBeenNthCalledWith(2, "/api/auth/register", {
    body: {
      username: "member123",
      displayName: "新成员",
      password: "synthetic-password-123",
      roles: [],
      languageCapabilities: [],
      expectedSettingsRevision: 4,
    },
  });
});

test("closing registration keeps the draft and the return-to-login link", async () => {
  const post = vi.spyOn(client, "POST");
  setup();
  await fill();
  options = { ...options, enabled: false, revision: 4 };
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: registrationOptionsKey });
  });
  await screen.findByText("注册暂未开放，已有账号可继续登录。");
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe(
    "synthetic-password-123",
  );
  expect(
    (screen.getByRole("button", { name: "注册并登录" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.submit(screen.getByRole("form", { name: "注册账号" }));
  await waitFor(() => expect(post).not.toHaveBeenCalled());
  expect(screen.getByRole("link", { name: "返回登录" })).toBeTruthy();
});

test("registration availability failure never blocks an existing login, and a roleless member lands on profile", async () => {
  vi.mocked(client.GET).mockImplementation(async (path) =>
    path === "/api/auth/me"
      ? result({}, 401)
      : result({ message: "暂不可用" }, 503),
  );
  vi.spyOn(client, "POST").mockResolvedValue(result({ ...user, roles: [] }));
  setup("/login");
  fireEvent.change(await screen.findByLabelText("账户名"), {
    target: { value: "member123" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByText("目标：/settings?tab=profile");
});

test("registration refuses missing initial roles and ignores an unsafe return target after successful signup", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue(result(user));
  setup("/register", "https://outside.invalid/");
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "注册并登录" }));
  await screen.findByText("至少选择一个业务职责");
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "翻译" }));
  fireEvent.click(screen.getByRole("button", { name: "注册并登录" }));
  await screen.findByText("目标：/");
});
