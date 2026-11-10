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

const user: CurrentUser = {
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
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
function Shell() {
  const [actions, setActions] = useState<TopbarActionRegistration | null>(null);
  return (
    <TopbarActionsContext.Provider value={setActions}>
      <div>{actions?.content}</div>
      <Outlet context={user} />
    </TopbarActionsContext.Provider>
  );
}
function candidate(
  id: string,
  revision: number,
): components["schemas"]["CandidateDto"] {
  return {
    id,
    revision,
    authorId: "author",
    authorName: "合成作者",
    authorHandle: null,
    authorAvatarAvailable: false,
    platform: "fixture",
    sourceLanguage: "ja",
    sourceAdapters: [],
    hashtags: [],
    triageGroup: "priority",
    triageReasons: ["priority_tag"],
    tagRuleMatches: [],
    externalPostId: id,
    externalPostUrl: null,
    text: `候选 ${id}`,
    referencedPostType: null,
    referencedPostId: null,
    status: "pending",
    media: [],
    postedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    reviewedAt: null,
    workId: null,
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
  window.localStorage.clear();
});

test("ignored content supports loaded selection, cancellation and revision-aware bulk restore while imported content is read-only", async () => {
  const requests: unknown[] = [];
  vi.spyOn(client, "POST").mockImplementation((async (
    path: string,
    options: { body?: unknown },
  ) => {
    if (path === "/api/candidates/actions") {
      requests.push(options.body);
      return {
        data: {
          results: [{ id: "ignored", outcome: "succeeded", message: null }],
        },
        response: new Response(null, { status: 200 }),
      };
    }
    return {
      data: {
        sessionId: crypto.randomUUID(),
        expiresAt: "2030-01-01T00:00:00Z",
        counts: { priority: 0, uncertain: 0, low_priority: 0 },
      },
      response: new Response(null, { status: 201 }),
    };
  }) as never);
  vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options?: { params?: { query?: { status?: string } } },
  ) => {
    if (path === "/api/source-fetch/progress")
      return {
        data: { active: null, lastManual: null },
        response: new Response(null, { status: 200 }),
      };
    const status = options?.params?.query?.status;
    const items =
      status === "discarded"
        ? [{ ...candidate("ignored", 7), status }]
        : status === "imported"
          ? [{ ...candidate("imported", 9), status }]
          : [];
    return {
      data: {
        items,
        total: items.length,
        nextCursor: null,
        analysisPending: false,
      },
      response: new Response(null, { status: 200 }),
    };
  }) as never);
  render(
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
  fireEvent.click(screen.getByRole("combobox", { name: "候选状态" }));
  fireEvent.click(screen.getByRole("option", { name: "已忽略" }));
  await screen.findByText("候选 ignored");
  fireEvent.click(screen.getByRole("button", { name: /选择当前已加载内容/ }));
  expect(
    (
      screen.getByRole("checkbox", {
        name: /选择 .* 的帖子/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /取消当前已加载选择/ }));
  expect(
    (
      screen.getByRole("checkbox", {
        name: /选择 .* 的帖子/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /选择当前已加载内容/ }));
  fireEvent.click(screen.getByRole("button", { name: /恢复所选/ }));
  await waitFor(() =>
    expect(requests).toEqual([
      { action: "restore", items: [{ id: "ignored", expectedRevision: 7 }] },
    ]),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "候选状态" }));
  fireEvent.click(screen.getByRole("option", { name: "已入库" }));
  await screen.findByText("候选 imported");
  expect(screen.queryByRole("checkbox", { name: /选择 .* 的帖子/ })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /选择当前已加载内容|恢复所选/ }),
  ).toBeNull();
});

test("80 CJK characters can expand when narrow and stop offering expansion after resizing to fit", async () => {
  let narrow = true;
  const observations = new Set<{
    element: Element;
    callback: ResizeObserverCallback;
    observer: ResizeObserver;
  }>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        observations.add({
          element,
          callback: this.callback,
          observer: this as unknown as ResizeObserver,
        });
      }
      disconnect() {
        for (const observation of observations)
          if (observation.observer === (this as unknown as ResizeObserver))
            observations.delete(observation);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".candidate-description > p")
        ? narrow
          ? 160
          : 48
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".candidate-description > p")
        ? this.classList.contains("candidate-description__collapsed") && narrow
          ? 72
          : narrow
            ? 160
            : 48
        : 0;
    },
  );
  const text = "中文正文".repeat(20);
  vi.spyOn(client, "POST").mockResolvedValue({
    data: {
      sessionId: "text",
      expiresAt: "2030-01-01T00:00:00Z",
      counts: { priority: 1, uncertain: 0, low_priority: 0 },
    },
    response: new Response(null, { status: 201 }),
  } as never);
  vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options?: { params?: { query?: { triageGroup?: string } } },
  ) => {
    if (path === "/api/source-fetch/progress")
      return {
        data: { active: null, lastManual: null },
        response: new Response(null, { status: 200 }),
      };
    const priority = options?.params?.query?.triageGroup === "priority";
    return {
      data: {
        items: priority ? [{ ...candidate("text", 1), text }] : [],
        total: priority ? 1 : 0,
        nextCursor: null,
        analysisPending: false,
      },
      response: new Response(null, { status: 200 }),
    };
  }) as never);
  const view = render(
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
  const expand = await screen.findByRole("button", { name: "展开全文" });
  fireEvent.click(expand);
  expect(
    screen
      .getByText(text)
      .classList.contains("candidate-description__collapsed"),
  ).toBe(false);
  expect(screen.getByText(text).textContent).toBe(text);
  expect(
    screen
      .getByRole("button", { name: "收起全文" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  narrow = false;
  act(() => {
    for (const { element, callback, observer } of observations)
      callback(
        [
          {
            target: element,
            contentRect: { width: 900 },
          } as unknown as ResizeObserverEntry,
        ],
        observer,
      );
  });
  expect(
    screen.queryByRole("button", { name: /展开全文|收起全文/ }),
  ).toBeNull();
  narrow = true;
  act(() => {
    for (const { element, callback, observer } of observations)
      callback(
        [
          {
            target: element,
            contentRect: { width: 220 },
          } as unknown as ResizeObserverEntry,
        ],
        observer,
      );
  });
  expect(
    screen
      .getByRole("button", { name: "展开全文" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  view.unmount();
  expect(observations.size).toBe(0);
  vi.unstubAllGlobals();
});

test("shared sessions preserve first revisions across pages, refresh and expiry; partial failures remain selected", async () => {
  let generation = 0;
  let expired = false;
  let handled = false;
  const creates: unknown[] = [];
  const requestedSessions: (string | undefined)[] = [];
  const actions: { items: { id: string; expectedRevision: number }[] }[] = [];
  vi.spyOn(client, "POST").mockImplementation((async (
    path: string,
    options: { body: { items: { id: string; expectedRevision: number }[] } },
  ) => {
    if (path === "/api/candidates/review-sessions") {
      generation++;
      creates.push(options.body);
      expired = false;
      return {
        data: {
          sessionId: `session-${generation}`,
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
          counts: {
            priority: 2,
            uncertain: 0,
            low_priority: 0,
          },
        },
        response: new Response(null, { status: 201 }),
      };
    }
    actions.push(options.body);
    handled = true;
    return {
      data: {
        results: options.body.items.map((item) => ({
          id: item.id,
          outcome: item.id === "a" ? "succeeded" : "conflict",
          message: null,
        })),
      },
      response: new Response(null, { status: 200 }),
    };
  }) as never);
  vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options: {
      params?: {
        query?: {
          triageGroup?: string;
          cursor?: string;
          reviewSessionId?: string;
        };
      };
    },
  ) => {
    if (path === "/api/source-fetch/progress")
      return {
        data: { active: null, lastManual: null },
        response: new Response(null, { status: 200 }),
      };
    if (path === "/api/authors")
      return {
        data: {
          items: [
            { id: "new-author", displayName: "新作者", externalAccounts: [] },
          ],
          nextCursor: null,
          total: 1,
        },
        response: new Response(),
      } as never;
    const q = options.params?.query;
    if (path === "/api/candidates") requestedSessions.push(q?.reviewSessionId);
    if (expired && q?.reviewSessionId === `session-${generation}`)
      return {
        error: { message: "审核会话已过期" },
        response: new Response(null, { status: 410 }),
      };
    const items =
      q?.triageGroup === "priority"
        ? q.cursor
          ? [candidate("b", 3)]
          : handled
            ? []
            : [candidate("a", generation === 1 ? 2 : 9)]
        : [];
    return {
      data: {
        items,
        total: q?.triageGroup === "priority" ? (handled ? 0 : 2) : 0,
        nextCursor: items[0]?.id === "a" ? "next" : null,
        analysisPending: false,
      },
      response: new Response(null, { status: 200 }),
    };
  }) as never);
  render(
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
  await screen.findByText("候选 a");
  expect(creates).toHaveLength(1);
  expect(new Set(requestedSessions).size).toBe(1);
  fireEvent.click(screen.getByRole("checkbox", { name: /选择 .* 的帖子/ }));
  fireEvent.click(screen.getByRole("button", { name: "再加载 24 个" }));
  await screen.findByText("候选 b");
  fireEvent.click(
    screen.getAllByRole("checkbox", { name: /选择 .* 的帖子/ })[1],
  );
  expect(screen.getByText("已选择 2 项候选")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
  await waitFor(() => expect(creates).toHaveLength(2));
  await screen.findByText("候选 a");
  expect(
    screen.getByRole("button", { name: "取消当前已加载选择" }),
  ).toBeTruthy();
  expect(screen.getByText("已选择 2 项候选")).toBeTruthy();
  expired = true;
  fireEvent.click(screen.getByRole("button", { name: "再加载 24 个" }));
  await waitFor(() => expect(creates).toHaveLength(3));
  await screen.findByText("候选 a");
  expect(screen.getByText("已选择 2 项候选")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "忽略所选（2）" }));
  expect(actions).toHaveLength(0);
  let confirmation = screen.getByRole("dialog", {
    name: "忽略所选 2 个帖子？",
  });
  expect(document.activeElement).toBe(
    within(confirmation).getByRole("button", { name: "取消" }),
  );
  fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
  expect(actions).toHaveLength(0);
  expect(screen.getByText("已选择 2 项候选")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "忽略所选（2）" }));
  confirmation = screen.getByRole("dialog", { name: "忽略所选 2 个帖子？" });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "忽略 2 个帖子" }),
  );
  await screen.findByText("已选择 1 项候选");
  await screen.findByRole("button", { name: "优先审核 0" });
  expect(actions[0].items).toEqual([
    { id: "a", expectedRevision: 2 },
    { id: "b", expectedRevision: 3 },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "忽略所选（1）" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "忽略 1 个帖子",
    }),
  );
  await waitFor(() => expect(actions).toHaveLength(2));
  expect(actions[1].items).toEqual([{ id: "b", expectedRevision: 3 }]);
  const input = screen.getByRole("combobox", { name: "搜索并选择作者" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "new" } });
  expect(screen.getByText("已选择 1 项候选")).toBeTruthy();
  fireEvent.click(await screen.findByRole("option", { name: "新作者" }));
  await waitFor(() => expect(screen.queryByText("已选择 1 项候选")).toBeNull());
});

test("three section navigation expands low priority, remembers its state, and removes photo controls", async () => {
  vi.spyOn(client, "POST").mockResolvedValue({
    data: {
      sessionId: "three",
      expiresAt: "2030-01-01T00:00:00Z",
      counts: { priority: 0, uncertain: 1, low_priority: 1 },
    },
    response: new Response(null, { status: 201 }),
  } as never);
  vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options?: { params?: { query?: { triageGroup?: string } } },
  ) => {
    if (path === "/api/source-fetch/progress")
      return {
        data: { active: null, lastManual: null },
        response: new Response(null, { status: 200 }),
      };
    const group = options?.params?.query?.triageGroup;
    return {
      data: {
        items:
          group === "priority"
            ? []
            : [
                {
                  ...candidate(group ?? "timeline", 1),
                  triageGroup: group,
                  triageReasons: ["insufficient_evidence"],
                },
              ],
        total: group === "priority" ? 0 : 1,
        nextCursor: null,
        analysisPending: false,
      },
      response: new Response(null, { status: 200 }),
    };
  }) as never);
  const mount = () =>
    render(
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
  const first = mount();
  await screen.findByRole("navigation", { name: "候选审核区域" });
  const low = () =>
    document.getElementById(
      "candidate-section-low_priority",
    ) as HTMLDetailsElement;
  expect(low().open).toBe(false);
  expect(low().querySelector("summary")?.textContent).toBe("低优先级1");
  expect(screen.queryByText("候选 low_priority")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "低优先级 1" }));
  await screen.findByText("候选 low_priority");
  expect(low().open).toBe(true);
  expect(screen.queryByRole("button", { name: "标记为照片" })).toBeNull();
  expect(screen.queryByText("现实照片")).toBeNull();
  expect(screen.getByRole("button", { name: "审核规则" })).toBeTruthy();
  first.unmount();
  mount();
  await screen.findByRole("navigation", { name: "候选审核区域" });
  expect(low().open).toBe(true);
});
