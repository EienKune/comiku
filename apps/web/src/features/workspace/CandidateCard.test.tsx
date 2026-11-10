import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { CandidateCard } from "./CandidateCard";

vi.mock("./CandidateMediaPreview", () => ({
  CandidateMediaPreview: () => <div />,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fixture = {
  id: "post",
  authorName: "Artist",
  status: "pending",
  hashtags: [],
  tagRuleMatches: [],
  classificationTags: [{ label: "comic", text: "Comic", tone: "success" }],
  canRetryAnalysis: true,
  media: [{ id: "page-one" }, { id: "page-two" }],
  externalPostUrl: "https://example.test/post",
  triageReasons: [],
} as unknown as components["schemas"]["CandidateDto"];

function mount(
  candidate = fixture,
  props: Partial<ComponentProps<typeof CandidateCard>> = {},
) {
  const toggle = vi.fn(),
    retry = vi.fn(),
    order = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CandidateCard
        candidate={candidate}
        statusLabel="Status"
        author={<h2>Artist</h2>}
        description={<p>Description</p>}
        canManage
        selected={false}
        selectionDisabled={false}
        onToggle={toggle}
        onRetryAnalysis={retry}
        onToggleOrdering={order}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { toggle, retry, order };
}

test("partial analysis keeps a successful category and retry, independent of image ordering", () => {
  const { toggle, retry, order } = mount();
  expect(screen.getByRole("button", { name: "Comic" })).toBeTruthy();
  const retryButton = screen.getByRole("button", { name: "重试识别" });
  expect(retryButton.title).toContain("已成功的结果会保留");
  fireEvent.click(retryButton);
  fireEvent.click(screen.getByRole("button", { name: "整理图片" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 Artist 的帖子" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(order).toHaveBeenCalledOnce();
  expect(toggle).toHaveBeenCalledOnce();
  expect(
    document
      .querySelector(".candidate-card-footer")
      ?.lastElementChild?.contains(screen.getByRole("link", { name: "原帖" })),
  ).toBe(true);
});

test("imported cards do not offer selection or page ordering", () => {
  mount({ ...fixture, status: "imported" });
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "整理图片" })).toBeNull();
  expect(screen.getByRole("link", { name: "原帖" })).toBeTruthy();
});

test("non-image body selects once and focuses the native checkbox without adding a parent button", () => {
  const { toggle } = mount();
  fireEvent.click(screen.getByText("Description"));
  expect(toggle).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(screen.getByRole("checkbox"));
  expect(
    document.querySelector(".candidate-card-body")?.getAttribute("role"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(toggle).toHaveBeenCalledTimes(2);
});

test("body selection excludes interactive descendants, prevented events, nonprimary clicks and selected text", () => {
  const { toggle } = mount(fixture, {
    description: (
      <div>
        <p>Description</p>
        <button>展开全文</button>
        <a href="#author">作者</a>
        <label>
          <input aria-label="其他输入" />
          其他标签
        </label>
        <span role="button" tabIndex={0}>
          标记操作
        </span>
        <span data-card-action>额外操作</span>
        <span onClick={(event) => event.preventDefault()}>已处理</span>
      </div>
    ),
  });
  for (const text of [
    "展开全文",
    "作者",
    "其他标签",
    "标记操作",
    "额外操作",
    "已处理",
  ])
    fireEvent.click(screen.getByText(text));
  fireEvent.click(screen.getByText("Description"), { button: 1 });
  vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => "选中的文字",
  } as Selection);
  fireEvent.click(screen.getByText("Description"));
  expect(toggle).not.toHaveBeenCalled();
});

test("portal content bubbling through the body never selects its owning card", () => {
  const { toggle } = mount(fixture, {
    description: createPortal(<span>弹层里的内容</span>, document.body),
  });
  fireEvent.click(screen.getByText("弹层里的内容"));
  expect(toggle).not.toHaveBeenCalled();
});

test("the real tag overview can be inspected without changing post selection", () => {
  const { toggle } = mount({ ...fixture, hashtags: ["BA"] });
  fireEvent.click(screen.getByRole("button", { name: /查看全部原帖标签/ }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "全部原帖标签" })).getByText(
      "#BA",
    ),
  );
  expect(toggle).not.toHaveBeenCalled();
});

test.each([
  ["read only", { canManage: false }, fixture],
  ["imported", {}, { ...fixture, status: "imported" } as typeof fixture],
  ["selection cap or action lock", { selectionDisabled: true }, fixture],
])("body selection respects %s", (_name, props, candidate) => {
  const { toggle } = mount(candidate, props);
  fireEvent.click(screen.getByText("Description"));
  expect(toggle).not.toHaveBeenCalled();
});

test("a selection cap keeps independent edit and retry controls usable and exposes single-image editing", () => {
  const { order, retry, toggle } = mount(
    { ...fixture, media: fixture.media.slice(0, 1) },
    { selectionDisabled: true },
  );
  fireEvent.click(screen.getByRole("button", { name: "整理图片" }));
  fireEvent.click(screen.getByRole("button", { name: "重试识别" }));
  expect(order).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledOnce();
  expect(toggle).not.toHaveBeenCalled();
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
    true,
  );
});

test("selected cards expose a border state without a visible checkbox word, and edited image summaries reopen editing", () => {
  const { order } = mount(fixture, {
    selected: true,
    imageSelection: { selectedCount: 1, totalCount: 2, orderChanged: true },
  });
  expect(
    document
      .querySelector(".candidate-card")
      ?.classList.contains("is-selected"),
  ).toBe(true);
  expect(screen.queryByText("选择")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "入库图片：1 / 2 张" }));
  expect(order).toHaveBeenCalledOnce();
});

test("order-only summaries remain distinct from subset summaries", () => {
  mount(fixture, {
    imageSelection: { selectedCount: 2, totalCount: 2, orderChanged: true },
  });
  expect(screen.getByRole("button", { name: "入库顺序已调整" })).toBeTruthy();
});

test("a page edit lock disables both editor entries without disabling original source navigation", () => {
  const { order } = mount(fixture, {
    editingDisabled: true,
    imageSelection: { selectedCount: 1, totalCount: 2, orderChanged: false },
  });
  fireEvent.click(screen.getByRole("button", { name: "整理图片" }));
  fireEvent.click(screen.getByRole("button", { name: "入库图片：1 / 2 张" }));
  expect(order).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "原帖" }).getAttribute("href")).toBe(
    "https://example.test/post",
  );
});
