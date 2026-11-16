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
import { SourceAccountFilter } from "./SourceAccountFilter";
const caches: QueryClient[] = [];
afterEach(() => {
  cleanup();
  caches.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
});
const ok = (data: unknown) => ({ data, response: new Response() }) as never;
function mount(authorId?: string, disabled = false) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  caches.push(cache);
  const change = vi.fn();
  render(
    <QueryClientProvider client={cache}>
      <SourceAccountFilter
        authorId={authorId}
        value="all"
        onChange={change}
        disabled={disabled}
      />
    </QueryClientProvider>,
  );
  return change;
}
test("source accounts are fetched only when the selected author's filter is opened", async () => {
  const get = vi.spyOn(client, "GET").mockResolvedValue(
    ok([
      {
        id: "main",
        platform: "x",
        handle: "main",
        externalUserId: "1",
        deletedAt: null,
      },
      {
        id: "alt",
        platform: "x",
        handle: "alt",
        externalUserId: "2",
        deletedAt: null,
      },
      {
        id: "old",
        platform: "pixiv",
        handle: null,
        externalUserId: "3",
        deletedAt: "2026-01-01",
      },
    ]),
  );
  const change = mount("author-a");
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("combobox", { name: "来源账号" }));
  fireEvent.click(await screen.findByRole("option", { name: "X @alt" }));
  expect(change).toHaveBeenCalledWith("account:alt");
  expect(get).toHaveBeenCalledWith(
    "/api/authors/{id}/source-accounts",
    expect.objectContaining({ params: { path: { id: "author-a" } } }),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "来源账号" }));
  expect(
    screen.getByRole("option", { name: "Pixiv 3（已停用）" }),
  ).toBeTruthy();
  expect(screen.queryByRole("option", { name: "来源账号未知" })).toBeNull();
  expect(screen.queryByRole("option", { name: "手动上传" })).toBeNull();
});
test("no author or a frozen action disables source filtering without a request", async () => {
  const get = vi.spyOn(client, "GET").mockResolvedValue(ok([]));
  mount(undefined);
  expect(
    (screen.getByRole("combobox", { name: "来源账号" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  cleanup();
  mount("author", true);
  fireEvent.click(screen.getByRole("combobox", { name: "来源账号" }));
  await waitFor(() => expect(get).not.toHaveBeenCalled());
});
test("keyboard opening uses the same lazy query and reports errors without changing the scope", async () => {
  vi.spyOn(client, "GET").mockResolvedValue({
    error: { message: "读取失败" },
    response: new Response(null, { status: 500 }),
  } as never);
  const change = mount("author-b");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "来源账号" }), {
    key: "ArrowDown",
  });
  await screen.findByRole("button", { name: "重试读取来源账号" });
  expect(change).not.toHaveBeenCalled();
});

test("only configured accounts are selectable, without platform headings or synthetic scopes", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(
    ok([
      {
        id: "one",
        platform: "x",
        handle: "only",
        externalUserId: "1",
        deletedAt: null,
      },
    ]),
  );
  const change = mount("single-account-author");
  fireEvent.click(screen.getByRole("combobox", { name: "来源账号" }));
  const option = await screen.findByRole("option", { name: "X @only" });
  expect(option.querySelector("svg")).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(
    screen.queryByText("X", { selector: ".ui-select-menu__group" }),
  ).toBeNull();
  expect(screen.queryByText("Pixiv")).toBeNull();
  expect(screen.queryByRole("option", { name: "全部 X 账号" })).toBeNull();
  expect(screen.queryByRole("option", { name: "全部 Pixiv 账号" })).toBeNull();
  fireEvent.click(option);
  expect(change).toHaveBeenCalledWith("account:one");
});
