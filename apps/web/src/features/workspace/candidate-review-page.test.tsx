import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    tagDisposition: "valid",
    visualClass: "manga",
    visualClassSource: "default",
    classificationRevision: null,
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
  queryClient.clear();
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
            valid_manga: 2,
            neutral_manga: 0,
            blocked_manga: 0,
            photo: 0,
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
    const q = options.params?.query;
    if (path === "/api/candidates") requestedSessions.push(q?.reviewSessionId);
    if (expired && q?.reviewSessionId === `session-${generation}`)
      return {
        error: { message: "审核会话已过期" },
        response: new Response(null, { status: 410 }),
      };
    const items =
      q?.triageGroup === "valid_manga"
        ? q.cursor
          ? [candidate("b", 3)]
          : handled
            ? []
            : [candidate("a", generation === 1 ? 2 : 9)]
        : [];
    return {
      data: {
        items,
        total: q?.triageGroup === "valid_manga" ? 2 : 0,
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
  fireEvent.click(screen.getByRole("checkbox", { name: "选择" }));
  fireEvent.click(screen.getByRole("button", { name: "再加载 24 个" }));
  await screen.findByText("候选 b");
  fireEvent.click(screen.getAllByRole("checkbox", { name: "选择" })[1]);
  expect(screen.getByText("已选择 2 项候选")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新列表" }));
  await waitFor(() => expect(creates).toHaveLength(2));
  await screen.findByText("候选 a");
  fireEvent.click(
    screen.getAllByRole("button", { name: "选择当前已加载内容" })[0],
  );
  expect(screen.getByText("已选择 2 项候选")).toBeTruthy();
  expired = true;
  fireEvent.click(screen.getByRole("button", { name: "再加载 24 个" }));
  await waitFor(() => expect(creates).toHaveLength(3));
  await screen.findByText("候选 a");
  expect(screen.getByText("已选择 2 项候选")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "忽略" }));
  await screen.findByText("已选择 1 项候选");
  expect(actions[0].items).toEqual([
    { id: "a", expectedRevision: 2 },
    { id: "b", expectedRevision: 3 },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "忽略" }));
  await waitFor(() => expect(actions).toHaveLength(2));
  expect(actions[1].items).toEqual([{ id: "b", expectedRevision: 3 }]);
  fireEvent.change(screen.getByPlaceholderText("搜索作者昵称或 @账号"), {
    target: { value: "new" },
  });
  await waitFor(() => expect(screen.queryByText("已选择 1 项候选")).toBeNull());
});
