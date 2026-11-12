import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { client, queryClient } from "./api";
import { RegistrationSettings } from "./RegistrationSettings";

const result = (data: object, status = 200) =>
  ({
    ...(status < 400 ? { data } : { error: data }),
    response: new Response(null, { status }),
  }) as never;
function element(enabled = true) {
  return (
    <QueryClientProvider client={queryClient}>
      <RegistrationSettings enabled={enabled} />
    </QueryClientProvider>
  );
}
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

test("registration settings query only while active and retains the two-flag draft across tab changes", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(
      result({ enabled: false, allowRoleSelection: false, revision: 2 }),
    );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValue(
      result({ enabled: true, allowRoleSelection: true, revision: 3 }),
    );
  const view = render(element(false));
  expect(get).not.toHaveBeenCalled();
  view.rerender(element(true));
  const open = screen.getByRole("checkbox", {
    name: "开放注册",
  }) as HTMLInputElement;
  await waitFor(() => expect(open.disabled).toBe(false));
  fireEvent.click(open);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "允许注册时自选职责和语言" }),
  );
  fireEvent.change(screen.getByLabelText("当前管理员密码"), {
    target: { value: "synthetic-admin-password" },
  });
  view.rerender(element(false));
  expect(
    (screen.getByRole("button", { name: "保存注册设置" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  view.rerender(element(true));
  expect(open.checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存注册设置" }));
  await screen.findByText("公开注册已开启");
  expect(patch).toHaveBeenCalledWith("/api/users/registration-settings", {
    body: {
      enabled: true,
      allowRoleSelection: true,
      expectedRevision: 2,
      currentPassword: "synthetic-admin-password",
    },
  });
});

test("a stale admin settings save keeps its old revision and draft until explicit comparison and reapply", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValueOnce(
      result({ enabled: false, allowRoleSelection: false, revision: 3 }),
    )
    .mockResolvedValueOnce(
      result({ enabled: false, allowRoleSelection: true, revision: 7 }),
    );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValueOnce(result({ message: "注册设置已更新" }, 409))
    .mockResolvedValueOnce(
      result({ enabled: true, allowRoleSelection: false, revision: 8 }),
    );
  render(element());
  const open = screen.getByRole("checkbox", {
    name: "开放注册",
  }) as HTMLInputElement;
  await waitFor(() => expect(open.disabled).toBe(false));
  fireEvent.click(open);
  fireEvent.change(screen.getByLabelText("当前管理员密码"), {
    target: { value: "synthetic-admin-password" },
  });
  act(() =>
    queryClient.setQueryData(["registration-settings"], {
      enabled: false,
      allowRoleSelection: true,
      revision: 6,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存注册设置" }));
  await screen.findByText("注册设置已更新");
  expect(patch).toHaveBeenNthCalledWith(1, "/api/users/registration-settings", {
    body: {
      enabled: true,
      allowRoleSelection: false,
      expectedRevision: 3,
      currentPassword: "synthetic-admin-password",
    },
  });
  expect(open.checked).toBe(true);
  expect(
    (
      screen.getByRole("checkbox", {
        name: "允许注册时自选职责和语言",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "读取当前开关" }));
  await screen.findByText("当前设置：注册已关闭 · 允许自选职责和语言");
  expect(get).toHaveBeenCalledTimes(2);
  expect(patch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "以当前版本保存开关" }));
  await screen.findByText("公开注册已开启");
  expect(patch).toHaveBeenNthCalledWith(2, "/api/users/registration-settings", {
    body: {
      enabled: true,
      allowRoleSelection: false,
      expectedRevision: 7,
      currentPassword: "synthetic-admin-password",
    },
  });
  expect(screen.queryByLabelText("当前管理员密码")).toBeNull();
});

test("failed settings reads cannot submit a cached configuration", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    result({ message: "读取失败" }, 503),
  );
  const patch = vi.spyOn(client, "PATCH");
  queryClient.setQueryData(["registration-settings"], {
    enabled: false,
    allowRoleSelection: false,
    revision: 2,
  });
  const view = render(element());
  fireEvent.click(screen.getByRole("checkbox", { name: "开放注册" }));
  fireEvent.change(screen.getByLabelText("当前管理员密码"), {
    target: { value: "synthetic-admin-password" },
  });
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: ["registration-settings"],
    });
  });
  await screen.findByText("暂时无法读取注册设置。");
  fireEvent.submit(screen.getByRole("form", { name: "公开注册设置" }));
  expect(patch).not.toHaveBeenCalled();
  view.rerender(element(false));
  expect(
    screen.queryByRole("button", {
      name: "读取当前开关",
    }) as HTMLButtonElement | null,
  ).toBeNull();
});
