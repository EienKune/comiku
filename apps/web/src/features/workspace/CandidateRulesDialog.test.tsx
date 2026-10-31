import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { CandidateRulesDialog } from "./CandidateRulesDialog";

const group = {
  id: "rule",
  name: "BA 作品",
  kind: "valid",
  enabled: true,
  revision: 2,
  aliases: ["BA", "BlueArchive", "ブルアカ", "블루아카"],
};
const caches: QueryClient[] = [];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  caches.splice(0).forEach((cache) => cache.clear());
});
function mount(canManage: boolean) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  caches.push(cache);
  cache.setQueryData(["candidate-review-session", {}], {
    sessionId: "stable-session",
  });
  const invalidate = vi.spyOn(cache, "invalidateQueries");
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
  ) => ({
    data: path.endsWith("review-policy")
      ? {
          modelKey: "fixture",
          policyKey: "p1",
          classes: [
            {
              label: "illustration",
              text: "合成插画",
              tone: "success",
              triageGroup: "priority",
            },
          ],
        }
      : [
          group,
          {
            ...group,
            id: "old",
            name: "历史组",
            kind: "gray",
            aliases: ["old"],
          },
        ],
    response: new Response(null, { status: 200 }),
  })) as never);
  const close = vi.fn();
  render(
    <QueryClientProvider client={cache}>
      <CandidateRulesDialog canManage={canManage} onClose={close} />
    </QueryClientProvider>,
  );
  return { cache, invalidate, get, close };
}

test("rules open in one modal, form appears only after editing, and saving keeps the review session", async () => {
  const { cache, invalidate } = mount(true);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    data: group,
    response: new Response(null, { status: 200 }),
  } as never);
  const dialog = screen.getByRole("dialog", { name: "审核规则" });
  await within(dialog).findByText("BA 作品");
  expect(screen.queryByRole("textbox", { name: "标签组名称" })).toBeNull();
  expect(screen.getByText("4 个别名")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑 BA 作品" }));
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "标签组名称" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "标签组名称" }), {
    target: { value: "目标作品" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "规则类型" }));
  expect(screen.queryByRole("option", { name: "历史灰名单" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "规则类型" }), {
    key: "Escape",
  });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText("规则已保存，刷新列表后应用新分区。");
  expect(patch).toHaveBeenCalledWith(
    "/api/candidates/tag-groups/{id}",
    expect.objectContaining({
      body: expect.objectContaining({ name: "目标作品", expectedRevision: 2 }),
    }),
  );
  expect(cache.getQueryData(["candidate-review-session", {}])).toEqual({
    sessionId: "stable-session",
  });
  expect(invalidate).not.toHaveBeenCalled();
});

test("ordinary readers get model mapping and explanations without requesting administrator rules", async () => {
  const { get, close } = mount(false);
  await screen.findByText("合成插画");
  expect(
    screen.getByText("所有区域均可人工入库。分区只决定审核顺序。"),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "新增标签组" })).toBeNull();
  const reads: readonly unknown[][] = get.mock.calls;
  expect(reads.some(([path]) => path === "/api/candidates/tag-groups")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭审核规则" }));
  expect(close).toHaveBeenCalledOnce();
});

test("new rules never offer gray while existing gray records remain editable", async () => {
  mount(true);
  await screen.findByText("历史组");
  fireEvent.click(screen.getByRole("button", { name: "新增标签组" }));
  fireEvent.click(screen.getByRole("combobox", { name: "规则类型" }));
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["优先标签", "降级标签"]);
  fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑 历史组" }));
  fireEvent.click(screen.getByRole("combobox", { name: "规则类型" }));
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "历史灰名单" })).toBeTruthy(),
  );
});
