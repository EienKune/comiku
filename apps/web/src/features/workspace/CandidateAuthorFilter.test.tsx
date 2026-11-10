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
import { CandidateAuthorFilter } from "./CandidateAuthorFilter";
import { client } from "../account/api";
type Options = {
  params?: { query?: { search?: string; cursor?: string; limit?: number } };
  signal?: AbortSignal;
};
const caches: QueryClient[] = [];
const ok = (data: unknown) => ({ data, response: new Response() }) as never;
const author = (id: string) => ({
  id,
  displayName: `作者 ${id}`,
  externalAccounts: [],
});
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  caches.push(cache);
  const change = vi.fn();
  render(
    <QueryClientProvider client={cache}>
      <CandidateAuthorFilter value={null} onChange={change} />
    </QueryClientProvider>,
  );
  return change;
}
afterEach(() => {
  cleanup();
  caches.forEach((c) => c.clear());
  caches.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("typing only debounces suggestions; keyboard must explicitly highlight an author before confirmation", async () => {
  const get = vi
    .spyOn(client, "GET")
    .mockResolvedValue(
      ok({ items: [author("one")], nextCursor: null, total: 1 }),
    );
  const change = mount();
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  await screen.findByRole("option", { name: "作者 one" });
  for (const value of ["a", "ab", "abc", "abcd"])
    fireEvent.change(input, { target: { value } });
  expect(change).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await screen.findByRole("option", { name: "作者 one" });
  expect(get.mock.calls[1][1]).toMatchObject({
    params: { query: { search: "abcd", limit: 50 } },
  });
  expect(
    (get.mock.calls as unknown as [string, Options][])[1][1]?.params?.query,
  ).not.toHaveProperty("authorizationStatus");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(change).toHaveBeenCalledWith({ id: "one", displayName: "作者 one" });
});
test("author suggestions can reach later pages and discard aborted old searches", async () => {
  let resolveOld!: (value: never) => void;
  let signal: AbortSignal | undefined;
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    _path: string,
    options: Options = {},
  ) => {
    const q = options?.params?.query as { cursor?: string; search?: string };
    if (q.search === "old") {
      signal = options?.signal as AbortSignal;
      return new Promise<never>((r) => (resolveOld = r));
    }
    return ok({
      items: [author(q.cursor ? "later" : (q.search ?? "first"))],
      total: 2,
      nextCursor: q.cursor ? null : "next",
    });
  }) as never);
  const change = mount(),
    input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.click(await screen.findByRole("button", { name: "继续加载作者" }));
  await screen.findByRole("option", { name: "作者 later" });
  fireEvent.change(input, { target: { value: "old" } });
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.change(input, { target: { value: "new" } });
  await screen.findByRole("option", { name: "作者 new" });
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    resolveOld(ok({ items: [author("obsolete")], nextCursor: null, total: 1 })),
  );
  expect(screen.queryByText("作者 obsolete")).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "作者 new" }));
  expect(change).toHaveBeenCalledWith({ id: "new", displayName: "作者 new" });
  expect(
    (get.mock.calls as unknown as [string, Options][]).some(
      ([, options]) =>
        (options?.params?.query as { cursor?: string })?.cursor === "next",
    ),
  ).toBe(true);
});
