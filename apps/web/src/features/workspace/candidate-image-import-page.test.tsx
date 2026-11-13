import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { CurrentUser, components } from "@comiku/api-client";
import { client, queryClient } from "../account/api";
import {
  TopbarActionsContext,
  type TopbarActionRegistration,
} from "../account/topbar-actions";
import { CandidatesPage } from "./BusinessPages";
import {
  compositionApi,
  CompositionRequestError,
} from "./candidate-composition-api";

const actor = {
  id: "actor",
  username: "source",
  displayName: "图源",
  roles: ["source"],
  languageCapabilities: [],
  isActive: true,
  mustChangePassword: false,
  canSkipProofreading: false,
  revision: 0,
  permissions: ["candidates:read", "candidates:manage"],
} as CurrentUser;
const post = (
  id: string,
  revision = 2,
): components["schemas"]["CandidateDto"] => ({
  id,
  revision,
  authorId: "author",
  authorName: `作者 ${id}`,
  authorHandle: null,
  authorAvatarAvailable: false,
  platform: "fixture",
  sourceLanguage: "ja",
  sourceAdapters: [],
  hashtags: [],
  triageGroup: "priority",
  triageReasons: [],
  tagRuleMatches: [],
  externalPostId: id,
  externalPostUrl: null,
  text: `正文 ${id}`,
  referencedPostType: null,
  referencedPostId: null,
  status: "pending",
  media: ["one", "two", "three"].map((key, orderIndex) => ({
    id: `${id}-${key}`,
    externalMediaId: key,
    orderIndex,
    width: 1,
    height: 1,
    mediaType: "photo",
  })),
  postedAt: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-01-01T00:00:00Z",
  reviewedAt: null,
  workId: null,
  works: [],
});
function Shell() {
  const [actions, setActions] = useState<TopbarActionRegistration | null>(null);
  return (
    <TopbarActionsContext.Provider value={setActions}>
      <div>{actions?.content}</div>
      <Outlet context={actor} />
    </TopbarActionsContext.Provider>
  );
}
function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/candidates"]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/candidates" element={<CandidatesPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
type Manifest = {
  action: string;
  items: {
    id: string;
    expectedRevision: number;
    mediaIds: string[];
    series?: components["schemas"]["WorkSeriesImportIntentDto"];
  }[];
};
function fixture(items = [post("a")]) {
  const state = {
    items,
    latest: items[0],
    generation: 0,
    writes: [] as Manifest[],
  };
  const dispatch = vi.fn(
    async (
      body: Manifest,
    ): Promise<{
      results: { id: string; outcome: string; message: string | null }[];
    }> => ({
      results: body.items.map(({ id }) => ({
        id,
        outcome: "succeeded",
        message: null,
      })),
    }),
  );
  vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options?: { params?: { query?: { triageGroup?: string } } },
  ) => {
    if (path === "/api/work-series")
      return {
        data: { items: [], total: 0, nextCursor: null },
        response: new Response(),
      };
    if (path === "/api/source-fetch/progress")
      return {
        data: { active: null, lastManual: null },
        response: new Response(),
      };
    if (path === "/api/candidates/{id}")
      return { data: state.latest, response: new Response() };
    if (path.includes("/media/"))
      return {
        data: { url: "https://example.invalid/synthetic.png", status: "ready" },
        response: new Response(),
      };
    const priority = options?.params?.query?.triageGroup === "priority";
    return {
      data: {
        items: priority ? state.items : [],
        total: priority ? state.items.length : 0,
        nextCursor: null,
        analysisPending: false,
      },
      response: new Response(),
    };
  }) as never);
  vi.spyOn(client, "POST").mockImplementation((async (
    path: string,
    options: { body: Manifest },
  ) => {
    if (path === "/api/candidates/review-sessions")
      return {
        data: {
          sessionId: `session-${++state.generation}`,
          expiresAt: "2030-01-01T00:00:00Z",
          counts: {
            priority: state.items.length,
            uncertain: 0,
            low_priority: 0,
          },
        },
        response: new Response(),
      };
    if (path !== "/api/candidates/actions")
      throw new Error(`Unexpected write: ${path}`);
    state.writes.push(structuredClone(options.body));
    return { data: await dispatch(options.body), response: new Response() };
  }) as never);
  return { state, dispatch };
}
async function editA() {
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "整理图片" }))[0],
  );
  return screen.getByRole("dialog", { name: "整理入库图片" });
}
function selectA() {
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 作者 a 的帖子" }));
}
function beginImport() {
  fireEvent.click(screen.getByRole("button", { name: /入库所选/ }));
  return screen.getByRole("dialog", { name: "确认入库" });
}

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
  queryClient.clear();
  window.localStorage.clear();
});

test("Apply remains local across snapshot refresh; final confirmation atomically imports the original ordered subset", async () => {
  const { state } = fixture();
  mount();
  const editor = await editA();
  fireEvent.click(within(editor).getByRole("checkbox", { name: "选入原图 2" }));
  fireEvent.keyDown(
    within(editor).getByRole("button", { name: "拖动 原图 3 调整顺序" }),
    { key: "ArrowUp" },
  );
  fireEvent.click(within(editor).getByRole("button", { name: "应用调整" }));
  expect(state.writes).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
  await waitFor(() => expect(state.generation).toBe(2));
  const reopened = await editA();
  expect(
    (
      within(reopened).getByRole("checkbox", {
        name: "选入原图 2",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(within(reopened).getByRole("button", { name: "取消" }));
  selectA();
  expect(
    screen
      .getByRole("button", { name: /入库所选/ })
      .closest(".workspace-topbar-actions"),
  ).toBeTruthy();
  const confirmation = beginImport();
  expect(state.writes).toEqual([]);
  expect(within(confirmation).getByText("入库 2 / 3 张")).toBeTruthy();
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "确认创建 1 部作品" }),
  );
  await waitFor(() =>
    expect(state.writes).toEqual([
      {
        action: "import",
        items: [
          { id: "a", expectedRevision: 2, mediaIds: ["a-three", "a-one"] },
        ],
      },
    ]),
  );
  await screen.findByText("1 项入库完成");
});

test("uncertain response locks editing and retries the identical manifest after reopening confirmation", async () => {
  const { state, dispatch } = fixture();
  dispatch.mockRejectedValueOnce(new TypeError("network unavailable"));
  mount();
  await screen.findByText("正文 a");
  selectA();
  let dialog = beginImport();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认创建 1 部作品" }),
  );
  await screen.findByRole("button", { name: "重试本次入库" });
  fireEvent.click(within(dialog).getByRole("button", { name: "返回候选池" }));
  expect(
    (screen.getByRole("button", { name: "整理图片" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "查看本次入库" }));
  dialog = screen.getByRole("dialog", { name: "确认入库" });
  fireEvent.click(within(dialog).getByRole("button", { name: "重试本次入库" }));
  await screen.findByText("1 项入库完成");
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
});

test("partial import removes only completed selections, preserving the failed post's local image draft", async () => {
  const { state, dispatch } = fixture([post("a"), post("b")]);
  dispatch.mockImplementation(async (body) => ({
    results: body.items.map(({ id }) => ({
      id,
      outcome: id === "a" ? "succeeded" : "conflict",
      message: id === "a" ? null : "版本已变化",
    })),
  }));
  mount();
  await screen.findByText("正文 b");
  fireEvent.click(screen.getAllByRole("button", { name: "整理图片" })[1]);
  let editor = screen.getByRole("dialog", { name: "整理入库图片" });
  fireEvent.click(within(editor).getByRole("checkbox", { name: "选入原图 1" }));
  fireEvent.click(within(editor).getByRole("button", { name: "应用调整" }));
  selectA();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 作者 b 的帖子" }));
  const dialog = beginImport();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认创建 2 部作品" }),
  );
  await screen.findByText("版本已变化");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "返回检查未完成项" }),
  );
  await screen.findByText("已选择 1 项候选");
  fireEvent.click(screen.getAllByRole("button", { name: "整理图片" })[1]);
  editor = screen.getByRole("dialog", { name: "整理入库图片" });
  expect(
    (
      within(editor).getByRole("checkbox", {
        name: "选入原图 1",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(state.writes[0].items[1].mediaIds).toEqual(["b-two", "b-three"]);
});

test("a revision change never silently rebases a draft; only explicit reload starts a newly reviewed selection", async () => {
  const { state } = fixture();
  mount();
  const editor = await editA();
  fireEvent.click(within(editor).getByRole("checkbox", { name: "选入原图 2" }));
  fireEvent.click(within(editor).getByRole("button", { name: "应用调整" }));
  selectA();
  state.latest = post("a", 3);
  state.items = [state.latest];
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["candidates"] });
  });
  const changed = await editA();
  expect(
    (
      within(changed).getByRole("button", {
        name: "应用调整",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    within(changed).getByRole("button", { name: "放弃调整并加载最新图片" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "应用调整" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "应用调整" }));
  const dialog = beginImport();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认创建 1 部作品" }),
  );
  await screen.findByText("1 项入库完成");
  expect(state.writes[0].items[0]).toEqual({
    id: "a",
    expectedRevision: 3,
    mediaIds: ["a-one", "a-two", "a-three"],
  });
});

test("single-post series creation stays optional and freezes its exact intent across an uncertain response", async () => {
  const { state, dispatch } = fixture();
  dispatch.mockRejectedValueOnce(new TypeError("network unavailable"));
  mount();
  await screen.findByText("正文 a");
  selectA();
  let dialog = beginImport();
  const choose = within(dialog).getByRole("combobox", {
    name: "关联系列（可选）",
  });
  await waitFor(() =>
    expect((choose as HTMLButtonElement).disabled).toBe(false),
  );
  expect(choose.textContent).toBe("不关联系列");
  fireEvent.click(choose);
  fireEvent.click(within(dialog).getByRole("option", { name: "新建系列…" }));
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "新系列名称" }),
    { target: { value: "放学后的约定" } },
  );
  fireEvent.change(within(dialog).getByRole("textbox", { name: "章节标签" }), {
    target: { value: "前篇" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认创建 1 部作品" }),
  );
  await screen.findByRole("button", { name: "重试本次入库" });
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "新系列名称",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  expect(state.writes[0].items[0].series).toMatchObject({
    createTitle: "放学后的约定",
    label: "前篇",
  });
  expect(state.writes[0].items[0].series?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  fireEvent.click(within(dialog).getByRole("button", { name: "返回候选池" }));
  fireEvent.click(screen.getByRole("button", { name: "查看本次入库" }));
  dialog = screen.getByRole("dialog", { name: "确认入库" });
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "新系列名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("放学后的约定");
  fireEvent.click(within(dialog).getByRole("button", { name: "重试本次入库" }));
  await screen.findByText("1 项入库完成");
  expect(state.writes[1]).toEqual(state.writes[0]);
});

test("topbar split creates every named work through a single confirmation and displays all result links", async () => {
  const { state } = fixture();
  const submit = vi
    .spyOn(compositionApi, "submit")
    .mockImplementation(async (intent) => ({
      idempotencyKey: intent.idempotencyKey,
      mode: "split",
      works: intent.works.map((work, index) => ({
        workId: `created-${index}`,
        workNumber: index + 10,
        title: work.title,
        imageCount: work.mediaIds.length,
        sourceCandidateIds: ["a"],
      })),
      candidates: [
        {
          id: "a",
          revision: 3,
          status: "imported",
          workIds: ["created-0", "created-1"],
        },
      ],
      unadoptedMediaIds: [],
    }));
  mount();
  await screen.findByText("正文 a");
  selectA();
  fireEvent.click(screen.getByRole("button", { name: "拆分入库" }));
  let dialog = screen.getByRole("dialog", { name: "拆分入库" });
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "选择 来源帖 1 · 原图 2" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "新建作品" }));
  const titles = within(dialog).getAllByRole("textbox");
  fireEvent.change(titles[0], { target: { value: "第一作" } });
  fireEvent.change(titles[1], { target: { value: "第二作" } });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "创建 2 部作品" }),
  );
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  dialog = screen.getByRole("dialog", { name: "确认创建 2 部作品" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "确认创建 2 部作品" }),
  );
  const result = await screen.findByRole("dialog", { name: "已创建作品" });
  expect(
    within(result)
      .getByRole("link", { name: /第一作/ })
      .getAttribute("href"),
  ).toBe("/works/created-0");
  expect(
    within(result)
      .getByRole("link", { name: /第二作/ })
      .getAttribute("href"),
  ).toBe("/works/created-1");
  expect(submit.mock.calls[0][0].works.map((work) => work.mediaIds)).toEqual([
    ["a-one", "a-three"],
    ["a-two"],
  ]);
  expect(state.writes).toEqual([]);
});

test("composition eligibility gives focusable disabled reasons and cancellation keeps the local named draft", async () => {
  fixture([post("a"), { ...post("b"), authorId: "another" }]);
  mount();
  await screen.findByText("正文 b");
  selectA();
  expect(
    (screen.getByRole("button", { name: "合并入库" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const wrapper = screen.getByRole("button", {
    name: "合并入库",
  }).parentElement!;
  expect(wrapper.tabIndex).toBe(0);
  fireEvent.focus(wrapper);
  expect(wrapper.getAttribute("aria-describedby")).toBeTruthy();
  expect(screen.getByRole("tooltip").textContent).toBe("至少选择 2 个帖子");
  fireEvent.blur(wrapper);
  fireEvent.click(screen.getByRole("button", { name: "拆分入库" }));
  let editor = screen.getByRole("dialog", { name: "拆分入库" });
  fireEvent.change(within(editor).getByRole("textbox"), {
    target: { value: "保留的名称" },
  });
  fireEvent.click(within(editor).getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("button", { name: "拆分入库" }));
  editor = screen.getByRole("dialog", { name: "拆分入库" });
  expect((within(editor).getByRole("textbox") as HTMLInputElement).value).toBe(
    "保留的名称",
  );
  fireEvent.click(within(editor).getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 作者 b 的帖子" }));
  fireEvent.focus(
    screen.getByRole("button", { name: "合并入库" }).parentElement!,
  );
  expect(screen.getByRole("tooltip").textContent).toBe(
    "所选帖子作者不同，无法合并",
  );
});

test("lost composition response locks conflicting actions and 404 lookup retries the identical intent while excluded selections remain pending", async () => {
  fixture([post("a"), post("b"), post("c")]);
  const submit = vi
    .spyOn(compositionApi, "submit")
    .mockRejectedValueOnce(new TypeError("response lost"));
  vi.spyOn(compositionApi, "lookup").mockRejectedValue(
    new CompositionRequestError(404, "未找到回执"),
  );
  mount();
  await screen.findByText("正文 c");
  for (const id of ["a", "b", "c"])
    fireEvent.click(
      screen.getByRole("checkbox", { name: `选择 作者 ${id} 的帖子` }),
    );
  fireEvent.click(screen.getByRole("button", { name: "合并入库" }));
  let dialog = screen.getByRole("dialog", { name: "合并入库" });
  for (const n of [1, 2, 3])
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: `采用 来源帖 3 · 原图 ${n}`,
      }),
    );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "移出本次合并并保留待处理" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "合并为 1 部作品" }),
  );
  dialog = screen.getByRole("dialog", { name: "确认合并入库" });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认合并入库" }));
  await screen.findByRole("button", { name: "查询本次结果" });
  const frozen = structuredClone(submit.mock.calls[0][0]);
  fireEvent.click(within(dialog).getByRole("button", { name: "返回候选池" }));
  expect(
    (screen.getByRole("button", { name: /入库所选/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getAllByRole("button", {
        name: "整理图片",
      })[0] as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "取消选择" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "查看本次拆合入库" }));
  dialog = screen.getByRole("dialog", { name: "确认合并入库" });
  fireEvent.click(within(dialog).getByRole("button", { name: "查询本次结果" }));
  await screen.findByText("未找到回执");
  expect(screen.queryByRole("button", { name: "返回调整" })).toBeNull();
  submit.mockImplementation(async (intent) => ({
    idempotencyKey: intent.idempotencyKey,
    mode: "merge",
    works: [
      {
        workId: "merged",
        workNumber: 12,
        title: null,
        imageCount: 6,
        sourceCandidateIds: ["a", "b"],
      },
    ],
    candidates: ["a", "b"].map((id) => ({
      id,
      revision: 3,
      status: "imported",
      workIds: ["merged"],
    })),
    unadoptedMediaIds: [],
  }));
  fireEvent.click(within(dialog).getByRole("button", { name: "重试本次入库" }));
  await screen.findByRole("dialog", { name: "已创建作品" });
  expect(submit.mock.calls[1][0]).toEqual(frozen);
  expect(frozen.candidates.map((source) => source.id)).toEqual(["a", "b"]);
  fireEvent.click(screen.getByRole("button", { name: "返回候选池" }));
  expect(screen.getByText("已选择 1 项候选")).toBeTruthy();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "选择 作者 c 的帖子",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test("imported candidate lists link every created work instead of relying on the legacy single workId", async () => {
  const imported = {
    ...post("a"),
    status: "imported",
    workId: null,
    works: [
      { id: "first", workNumber: 21, title: "上篇" },
      { id: "second", workNumber: 22, title: "下篇" },
    ],
  } as components["schemas"]["CandidateDto"];
  fixture([imported]);
  mount();
  expect(
    (await screen.findByRole("link", { name: "上篇" })).getAttribute("href"),
  ).toBe("/works/first");
  expect(screen.getByRole("link", { name: "下篇" }).getAttribute("href")).toBe(
    "/works/second",
  );
});
