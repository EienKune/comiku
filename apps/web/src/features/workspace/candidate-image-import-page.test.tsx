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
  items: { id: string; expectedRevision: number; mediaIds: string[] }[];
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
  fireEvent.click(within(editor).getByRole("button", { name: "上移原图 3" }));
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
