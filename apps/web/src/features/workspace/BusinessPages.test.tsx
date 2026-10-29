import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { CurrentUser } from "@comiku/api-client";
import { client, queryClient } from "../account/api";
import {
  TopbarActionsContext,
  type TopbarActionRegistration,
} from "../account/topbar-actions";
import {
  BusinessAuditPage,
  CandidatesPage,
  DashboardPage,
  ReviewDetailPage,
  WorkDetailPage,
  WorksPage,
} from "./BusinessPages";

function WorkspaceTestShell({ user }: { user: CurrentUser }) {
  const [topbarActions, setTopbarActions] =
    useState<TopbarActionRegistration | null>(null);
  return (
    <TopbarActionsContext.Provider value={setTopbarActions}>
      <div aria-label="顶部工具栏">{topbarActions?.content}</div>
      <Outlet context={user} />
    </TopbarActionsContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
  window.localStorage.clear();
});

test("work view filters role vacancies and batch claims selected works from the topbar", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "translator",
    displayName: "译者",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:translate"],
  };
  const list = {
    items: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        workNumber: 10,
        authorId: "00000000-0000-4000-8000-000000000020",
        authorName: "测试作者",
        title: "待认领作品",
        sourcePostUrl: "https://example.invalid/work",
        sourceLanguage: "ja",
        collaborationMode: "single",
        workflowStatus: "pending_translate",
        reviewStatus: "normal",
        priority: 0,
        revision: 3,
        editorEpoch: 0,
        typesetHandoffStartedAt: null,
        translationAttentionStage: null,
        translationAttentionVersionNumber: null,
        imageCount: 1,
        coverImageId: null,
        participantCount: 0,
        assignedStages: [],
        personalTasks: [
          {
            stage: "translate",
            readyToStart: true,
            contributionCurrent: false,
          },
        ],
        importedAt: "2026-09-08T00:00:00.000Z",
        publishedAt: null,
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
    ],
    total: 1,
    claimCounts: [{ stage: "translate", count: 1 }],
    phaseCounts: [
      { phase: "translation", count: 1 },
      { phase: "proofread", count: 0 },
      { phase: "typeset", count: 0 },
      { phase: "pending_publish", count: 0 },
      { phase: "published", count: 0 },
    ],
    nextCursor: null,
  };
  vi.spyOn(client, "GET").mockResolvedValue({
    data: list,
    response: new Response(null, { status: 200 }),
  } as never);
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: {
      results: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          outcome: "succeeded",
          message: null,
        },
      ],
    },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/works"]}>
        <Routes>
          <Route element={<WorkspaceTestShell user={user} />}>
            <Route path="/works" element={<WorksPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("待认领作品")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "工作视图" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen.getByRole("tab", { name: /我的待办/ }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(await screen.findByRole("tab", { name: "可接翻译 1" }));
  expect(await screen.findByText("待认领作品")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "批量认领" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认认领" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/works/stages/claims",
      expect.objectContaining({
        body: expect.objectContaining({
          stage: "translate",
          items: [
            expect.objectContaining({
              id: "00000000-0000-4000-8000-000000000010",
              expectedRevision: 3,
            }),
          ],
        }),
      }),
    ),
  );
});

test("dashboard shows personal tasks and distinct role recommendations, refreshing both after a claim", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "member",
    displayName: "译者",
    roles: ["translator", "typesetter"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: [
      "dashboard:read",
      "works:read",
      "works:translate",
      "works:typeset",
    ],
  };
  const work = {
    id: "00000000-0000-4000-8000-000000000010",
    workNumber: 10,
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "测试作者",
    title: "待认领作品",
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "pending_translate",
    reviewStatus: "normal",
    revision: 3,
    imageCount: 0,
    coverImageId: null,
    participantCount: 0,
    updatedAt: "2026-09-08T00:00:00.000Z",
    personalTasks: [
      { stage: "translate", readyToStart: true, contributionCurrent: false },
      { stage: "typeset", readyToStart: false, contributionCurrent: false },
    ],
  };
  let claimed = false;
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    path: string,
    options?: { params: { query: { view: string } } },
  ) => ({
    data:
      path === "/api/dashboard/summary"
        ? {
            totalWorks: 1,
            workflowCounts: [{ status: "pending_translate", count: 1 }],
            myWorkflowCounts: [],
            reviewCounts: [{ status: "normal", count: 1 }],
            pendingCandidates: null,
            myParticipatingWorks: claimed ? 1 : 0,
            recentActivity: [],
          }
        : options?.params.query.view === "todo"
          ? {
              items: claimed
                ? [{ ...work, personalTasks: [work.personalTasks[0]] }]
                : [],
              total: claimed ? 1 : 0,
              todoTotal: claimed ? 1 : 0,
              nextCursor: null,
            }
          : {
              items: claimed ? [] : [work],
              total: claimed ? 0 : 1,
              todoTotal: claimed ? 1 : 0,
              nextCursor: null,
            },
    response: new Response(null, { status: 200 }),
  })) as never);
  const post = vi.spyOn(client, "POST").mockImplementation((async () => {
    claimed = true;
    return { data: work, response: new Response(null, { status: 200 }) };
  }) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<WorkspaceTestShell user={user} />}>
            <Route path="/" element={<DashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("这里空空如也，去接取新的任务吧"),
  ).toBeTruthy();
  expect(await screen.findByText("可立即开始")).toBeTruthy();
  expect(screen.getAllByText("待认领作品")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "接取嵌字 · 上游未完成" }),
  ).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /翻译中/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "接取翻译" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/works/{id}/stages/claim",
      expect.objectContaining({
        body: expect.objectContaining({
          stage: "translate",
          expectedRevision: 3,
        }),
      }),
    ),
  );
  expect(
    await screen.findByRole("link", { name: "进入翻译工作区" }),
  ).toBeTruthy();
  expect(await screen.findByText("暂时没有匹配的可接取任务")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "查看全部待办" }).getAttribute("href"),
  ).toBe("/works?view=work&tab=todo");
  expect(get).toHaveBeenCalledWith(
    "/api/works",
    expect.objectContaining({ params: { query: { view: "todo", limit: 8 } } }),
  );
});

test("works todo tab uses server totals, keeps pagination and hides redundant participation and claim controls", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "user-1",
    username: "member",
    displayName: "译者",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:translate"],
  };
  const first = {
    id: "work-1",
    workNumber: 1,
    authorName: "作者",
    title: "分工任务",
    sourceLanguage: "ja",
    collaborationMode: "multi",
    workflowStatus: "translating",
    reviewStatus: "needs_review",
    imageCount: 0,
    coverImageId: null,
    participantCount: 2,
    updatedAt: "2026-09-08T00:00:00.000Z",
    personalTasks: [
      { stage: "translate", readyToStart: true, contributionCurrent: true },
    ],
  };
  const get = vi.spyOn(client, "GET").mockImplementation((async (
    _path: string,
    options: { params: { query: { cursor?: string; view?: string } } },
  ) => ({
    data: {
      items: options.params.query.cursor
        ? [
            {
              ...first,
              id: "work-2",
              title: "第二页任务",
              personalTasks: [
                { ...first.personalTasks[0], contributionCurrent: false },
              ],
            },
          ]
        : [first],
      total: 27,
      todoTotal: 27,
      phaseCounts: [{ phase: "translation", count: 40 }],
      nextCursor: options.params.query.cursor ? null : first.id,
    },
    response: new Response(null, { status: 200 }),
  })) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/works?view=todo"]}>
        <Routes>
          <Route element={<WorkspaceTestShell user={user} />}>
            <Route path="/works" element={<WorksPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("分工已完成，待阶段提交")).toBeTruthy();
  expect(
    screen
      .getByRole("tab", { name: "我的待办 27" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByRole("tab", { name: /全部作品/ })).toBeNull();
  expect(screen.getByRole("tab", { name: "可接翻译 0" })).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "只看我参与的" })).toBeNull();
  expect(screen.queryByRole("button", { name: "批量认领" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "未分配职责" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "再加载 24 部作品" }));
  expect(await screen.findByText("第二页任务")).toBeTruthy();
  expect(get).toHaveBeenCalledWith(
    "/api/works",
    expect.objectContaining({
      params: {
        query: expect.objectContaining({
          view: "todo",
          cursor: first.id,
          limit: 24,
        }),
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "查看视图" }));
  expect(await screen.findByRole("tab", { name: "全部作品 40" })).toBeTruthy();
  expect(
    await screen.findByRole("checkbox", { name: "只看我参与的" }),
  ).toBeTruthy();
});
test("lets the current participant cancel an active assignment", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "translator",
    displayName: "译者",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:translate"],
  };
  const work = {
    id: "00000000-0000-4000-8000-000000000010",
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "测试作者",
    title: "正在翻译的作品",
    sourcePostUrl: null,
    sourceText: null,
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "translating",
    reviewStatus: "normal",
    priority: 0,
    revision: 3,
    editorEpoch: 0,
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    imageCount: 0,
    coverImageId: null,
    participantCount: 1,
    assignedStages: ["translate"],
    importedAt: "2026-09-08T00:00:00.000Z",
    publishedAt: null,
    updatedAt: "2026-09-08T00:00:00.000Z",
    images: [],
    participants: [
      {
        id: "00000000-0000-4000-8000-000000000030",
        userId: user.id,
        displayName: user.displayName,
        stage: "translate",
        participationMode: "owner",
        creditNameSnapshot: null,
        joinedAt: "2026-09-08T00:00:00.000Z",
        submittedAt: null,
        leftAt: null,
        assignedImageIds: [],
        contributionSubmittedAt: null,
        contributionCurrent: false,
      },
    ],
    events: [],
    openReviewCaseId: null,
  };
  vi.spyOn(client, "GET").mockResolvedValue({
    data: work,
    response: new Response(null, { status: 200 }),
  } as never);
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: {
      ...work,
      workflowStatus: "pending_translate",
      revision: 4,
      assignedStages: [],
      participants: [],
    },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/works/${work.id}`]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/works/:id" element={<WorkDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("正在翻译的作品")).toBeTruthy();
  expect(screen.queryByText("发布")).toBeNull();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "取消接取" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/works/{id}/stages/leave",
      expect.objectContaining({
        body: expect.objectContaining({
          stage: "translate",
          expectedRevision: 3,
        }),
      }),
    ),
  );
});

test("refreshes the typeset upload revision after downloading a handoff package", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "typesetter",
    displayName: "嵌字",
    roles: ["typesetter"],
    languageCapabilities: [],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:typeset"],
  };
  const workId = "00000000-0000-4000-8000-000000000010";
  const work = {
    id: workId,
    workNumber: 10,
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "测试作者",
    title: "等待嵌字的作品",
    sourcePostUrl: null,
    sourceText: null,
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "pending_typeset",
    reviewStatus: "normal",
    priority: 0,
    revision: 3,
    editorEpoch: 1,
    typesetHandoffStartedAt: null,
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    imageCount: 0,
    coverImageId: null,
    participantCount: 1,
    assignedStages: ["typeset"],
    importedAt: "2026-09-08T00:00:00.000Z",
    publishedAt: null,
    updatedAt: "2026-09-08T00:00:00.000Z",
    images: [],
    participants: [
      {
        id: "00000000-0000-4000-8000-000000000030",
        userId: user.id,
        displayName: user.displayName,
        stage: "typeset",
        participationMode: "owner",
        creditNameSnapshot: null,
        joinedAt: "2026-09-08T00:00:00.000Z",
        submittedAt: null,
        leftAt: null,
        assignedImageIds: [],
        contributionSubmittedAt: null,
        contributionCurrent: false,
      },
    ],
    events: [],
    openReviewCaseId: null,
  };
  let workRequests = 0;
  let versionRequests = 0;
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/works/{id}") {
      workRequests += 1;
      return {
        data:
          workRequests === 1
            ? work
            : {
                ...work,
                workflowStatus: "typesetting",
                revision: 4,
                editorEpoch: 2,
                typesetHandoffStartedAt: "2026-09-08T01:00:00.000Z",
              },
        response: new Response(null, { status: 200 }),
      } as never;
    }
    versionRequests += 1;
    return {
      data: {
        items: [],
        currentVersionId: null,
        workRevision: versionRequests === 1 ? 3 : 4,
      },
      response: new Response(null, { status: 200 }),
    } as never;
  });
  vi.spyOn(client, "POST").mockImplementation(
    async (path: string) =>
      ({
        data: path.endsWith("/deliver")
          ? {
              url: "https://storage.invalid/signed.zip",
              fileName: "10_嵌字交接.zip",
              expiresInSeconds: 300,
            }
          : {
              id: "download",
              status: "succeeded",
              fileName: "10_嵌字交接.zip",
              error: null,
            },
        response: new Response(),
      }) as never,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(new Blob(["handoff"]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      }),
    ),
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:handoff");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/works/${workId}`]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/works/:id" element={<WorkDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "下载嵌字交接包" }),
  );
  expect(await screen.findByText("嵌字交接包已交付浏览器下载")).toBeTruthy();
  expect(versionRequests).toBeGreaterThanOrEqual(2);
  expect(queryClient.getQueryData(["typeset-versions", workId])).toMatchObject({
    workRevision: 4,
  });
});

test("keeps submitted translator credit editable before publication", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "translator",
    displayName: "译者",
    roles: ["translator", "typesetter"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:translate", "works:typeset"],
  };
  const work = {
    id: "00000000-0000-4000-8000-000000000010",
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "测试作者",
    title: "等待校对的作品",
    sourcePostUrl: null,
    sourceText: null,
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "pending_proofread",
    reviewStatus: "normal",
    priority: 0,
    revision: 4,
    editorEpoch: 1,
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    imageCount: 0,
    coverImageId: null,
    participantCount: 1,
    assignedStages: ["translate"],
    importedAt: "2026-09-08T00:00:00.000Z",
    publishedAt: null,
    updatedAt: "2026-09-08T00:00:00.000Z",
    images: [],
    participants: [
      {
        id: "00000000-0000-4000-8000-000000000030",
        userId: user.id,
        displayName: user.displayName,
        stage: "translate",
        participationMode: "owner",
        workCreditName: "译者署名",
        creditNameSnapshot: "译者署名",
        joinedAt: "2026-09-08T00:00:00.000Z",
        submittedAt: "2026-09-08T01:00:00.000Z",
        leftAt: null,
        assignedImageIds: [],
        contributionSubmittedAt: null,
        contributionCurrent: false,
      },
    ],
    events: [],
    openReviewCaseId: null,
  };
  work.participants.push({
    ...work.participants[0],
    id: "00000000-0000-4000-8000-000000000031",
    stage: "typeset",
    workCreditName: "嵌字署名",
    creditNameSnapshot: "嵌字署名",
  });
  const patch = vi
    .spyOn(client, "PATCH")
    .mockImplementation(async (_path, options) => {
      const { body } = options as unknown as {
        body: { stage: string; creditName: string };
      };
      work.participants = work.participants.map((person) =>
        person.stage === body.stage
          ? { ...person, workCreditName: body.creditName }
          : person,
      );
      return {
        data: { ...work },
        response: new Response(null, { status: 200 }),
      } as never;
    });
  vi.spyOn(client, "GET").mockResolvedValue({
    data: work,
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/works/${work.id}`]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/works/:id" element={<WorkDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("等待校对的作品")).toBeTruthy();
  expect(screen.getByText("已完成 · 提交时署名：译者署名")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "翻译临时署名" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "翻译临时署名" }), {
    target: { value: "新翻译署名" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "保存署名" })[0]);
  await screen.findByRole("status");
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      "/api/works/{id}/stages/credit",
      expect.objectContaining({
        body: expect.objectContaining({
          stage: "translate",
          creditName: "新翻译署名",
        }),
      }),
    ),
  );
  expect(
    (screen.getByRole("textbox", { name: "嵌字临时署名" }) as HTMLInputElement)
      .value,
  ).toBe("嵌字署名");
  fireEvent.change(screen.getByRole("textbox", { name: "嵌字临时署名" }), {
    target: { value: "新嵌字署名" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "保存署名" })[1]);
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(
    (screen.getByRole("textbox", { name: "翻译临时署名" }) as HTMLInputElement)
      .value,
  ).toBe("新翻译署名");
  expect(screen.queryByRole("link", { name: "继续完善翻译" })).toBeNull();
  expect(screen.queryByRole("button", { name: "取消接取" })).toBeNull();
});

test("shows generated publication copy and confirmation to an operator", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "operator",
    displayName: "运营",
    roles: ["operator"],
    languageCapabilities: [],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:publish", "works:metadata"],
  };
  const workId = "00000000-0000-4000-8000-000000000010";
  let publicationBody: string | null = null;
  const work = {
    id: workId,
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "测试作者",
    title: "待发布作品",
    sourcePostUrl: "https://example.invalid/post",
    sourceText: null,
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "pending_publish",
    reviewStatus: "normal",
    priority: 0,
    revision: 8,
    editorEpoch: 2,
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    imageCount: 1,
    coverImageId: null,
    participantCount: 3,
    assignedStages: ["translate", "proofread", "typeset"],
    importedAt: "2026-09-10T00:00:00.000Z",
    publishedAt: null,
    updatedAt: "2026-09-10T00:00:00.000Z",
    images: [],
    participants: [],
    events: [],
    openReviewCaseId: null,
    typesetHandoffStartedAt: "2026-09-10T01:00:00.000Z",
  };
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    const data =
      path === "/api/works/{id}"
        ? work
        : path === "/api/works/{workId}/typeset/versions"
          ? { items: [], currentVersionId: null, workRevision: 8 }
          : {
              workId,
              workRevision: work.revision,
              workflowStatus: "pending_publish",
              title: "待发布作品",
              body: publicationBody,
              authorCredit: "@author_name",
              sourcePostUrl: "https://example.invalid/post",
              translationCredits: ["译者"],
              proofreadCredits: ["校对"],
              typesetCredits: ["嵌字"],
              generatedText: `**${work.title}**\n${publicationBody ? `${publicationBody}\n` : ""}作者：@author_name\n\n翻译：译者\n校对：校对\n嵌字：嵌字\n点赞加关注可以看到更多汉化作品\n转载请注明原作者`,
              templateName: "Comiku 默认发布文案",
              templateRevision: 0,
              currentTypesetVersionId: "00000000-0000-4000-8000-000000000030",
              currentTypesetVersionNumber: 1,
              imageCount: 1,
              publishedAt: null,
              records: [],
            };
    return {
      data,
      response: new Response(null, { status: 200 }),
    } as never;
  });
  const patch = vi
    .spyOn(client, "PATCH")
    .mockImplementation(async (_path, options) => {
      const body = (
        options as { body: { title?: string; publicationBody?: string | null } }
      ).body;
      if (body.title !== undefined) work.title = body.title;
      if (body.publicationBody !== undefined)
        publicationBody = body.publicationBody;
      work.revision += 1;
      return {
        data: { ...work },
        response: new Response(null, { status: 200 }),
      } as never;
    });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/works/${workId}`]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/works/:id" element={<WorkDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("发布整理")).toBeTruthy();
  expect(await screen.findByText(/作者：@author_name/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "复制文案" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认已经发布" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "作品标题" }), {
    target: { value: "新作品标题" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存作品信息" }));
  expect(await screen.findByText(/\*\*新作品标题\*\*/)).toBeTruthy();
  const summary = screen.getByText("作品正文（可选）");
  expect(summary.closest("details")?.open).toBe(false);
  fireEvent.click(summary);
  summary.closest("details")!.open = true;
  fireEvent.change(screen.getByRole("textbox", { name: "作品正文" }), {
    target: { value: "发布正文" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存作品正文" }));
  expect(
    await screen.findByText(
      (_content, element) =>
        element?.tagName === "PRE" &&
        Boolean(
          element.textContent?.startsWith("**新作品标题**\n发布正文\n作者："),
        ),
    ),
  ).toBeTruthy();
  expect(patch).toHaveBeenLastCalledWith(
    "/api/works/{id}",
    expect.objectContaining({
      body: expect.objectContaining({
        publicationBody: "发布正文",
        expectedRevision: 9,
      }),
    }),
  );
});

test("shows typeset and publishing evidence while a release review is open", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "reviewer",
    displayName: "审核员",
    roles: ["admin"],
    languageCapabilities: [],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "reviews:resolve"],
  };
  const workId = "00000000-0000-4000-8000-000000000010";
  const reviewId = "00000000-0000-4000-8000-000000000011";
  const baselineVersionId = "00000000-0000-4000-8000-000000000030";
  const currentVersionId = "00000000-0000-4000-8000-000000000031";
  const work = {
    id: workId,
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "测试作者",
    title: "待复核发布作品",
    sourcePostUrl: null,
    sourceText: null,
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "pending_publish",
    reviewStatus: "needs_review",
    priority: 0,
    revision: 10,
    editorEpoch: 2,
    typesetHandoffStartedAt: "2026-09-10T01:00:00.000Z",
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    imageCount: 0,
    coverImageId: null,
    participantCount: 3,
    assignedStages: ["translate", "proofread", "typeset"],
    importedAt: "2026-09-10T00:00:00.000Z",
    publishedAt: null,
    updatedAt: "2026-09-10T02:00:00.000Z",
    images: [],
    participants: [],
    events: [],
    openReviewCaseId: reviewId,
  };
  const review = {
    id: reviewId,
    workId,
    workTitle: work.title,
    authorId: work.authorId,
    authorName: work.authorName,
    workflowStatus: "pending_publish",
    reviewStatus: "needs_review",
    openedFromWorkflowStatus: "pending_publish",
    openedTypesetVersionId: baselineVersionId,
    openedTypesetVersionNumber: 1,
    reason: "气泡位置需要调整",
    status: "open",
    openedById: user.id,
    openedByName: "运营",
    resolvedById: null,
    resolvedByName: null,
    resolution: null,
    targetWorkflowStatus: null,
    resolutionNote: null,
    workRevision: 10,
    revision: 0,
    createdAt: "2026-09-10T02:00:00.000Z",
    resolvedAt: null,
  };
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    const data =
      path === "/api/reviews/{id}"
        ? review
        : path === "/api/works/{id}"
          ? work
          : path === "/api/works/{workId}/typeset/versions"
            ? {
                workRevision: 10,
                currentVersionId,
                items: [
                  {
                    id: currentVersionId,
                    versionNumber: 2,
                    note: "修正版",
                    automaticallySorted: true,
                    isCurrent: true,
                    uploadedById: user.id,
                    uploadedByName: "嵌字",
                    deletedAt: null,
                    purgeAfter: null,
                    images: [],
                    createdAt: "2026-09-10T03:00:00.000Z",
                  },
                  {
                    id: baselineVersionId,
                    versionNumber: 1,
                    note: "审核发起版本",
                    automaticallySorted: true,
                    isCurrent: false,
                    uploadedById: user.id,
                    uploadedByName: "嵌字",
                    deletedAt: null,
                    purgeAfter: null,
                    images: [],
                    createdAt: "2026-09-10T01:00:00.000Z",
                  },
                ],
              }
            : {
                workId,
                workRevision: 10,
                workflowStatus: "pending_publish",
                title: work.title,
                body: null,
                authorCredit: "@author",
                sourcePostUrl: null,
                translationCredits: ["译者"],
                proofreadCredits: ["校对"],
                typesetCredits: ["嵌字"],
                generatedText: "**待复核发布作品**",
                templateName: "默认模板",
                templateRevision: 0,
                currentTypesetVersionId: currentVersionId,
                currentTypesetVersionNumber: 2,
                imageCount: 1,
                publishedAt: null,
                records: [],
              };
    return {
      data,
      response: new Response(null, { status: 200 }),
    } as never;
  });

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/reviews/${reviewId}`]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/reviews/:id" element={<ReviewDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("气泡位置需要调整")).toBeTruthy();
  expect(await screen.findByText("审核发起时版本")).toBeTruthy();
  expect(await screen.findByText("发布整理")).toBeTruthy();
  expect(screen.getByText("发起时成图").parentElement?.textContent).toContain(
    "v1",
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByRole("button", { name: "确认继续" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认舍弃" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
  expect(screen.getByText(/作品制作暂停/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "确认已经发布" })).toBeNull();
});

test("dashboard labels personal participation as distinct works and omits unavailable candidate data", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "user-1",
    username: "member",
    displayName: "小凛",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["dashboard:read"],
  };
  vi.spyOn(client, "GET").mockResolvedValue({
    data: {
      totalWorks: 7,
      workflowCounts: [{ status: "translating", count: 2 }],
      myWorkflowCounts: [{ status: "translating", count: 1 }],
      reviewCounts: [
        { status: "normal", count: 6 },
        { status: "needs_review", count: 1 },
      ],
      pendingCandidates: null,
      myParticipatingWorks: 3,
      recentActivity: [],
    },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/" element={<DashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("我的参与")).toBeTruthy();
  expect(screen.getByText("按作品去重")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  expect(screen.queryByText("待处理候选")).toBeNull();
  expect(screen.getByText("审核异常").parentElement?.textContent).toContain(
    "1",
  );
});

test("renders the scoped business audit feed with readable event context", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "user-1",
    username: "translator",
    displayName: "译者",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read"],
  };
  vi.spyOn(client, "GET").mockResolvedValue({
    data: {
      scope: "related",
      total: 1,
      nextCursor: null,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000011",
          workId: "00000000-0000-4000-8000-000000000010",
          workTitle: "待发布作品",
          authorName: "测试作者",
          action: "publish_confirmed",
          actorId: "00000000-0000-4000-8000-000000000001",
          actorName: "运营",
          fromWorkflowStatus: "pending_publish",
          toWorkflowStatus: "published",
          fromReviewStatus: "normal",
          toReviewStatus: "normal",
          detail: { typesetVersionNumber: 2 },
          createdAt: "2026-09-10T08:00:00.000Z",
        },
      ],
    },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/audit"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/audit" element={<BusinessAuditPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("确认发布")).toBeTruthy();
  expect(screen.getByRole("link", { name: "待发布作品" })).toBeTruthy();
  expect(screen.getByText(/与本人相关的作品范围/)).toBeTruthy();
  expect(screen.getByText(/流程变为 已发布/)).toBeTruthy();
});

test.each([
  {
    tagDisposition: "valid",
    label: "ba_art",
    text: "BA 漫画／插画",
    tone: "success",
  },
  {
    tagDisposition: "neutral",
    label: "ba_related",
    text: "BA 相关",
    tone: "info",
  },
  {
    tagDisposition: "neutral",
    label: "other",
    text: "非 BA 内容",
    tone: "neutral",
  },
] as const)(
  "candidate filters preserve tag evidence and display classifier category $label",
  async ({ tagDisposition, label, text, tone }) => {
    const user: CurrentUser = {
      canSkipProofreading: false,
      id: "00000000-0000-4000-8000-000000000001",
      username: "source",
      displayName: "图源",
      roles: ["source"],
      languageCapabilities: [],
      isActive: true,
      mustChangePassword: false,
      revision: 1,
      permissions: ["candidates:read", "candidates:manage"],
    };
    const candidate = {
      id: "00000000-0000-4000-8000-000000000010",
      authorId: "00000000-0000-4000-8000-000000000020",
      authorName: "测试作者",
      authorHandle: "test_artist",
      authorAvatarAvailable: false,
      platform: "x",
      sourceLanguage: "ja",
      sourceAdapters: ["x_web_session"],
      hashtags: ["BlueArchive"],
      tagDisposition,
      classificationTags: [{ label, text, tone }],
      reviewPriority: "low",
      canRetryAnalysis: true,
      visualClass: "manga",
      visualClassSource: "default",
      classificationRevision: null,
      externalPostId: "123",
      externalPostUrl: "https://x.com/artist/status/123",
      text: "测试候选",
      referencedPostType: null,
      referencedPostId: null,
      status: "pending",
      revision: 0,
      media: [],
      postedAt: "2026-09-12T00:00:00.000Z",
      fetchedAt: "2026-09-12T00:01:00.000Z",
      reviewedAt: null,
      workId: null,
    };
    const get = vi.spyOn(client, "GET").mockImplementation((async (
      ...args: unknown[]
    ) => {
      if (args[0] === "/api/source-fetch/progress")
        return {
          data: { active: null, lastManual: null },
          response: new Response(null, { status: 200 }),
        };
      const options = args[1] as {
        params?: { query?: { triageGroup?: string } };
      };
      return {
        data: {
          items:
            options?.params?.query?.triageGroup === "valid_manga"
              ? [candidate]
              : [],
          total: options?.params?.query?.triageGroup === "valid_manga" ? 1 : 0,
          nextCursor: null,
        },
        response: new Response(null, { status: 200 }),
      };
    }) as never);
    vi.spyOn(client, "POST").mockResolvedValue({
      data: {
        sessionId: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        counts: {
          valid_manga: 1,
          neutral_manga: 0,
          blocked_manga: 0,
          photo: 0,
        },
      },
      response: new Response(null, { status: 201 }),
    } as never);
    const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
      data: {
        ...candidate,
        visualClass: "photo",
        visualClassSource: "human",
        classificationRevision: 0,
      },
      response: new Response(null, { status: 200 }),
    } as never);

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/candidates"]}>
          <Routes>
            <Route element={<Outlet context={user} />}>
              <Route path="/candidates" element={<CandidatesPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("测试候选")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试识别" })).toBeTruthy();
    expect(screen.queryByText("同步记录")).toBeNull();
    expect(screen.queryByText(/来源抓取已排队|正在抓取：/)).toBeNull();
    expect(screen.getByRole("button", { name: "同步图源" })).toBeTruthy();
    expect(screen.getByText("#BlueArchive")).toBeTruthy();
    expect(
      screen.getByText(tagDisposition === "valid" ? "有效标签" : "普通标签"),
    ).toBeTruthy();
    expect(screen.getByText(text).className).toContain(`ui-badge--${tone}`);
    for (const removed of [
      "模型命中",
      "未识别",
      "待识别",
      "识别失败",
      "优先查看",
      "正常优先级",
    ])
      expect(screen.queryByText(removed)).toBeNull();
    expect(screen.getByText("@test_artist")).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "来源语言" }));
    fireEvent.click(screen.getByRole("option", { name: "韩语" }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/candidates",
        expect.objectContaining({
          params: {
            query: expect.objectContaining({ sourceLanguage: "ko" }),
          },
        }),
      ),
    );

    expect(await screen.findByText("测试候选")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "标记为照片" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/api/candidates/{id}/classification",
        expect.objectContaining({
          body: { label: "photo", expectedRevision: null },
        }),
      ),
    );
  },
);

test("queued analysis rehydrates cards without replacing snapshot membership", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const user: CurrentUser = {
    id: "00000000-0000-4000-8000-000000000001",
    username: "source",
    displayName: "图源",
    roles: ["source"],
    languageCapabilities: [],
    canSkipProofreading: false,
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["candidates:read", "candidates:manage"],
  };
  let phase: "queued" | "finishing" | "done" = "queued";
  let calls = 0;
  const candidate = {
    id: "00000000-0000-4000-8000-000000000010",
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "测试作者",
    authorHandle: "fixture",
    authorAvatarAvailable: false,
    platform: "x",
    sourceLanguage: "ja",
    sourceAdapters: [],
    hashtags: [],
    tagDisposition: "neutral",
    visualClass: "manga",
    visualClassSource: "default",
    classificationRevision: null,
    externalPostId: "fixture",
    externalPostUrl: "https://example.invalid/fixture",
    text: "分组刷新候选",
    referencedPostType: null,
    referencedPostId: null,
    status: "pending",
    revision: 0,
    media: [],
    postedAt: "2026-01-01T00:00:00Z",
    fetchedAt: "2026-01-01T00:00:00Z",
    reviewedAt: null,
    workId: null,
  };
  vi.spyOn(client, "GET").mockImplementation((async (
    _path: unknown,
    options: { params?: { query?: { triageGroup?: string } } },
  ) => {
    if (_path === "/api/source-fetch/progress")
      return {
        data: { active: null, lastManual: null },
        response: new Response(null, { status: 200 }),
      };
    calls++;
    const group = options?.params?.query?.triageGroup;
    // The first destination refresh observes the old state; the source refresh
    // then sees completion. A final coordinated refresh must fill the destination.
    if (phase === "finishing" && group === "neutral_manga") phase = "done";
    const show = group === "neutral_manga";
    const items = show
      ? [
          {
            ...candidate,
            reviewPriority: phase === "queued" ? "queued" : "high",
            classificationTags:
              phase === "queued"
                ? []
                : [{ label: "ba_art", text: "BA 漫画／插画", tone: "success" }],
          },
        ]
      : [];
    return {
      data: { items, total: items.length, nextCursor: null },
      response: new Response(null, { status: 200 }),
    };
  }) as never);
  const sessions = vi.spyOn(client, "POST").mockResolvedValue({
    data: {
      sessionId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      counts: {
        valid_manga: 0,
        neutral_manga: 1,
        blocked_manga: 0,
        photo: 0,
      },
    },
    response: new Response(null, { status: 201 }),
  } as never);
  try {
    const mounted = render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/candidates"]}>
          <Routes>
            <Route element={<Outlet context={user} />}>
              <Route path="/candidates" element={<CandidatesPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("分组刷新候选")).toBeTruthy();
    expect(screen.queryByText("待识别")).toBeNull();
    const beforeBackground = calls;
    focusManager.setFocused(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toBe(beforeBackground);
    await act(async () => {
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(calls).toBeGreaterThan(beforeBackground));
    phase = "finishing";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await waitFor(() => expect(screen.getByText("BA 漫画／插画")).toBeTruthy());
    expect(screen.getAllByText("分组刷新候选")).toHaveLength(1);
    expect(sessions).toHaveBeenCalledTimes(1);
    const settled = calls;
    mounted.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls).toBe(settled);
  } finally {
    cache.clear();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  }
});

test("manual source upload uses a signed session before finalizing candidates", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000001",
    username: "source",
    displayName: "图源",
    roles: ["source"],
    languageCapabilities: [],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["authors:read", "candidates:read", "candidates:manage"],
  };
  const manualCandidate = {
    id: "00000000-0000-4000-8000-000000000040",
    authorId: "00000000-0000-4000-8000-000000000020",
    authorName: "授权作者",
    authorHandle: null,
    authorAvatarAvailable: false,
    platform: "manual",
    sourceLanguage: "ja",
    sourceAdapters: ["manual"],
    hashtags: [],
    tagDisposition: "neutral",
    visualClass: "manga",
    visualClassSource: "default",
    classificationRevision: null,
    externalPostId: "manual-1",
    externalPostUrl: null,
    text: null,
    referencedPostType: null,
    referencedPostId: null,
    status: "pending",
    revision: 0,
    media: [
      {
        id: "00000000-0000-4000-8000-000000000041",
        externalMediaId: "page.png",
        orderIndex: 0,
        width: 1,
        height: 1,
        mediaType: "photo",
      },
    ],
    postedAt: "2026-09-12T00:00:00.000Z",
    fetchedAt: "2026-09-12T00:01:00.000Z",
    reviewedAt: null,
    workId: null,
  };
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    const data =
      path === "/api/authors"
        ? {
            items: [
              {
                id: "00000000-0000-4000-8000-000000000020",
                displayName: "授权作者",
                authorizationStatus: "authorized",
                revision: 0,
                tags: [],
                externalAccounts: [],
                createdAt: "2026-09-09T00:00:00.000Z",
                updatedAt: "2026-09-09T00:00:00.000Z",
                deletedAt: null,
              },
            ],
            total: 1,
            nextCursor: null,
          }
        : { items: [], nextCursor: null };
    return {
      data,
      response: new Response(null, { status: 200 }),
    } as never;
  });
  const post = vi.spyOn(client, "POST").mockImplementation(async (path) => {
    const data =
      path === "/api/candidates/review-sessions"
        ? {
            sessionId: crypto.randomUUID(),
            expiresAt: new Date(Date.now() + 1800000).toISOString(),
            counts: {
              valid_manga: 0,
              neutral_manga: 0,
              blocked_manga: 0,
              photo: 0,
            },
          }
        : path === "/api/candidates/upload-sessions"
          ? {
              id: "00000000-0000-4000-8000-000000000030",
              status: "pending",
              expiresAt: "2026-09-12T00:00:00.000Z",
              items: [
                {
                  id: "00000000-0000-4000-8000-000000000031",
                  sourceName: "page.png",
                  status: "pending",
                  upload: {
                    url: "https://upload.example.test/item",
                    method: "PUT",
                    headers: {
                      "Content-Type": "image/png",
                      "x-amz-meta-sha256": "fixture",
                    },
                    expiresAt: "2026-09-11T00:15:00.000Z",
                  },
                  message: null,
                  warnings: [],
                  candidate: null,
                },
              ],
            }
          : path === "/api/candidates/upload-sessions/{id}/finalize"
            ? {
                id: "00000000-0000-4000-8000-000000000030",
                status: "completed",
                expiresAt: "2026-09-12T00:00:00.000Z",
                items: [
                  {
                    id: "00000000-0000-4000-8000-000000000031",
                    sourceName: "page.png",
                    status: "created",
                    upload: null,
                    message: null,
                    warnings: [],
                    candidate: manualCandidate,
                  },
                ],
              }
            : {
                results: [
                  {
                    id: manualCandidate.id,
                    outcome: "succeeded",
                    message: null,
                    workId: "00000000-0000-4000-8000-000000000050",
                  },
                ],
              };
    return {
      data,
      response: new Response(null, {
        status: path === "/api/candidates/upload-sessions" ? 201 : 200,
      }),
    } as never;
  });
  const upload = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 200 }));

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/candidates"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route path="/candidates" element={<CandidatesPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "手动上传" }));
  const file = new File(["image"], "page.png", { type: "image/png" });
  fireEvent.change(await screen.findByLabelText("图片或 ZIP"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "上传并预览图组",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.submit(
    screen.getByRole("button", { name: "上传并预览图组" }).closest("form")!,
  );
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/candidates/upload-sessions",
      expect.objectContaining({
        body: expect.objectContaining({
          files: [
            expect.objectContaining({
              sourceName: "page.png",
              contentType: "image/png",
            }),
          ],
        }),
      }),
    ),
  );
  await waitFor(() =>
    expect(upload).toHaveBeenCalledWith(
      "https://upload.example.test/item",
      expect.objectContaining({ method: "PUT", body: file }),
    ),
  );
  expect(post).toHaveBeenCalledWith(
    "/api/candidates/upload-sessions/{id}/finalize",
    expect.objectContaining({
      params: {
        path: { id: "00000000-0000-4000-8000-000000000030" },
      },
    }),
  );
  expect(await screen.findByText(/已创建 1 个候选组/)).toBeTruthy();
  expect(screen.getByText("直接入库（默认）")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认并直接入库" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/candidates/actions",
      expect.objectContaining({
        body: {
          action: "import",
          items: [{ id: manualCandidate.id, expectedRevision: 0 }],
        },
      }),
    ),
  );
  expect(window.localStorage.length).toBe(0);
});
