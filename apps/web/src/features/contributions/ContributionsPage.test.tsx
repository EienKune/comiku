import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ContributionsPage } from "./ContributionsPage";

const mocks = vi.hoisted(() => ({
  user: { id: "self-id", permissions: ["self", "works:read"] },
  get: vi.fn(),
}));
vi.mock("../account/account-context", () => ({ useAccount: () => mocks.user }));
vi.mock("../account/api", () => ({
  client: { GET: mocks.get },
  unwrap: async (result: { data: unknown; error?: string }) => {
    if (result.error) throw new Error(result.error);
    return result.data;
  },
}));
const summary = {
  period: "month",
  scope: "personal",
  userId: "self-id",
  month: "2026-11",
  timezone: "Asia/Shanghai",
  counts: {
    translate: 7,
    proofread: 0,
    typeset: 1,
    works: 7,
    published: 2,
    tasks: 3,
  },
  achievements: [
    {
      id: "translate-10",
      name: "翻译 10 部",
      condition: "累计有效翻译交付 10 部",
      progress: 7,
      target: 10,
      achieved: false,
    },
  ],
};
const item = {
  id: "one",
  workId: "work-one",
  workNumber: 123,
  title: "合成作品",
  workflowStatus: "pending_proofread",
  publishedAt: null,
  contributions: [
    {
      userId: "self-id",
      displayName: "合成成员",
      stage: "translate",
      completedAt: "2026-10-31T16:00:00Z",
    },
  ],
};
let queryClient: QueryClient;
beforeEach(() => {
  mocks.user.permissions = ["self", "works:read"];
  mocks.get.mockReset();
  mocks.get.mockImplementation(
    async (
      path: string,
      options: { params?: { query?: { offset?: number } } },
    ) => ({
      data: path.endsWith("summary")
        ? summary
        : path.endsWith("details")
          ? {
              total: 21,
              offset: options.params?.query?.offset ?? 0,
              limit: 20,
              items: [
                {
                  ...item,
                  id: String(options.params?.query?.offset ?? 0),
                  title: options.params?.query?.offset
                    ? "第二页作品"
                    : item.title,
                },
              ],
            }
          : [],
    }),
  );
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
function setup() {
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ContributionsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, refresh: () => result.rerender(tree()) };
}

test("personal figures open matching paginated details, time changes reset detail state and achievements stay cumulative", async () => {
  setup();
  expect(await screen.findByText("7/10")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "查看范围" })).toBeNull();
  expect(mocks.get.mock.calls.some(([path]) => path === "/api/users")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: /有完成贡献的作品/ }));
  const link = await screen.findByRole("link", { name: /#123 · 合成作品/ });
  expect(link.getAttribute("href")).toBe("/works/work-one");
  expect(screen.getByText("2026/11/01 00:00")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: /第二页作品/ });
  expect(mocks.get.mock.calls.at(-1)?.[1].params.query.offset).toBe(20);
  fireEvent.click(screen.getByRole("button", { name: "累计" }));
  await screen.findByText("7/10");
  expect(screen.queryByRole("link", { name: /第二页作品/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /当前在手任务/ }));
  await screen.findByRole("link", { name: /合成作品/ });
  expect(mocks.get.mock.calls.at(-1)?.[1].params.query).toEqual({
    period: "all",
    scope: "personal",
    metric: "tasks",
    offset: 0,
    limit: 20,
  });
});

test("summary and detail failures offer retry, then empty details remain understandable", async () => {
  mocks.get.mockResolvedValueOnce({ error: "synthetic unavailable" });
  setup();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "贡献统计读取失败",
  );
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("7/10");
  mocks.get.mockResolvedValueOnce({ error: "detail unavailable" });
  fireEvent.click(screen.getByRole("button", { name: /翻译完成/ }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "作品明细读取失败",
  );
  mocks.get.mockResolvedValueOnce({
    data: { total: 0, offset: 0, limit: 20, items: [] },
  });
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("此范围内暂无记录。")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("administrator scope uses stable member identities including inactive history and loses the scope control after permission removal", async () => {
  mocks.user.permissions = ["self", "works:read", "accounts:manage"];
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation((path, options) =>
    path === "/api/users"
      ? Promise.resolve({
          data: [
            { id: "historic-id", displayName: "历史成员", isActive: false },
          ],
        })
      : original(path, options),
  );
  const view = setup();
  await screen.findByText("7/10");
  fireEvent.click(screen.getByRole("combobox", { name: "查看范围" }));
  fireEvent.click(await screen.findByRole("option", { name: "全组" }));
  await waitFor(() =>
    expect(
      mocks.get.mock.calls.some(
        ([path, args]) =>
          path.endsWith("summary") && args.params.query.scope === "team",
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "查看范围" }));
  fireEvent.click(screen.getByRole("option", { name: "历史成员（已停用）" }));
  await waitFor(() =>
    expect(
      mocks.get.mock.calls.some(
        ([path, args]) =>
          path.endsWith("summary") &&
          args.params.query.userId === "historic-id",
      ),
    ).toBe(true),
  );
  mocks.user.permissions = ["self", "works:read"];
  view.refresh();
  expect(screen.queryByRole("combobox", { name: "查看范围" })).toBeNull();
  await screen.findByRole("heading", { name: "我的贡献" });
});
