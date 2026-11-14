import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { SiteSettings } from "./SiteSettings";
const saved = {
  name: "Comiku",
  themePresetId: "teal",
  iconVersion: null,
  revision: 0,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const mount = (enabled = true) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SiteSettings enabled={enabled} />
    </QueryClientProvider>,
  );
test("hidden site settings do not query; edits and cancel stay local until save", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue({ data: saved, response: new Response() } as never);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    data: { ...saved, name: "夏莱", revision: 1 },
    response: new Response(),
  } as never);
  const hidden = mount(false);
  expect(get).not.toHaveBeenCalled();
  hidden.unmount();
  mount();
  const name = await screen.findByLabelText("站点名称");
  await waitFor(() => expect((name as HTMLInputElement).value).toBe("Comiku"));
  fireEvent.change(name, { target: { value: "草稿" } });
  expect(patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消更改" }));
  expect((name as HTMLInputElement).value).toBe("Comiku");
  fireEvent.change(name, { target: { value: "夏莱" } });
  fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
  await screen.findByText("站点设置已保存");
  expect(patch).toHaveBeenCalledWith(
    "/api/site/settings",
    expect.objectContaining({
      body: expect.objectContaining({
        expectedRevision: 0,
        name: "夏莱",
        iconAction: "keep",
      }),
    }),
  );
});
test("conflicts retain edits and require reading the current revision before retry", async () => {
  vi.spyOn(client, "GET").mockResolvedValue({
    data: saved,
    response: new Response(),
  } as never);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    error: { message: "站点设置已更新" },
    response: new Response(null, { status: 409 }),
  } as never);
  mount();
  const name = await screen.findByLabelText("站点名称");
  await waitFor(() => expect((name as HTMLInputElement).value).toBe("Comiku"));
  fireEvent.change(name, { target: { value: "保留草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
  await screen.findByText("站点设置已更新");
  expect((name as HTMLInputElement).value).toBe("保留草稿");
  expect(
    (screen.getByRole("button", { name: "保存更改" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole("button", { name: "读取当前设置" })).toBeTruthy();
  expect(patch).toHaveBeenCalledTimes(1);
});
