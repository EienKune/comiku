import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { AuthorPicker } from "./AuthorPicker";
import { client } from "../account/api";

const clients: QueryClient[] = [];
const author = (id: string, displayName = id) => ({
  id,
  displayName,
  authorizationStatus: "authorized",
  deletedAt: null,
  externalAccounts: [],
});
const response = (data: unknown) => ({
  data,
  response: new Response(null, { status: 200 }),
});
function mount() {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(query);
  function Harness() {
    const [value, setValue] = useState("");
    return (
      <>
        <AuthorPicker value={value} onValueChange={setValue} />
        <output>{value}</output>
      </>
    );
  }
  render(
    <QueryClientProvider client={query}>
      <Harness />
    </QueryClientProvider>,
  );
  return query;
}
afterEach(() => {
  cleanup();
  clients.forEach((query) => query.clear());
  clients.length = 0;
  vi.restoreAllMocks();
});

test("loads beyond 50 and 100 with authorized server filters and preserves selection while searching", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockImplementation(async (_path, init) => {
      const query = (
        init as { params?: { query?: { cursor?: string; search?: string } } }
      )?.params?.query;
      if (query?.search)
        return response({ items: [], total: 0, nextCursor: null }) as never;
      const start =
        query?.cursor === "100" ? 100 : query?.cursor === "50" ? 50 : 0;
      return response({
        items: Array.from({ length: start === 100 ? 1 : 50 }, (_, i) =>
          author(String(start + i + 1)),
        ),
        total: 101,
        nextCursor: start === 100 ? null : String(start + 50),
      }) as never;
    });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "继续加载作者" }));
  fireEvent.click(await screen.findByRole("option", { name: "51" }));
  expect(screen.getByText("已选：51")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "继续加载作者" }));
  fireEvent.click(await screen.findByRole("option", { name: "101" }));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "no-match" },
  });
  expect(screen.queryByRole("option", { name: "51" })).toBeNull();
  await screen.findByText("没有匹配的授权作者");
  expect(screen.getByText("已选：101")).toBeTruthy();
  expect(
    (
      get.mock.calls as unknown as [
        unknown,
        {
          params?: { query?: { authorizationStatus?: string; limit?: number } };
        },
      ][]
    ).every(
      ([, init]) =>
        (
          init as {
            params?: {
              query?: { authorizationStatus?: string; limit?: number };
            };
          }
        )?.params?.query?.authorizationStatus === "authorized",
    ),
  ).toBe(true);
});

test("debounces input, ignores old results and clears a revoked selection after revalidation", async () => {
  let resolveOld!: (value: never) => void;
  const get = vi.spyOn(client, "GET").mockImplementation(async (path, init) => {
    if (path === "/api/authors/{id}")
      return response({
        ...author("one"),
        authorizationStatus: "revoked",
      }) as never;
    const search = (init as { params?: { query?: { search?: string } } })
      ?.params?.query?.search;
    if (search === "old")
      return new Promise<never>((resolve) => {
        resolveOld = resolve;
      });
    return response({
      items: [author(search === "new" ? "new" : "one")],
      total: 1,
      nextCursor: null,
    }) as never;
  });
  const query = mount();
  fireEvent.click(await screen.findByRole("option", { name: "one" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old" } });
  await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "n" } });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
  await screen.findByRole("option", { name: "new" });
  await act(async () =>
    resolveOld(
      response({
        items: [author("stale")],
        total: 1,
        nextCursor: null,
      }) as never,
    ),
  );
  expect(screen.queryByRole("option", { name: "stale" })).toBeNull();
  expect(
    (
      get.mock.calls as unknown as [
        unknown,
        { params?: { query?: { search?: string } } },
      ][]
    ).some(
      ([, init]) =>
        (init as { params?: { query?: { search?: string } } })?.params?.query
          ?.search === "n",
    ),
  ).toBe(false);
  await act(async () => {
    await query.invalidateQueries({
      queryKey: ["authors", "picker-selected", "one"],
    });
  });
  await screen.findByText("所选作者已不再可用于上传，请重新选择");
  expect(screen.getByText("", { selector: "output" }).textContent).toBe("");
});
