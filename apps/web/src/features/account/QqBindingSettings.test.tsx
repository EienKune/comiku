import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { client, queryClient } from "./api";
import { QqBindingSettings } from "./QqBindingSettings";

vi.mock("./account-context", () => ({
  useAccount: () => ({ id: "synthetic-qq-member" }),
}));
const result = (data: object, status = 200) =>
  ({
    ...(status < 400 ? { data } : { error: data }),
    response: new Response(null, { status }),
  }) as never;
const key = ["my-qq-binding", "synthetic-qq-member"];
function setup() {
  render(
    <QueryClientProvider client={queryClient}>
      <QqBindingSettings />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

test("saves a normalized private binding and explicitly clears it with the saved revision", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    result({ qqNumber: null, revision: 7 }),
  );
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValueOnce(result({ qqNumber: "720000001", revision: 8 }))
    .mockResolvedValueOnce(result({ qqNumber: null, revision: 9 }));
  setup();
  const input = screen.getByLabelText("QQ 号（选填）") as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: " 720000001 " } });
  fireEvent.click(screen.getByRole("button", { name: "保存 QQ 号" }));
  await screen.findByText("QQ 号已保存");
  expect(patch).toHaveBeenNthCalledWith(1, "/api/users/me/qq-binding", {
    body: { qqNumber: "720000001", expectedRevision: 7 },
  });
  expect(input.value).toBe("720000001");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存 QQ 号" }));
  await screen.findByText("QQ 号已解绑");
  expect(patch).toHaveBeenNthCalledWith(2, "/api/users/me/qq-binding", {
    body: { qqNumber: null, expectedRevision: 8 },
  });
  expect(queryClient.getQueryData(key)).toEqual({
    qqNumber: null,
    revision: 9,
  });
});

test("a failed initial read cannot overwrite a binding and invalid identifiers cannot submit", async () => {
  vi.spyOn(client, "GET")
    .mockResolvedValueOnce(result({ message: "读取失败" }, 503))
    .mockResolvedValueOnce(result({ qqNumber: "720000002", revision: 2 }));
  const patch = vi.spyOn(client, "PATCH");
  setup();
  await screen.findByText("暂时无法读取 QQ 绑定");
  const input = screen.getByLabelText("QQ 号（选填）") as HTMLInputElement;
  expect(input.disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "保存 QQ 号" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(input.value).toBe("720000002"));
  fireEvent.change(input, { target: { value: "[CQ:at,qq=all]" } });
  fireEvent.submit(screen.getByRole("form", { name: "QQ 绑定" }));
  expect(screen.getByText("请输入 5–20 位数字，首位不能为 0")).toBeTruthy();
  expect(patch).not.toHaveBeenCalled();
});

test("preserves the draft and its revision until an explicit current-version comparison", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValueOnce(result({ qqNumber: "720000003", revision: 4 }))
    .mockResolvedValueOnce(result({ qqNumber: "720000004", revision: 6 }));
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValueOnce(result({ message: "个人资料已更新" }, 409))
    .mockResolvedValueOnce(result({ qqNumber: "720000005", revision: 7 }));
  setup();
  const input = screen.getByLabelText("QQ 号（选填）") as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("720000003"));
  fireEvent.change(input, { target: { value: "720000005" } });
  act(() =>
    queryClient.setQueryData(key, { qqNumber: "720000006", revision: 5 }),
  );
  expect(input.value).toBe("720000005");
  fireEvent.click(screen.getByRole("button", { name: "保存 QQ 号" }));
  await screen.findByText("个人资料已更新");
  expect(patch).toHaveBeenNthCalledWith(1, "/api/users/me/qq-binding", {
    body: { qqNumber: "720000005", expectedRevision: 4 },
  });
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "读取当前绑定" }));
  await screen.findByText("当前绑定：720000004");
  expect(input.value).toBe("720000005");
  expect(patch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "以当前版本保存" }));
  await screen.findByText("QQ 号已保存");
  expect(patch).toHaveBeenNthCalledWith(2, "/api/users/me/qq-binding", {
    body: { qqNumber: "720000005", expectedRevision: 6 },
  });
});

test("retrying a background read failure with a dirty cached binding never submits the form", async () => {
  vi.spyOn(client, "GET")
    .mockResolvedValueOnce(result({ qqNumber: "720000007", revision: 3 }))
    .mockResolvedValueOnce(result({ message: "读取失败" }, 503))
    .mockResolvedValueOnce(result({ qqNumber: "720000008", revision: 4 }));
  const patch = vi.spyOn(client, "PATCH");
  setup();
  const input = screen.getByLabelText("QQ 号（选填）") as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("720000007"));
  fireEvent.change(input, { target: { value: "720000009" } });
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: key });
  });
  await screen.findByText("暂时无法读取 QQ 绑定");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() =>
    expect(screen.queryByText("暂时无法读取 QQ 绑定")).toBeNull(),
  );
  expect(input.value).toBe("720000009");
  expect(patch).not.toHaveBeenCalled();
});
