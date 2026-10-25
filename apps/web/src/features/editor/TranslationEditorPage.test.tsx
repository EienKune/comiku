import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { CurrentUser } from "@comiku/api-client";
import { client } from "../account/api";
import { TranslationEditorPage } from "./TranslationEditorPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("opens the real editor data and focuses the matching text entry from a marker", async () => {
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
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/works/{workId}/translations") {
      return {
        data: {
          workId: "00000000-0000-4000-8000-000000000010",
          title: "测试作品",
          sourceLanguage: "ja",
          collaborationMode: "single",
          workflowStatus: "translating",
          reviewStatus: "normal",
          openReviewCase: null,
          workRevision: 1,
          editorEpoch: 0,
          canEdit: true,
          editStages: ["translate"],
          canExportLabelPlus: true,
          joinableStage: null,
          submissionStage: "translate",
          assignedImageIds: [],
          contributionCurrent: false,
          multiStageReady: false,
          hasUnsubmittedChanges: true,
          revisionStages: [],
          translationAttentionStage: null,
          translationAttentionVersionNumber: null,
          latestVersion: null,
          activeParticipants: [],
          images: [
            {
              id: "00000000-0000-4000-8000-000000000020",
              orderIndex: 0,
              width: 1200,
              height: 1800,
              translationRevision: 1,
              entries: [
                {
                  id: "00000000-0000-4000-8000-000000000030",
                  workImageId: "00000000-0000-4000-8000-000000000020",
                  orderIndex: 0,
                  markerX: 0.25,
                  markerY: 0.4,
                  markerPositionType: "inside",
                  translatedText: "已经保存的译文",
                  note: null,
                  revision: 0,
                  createdById: user.id,
                  updatedById: user.id,
                  createdAt: "2026-09-08T00:00:00.000Z",
                  updatedAt: "2026-09-08T00:00:00.000Z",
                },
              ],
            },
            {
              id: "00000000-0000-4000-8000-000000000021",
              orderIndex: 1,
              width: 1200,
              height: 1800,
              translationRevision: 0,
              entries: [],
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      } as never;
    }
    return {
      data: {
        url: "/api/local-files/payload.signature",
        expiresInSeconds: 300,
      },
      response: new Response(null, { status: 200 }),
    } as never;
  });
  let stageSubmitCount = 0;
  vi.spyOn(client, "POST").mockImplementation(async (path, options) => {
    if (path === "/api/works/{workId}/labelplus/imports/preview") {
      return {
        data: {
          formatVersion: "1,0",
          imageCount: 1,
          markerCount: 1,
          mappings: [
            {
              sourceFileName: "source.png",
              targetImageId: "00000000-0000-4000-8000-000000000020",
              targetFileName: "001.png",
              markerCount: 1,
            },
          ],
          warnings: [],
          blockingIssues: [],
          canImport: true,
        },
        response: new Response(null, { status: 200 }),
      } as never;
    }
    if (path === "/api/works/{workId}/translations/presence") {
      const mode = (options as { body: { mode: "view" | "edit" } }).body.mode;
      return {
        data: {
          items: [
            {
              userId: user.id,
              displayName: user.displayName,
              mode,
              stages: ["translate"],
              isCurrentSession: true,
              lastSeenAt: "2026-09-08T00:00:00.000Z",
            },
          ],
          expiresInSeconds: 90,
        },
        response: new Response(null, { status: 200 }),
      } as never;
    }
    if (path === "/api/works/{id}/stages/submit") {
      stageSubmitCount += 1;
      await new Promise((resolve) => window.setTimeout(resolve, 10));
      return {
        data: {},
        response: new Response(null, { status: 200 }),
      } as never;
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  vi.spyOn(client, "DELETE").mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    data: {
      id: "00000000-0000-4000-8000-000000000030",
      workImageId: "00000000-0000-4000-8000-000000000020",
      orderIndex: 0,
      markerX: 0.25,
      markerY: 0.4,
      markerPositionType: "inside",
      translatedText: "修改后的译文",
      note: null,
      revision: 1,
      createdById: user.id,
      updatedById: user.id,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:01:00.000Z",
    },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/works/work-1/editor"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route
              path="/works/:id/editor"
              element={<TranslationEditorPage />}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("测试作品")).toBeTruthy();
  expect(await screen.findByAltText("第 1 页")).toBeTruthy();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "添加框内" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText("选择 LabelPlus 文件"), {
    target: {
      files: [new File(["fixture"], "translation.txt", { type: "text/plain" })],
    },
  });
  expect(await screen.findByText("LABELPLUS 导入预览")).toBeTruthy();
  expect(screen.getByText("source.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  const submit = screen.getByRole("button", { name: "提交翻译" });
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  const translation = screen.getByDisplayValue("已经保存的译文");
  expect(screen.getByText("添加备注（可选）").closest("details")?.open).toBe(
    false,
  );
  fireEvent.click(await screen.findByRole("button", { name: "标记 1" }));
  await waitFor(() => expect(document.activeElement).toBe(translation));

  vi.useFakeTimers();
  fireEvent.change(translation, { target: { value: "修改后的译文" } });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(2999);
  expect(patch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(patch.mock.calls[0][1]).toMatchObject({
    body: { expectedRevision: 0, expectedEditorEpoch: 0, note: null },
  });
  vi.useRealTimers();
  await waitFor(() =>
    expect((submit as HTMLButtonElement).disabled).toBe(false),
  );

  const pageJump = screen.getByRole("spinbutton", { name: /跳转页码/ });
  fireEvent.change(pageJump, { target: { value: "2" } });
  fireEvent.submit(pageJump.closest("form")!);
  expect(await screen.findByAltText("第 2 页")).toBeTruthy();

  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(stageSubmitCount).toBe(1));
});

test("submits unchanged proofreading and opens an existing note", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000091",
    username: "proofreader-no-edit",
    displayName: "校对员",
    roles: ["proofreader"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:proofread"],
  };
  let submitted = false;
  vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data:
          path === "/api/works/{workId}/translations"
            ? {
                workId: "work-proof",
                title: "无需修改的译文",
                sourceLanguage: "ja",
                collaborationMode: "single",
                workflowStatus: submitted
                  ? "pending_typeset"
                  : "pending_proofread",
                reviewStatus: "normal",
                openReviewCase: null,
                workRevision: submitted ? 3 : 2,
                editorEpoch: submitted ? 2 : 1,
                canEdit: !submitted,
                editStages: submitted ? [] : ["proofread"],
                canExportLabelPlus: true,
                joinableStage: null,
                submissionStage: submitted ? null : "proofread",
                assignedImageIds: [],
                contributionCurrent: false,
                multiStageReady: false,
                hasUnsubmittedChanges: false,
                revisionStages: [],
                activeParticipants: [],
                images: [
                  {
                    id: "image-proof",
                    orderIndex: 0,
                    width: 1200,
                    height: 1800,
                    translationRevision: 1,
                    entries: [
                      {
                        id: "entry-proof",
                        workImageId: "image-proof",
                        orderIndex: 0,
                        markerX: 0.25,
                        markerY: 0.4,
                        markerPositionType: "inside",
                        translatedText: "已经正确的译文",
                        note: "请核对专有名词",
                        revision: 1,
                      },
                    ],
                  },
                ],
              }
            : { url: "/api/local-files/fixture", expiresInSeconds: 300 },
        response: new Response(null, { status: 200 }),
      }) as never,
  );
  const patch = vi.spyOn(client, "PATCH");
  const post = vi.spyOn(client, "POST").mockImplementation(async (path) => {
    if (path === "/api/works/{id}/stages/submit") submitted = true;
    return {
      data:
        path === "/api/works/{id}/stages/submit"
          ? {}
          : { items: [], expiresInSeconds: 90 },
      response: new Response(null, { status: 200 }),
    } as never;
  });
  vi.spyOn(client, "DELETE").mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/works/work-proof/editor"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route
              path="/works/:id/editor"
              element={<TranslationEditorPage />}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    (await screen.findByDisplayValue("请核对专有名词")).closest("details")
      ?.open,
  ).toBe(true);
  const details = screen.getByText("查看备注").closest("details")!;
  details.open = false;
  fireEvent(details, new Event("toggle"));
  fireEvent.focus(screen.getByDisplayValue("已经正确的译文"));
  expect(details.open).toBe(false);
  const submit = await screen.findByRole("button", { name: "提交校对" });
  await waitFor(() =>
    expect((submit as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(submit);
  await waitFor(() => expect(submitted).toBe(true));
  expect(confirm).toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(
    "/api/works/{id}/stages/submit",
    expect.objectContaining({
      body: expect.objectContaining({
        stage: "proofread",
        expectedRevision: 2,
        expectedEditorEpoch: 1,
      }),
    }),
  );
  expect(patch).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "提交校对" })).toBeNull(),
  );
});

test("waits for a fresh editor response instead of hydrating an inactive cache", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000081",
    username: "cache-translator",
    displayName: "缓存测试译者",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:translate"],
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const baseEditor = {
    workId: "work-cached",
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "translating",
    reviewStatus: "normal",
    openReviewCase: null,
    workRevision: 1,
    editorEpoch: 0,
    canEdit: true,
    editStages: ["translate"],
    canExportLabelPlus: true,
    joinableStage: null,
    submissionStage: "translate",
    assignedImageIds: [],
    contributionCurrent: false,
    multiStageReady: false,
    hasUnsubmittedChanges: true,
    revisionStages: [],
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    latestVersion: null,
    activeParticipants: [],
  };
  queryClient.setQueryData(["translation-editor", "work-cached"], {
    ...baseEditor,
    title: "旧缓存标题",
    images: [],
  });
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path === "/api/works/{workId}/translations") {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      return {
        data: {
          ...baseEditor,
          title: "最新服务端标题",
          images: [
            {
              id: "00000000-0000-4000-8000-000000000082",
              orderIndex: 0,
              width: 1200,
              height: 1800,
              translationRevision: 1,
              entries: [
                {
                  id: "00000000-0000-4000-8000-000000000083",
                  workImageId: "00000000-0000-4000-8000-000000000082",
                  orderIndex: 0,
                  markerX: 0.2,
                  markerY: 0.3,
                  markerPositionType: "inside",
                  translatedText: "刚保存到云端的内容",
                  note: null,
                  revision: 1,
                  createdById: user.id,
                  updatedById: user.id,
                  createdAt: "2026-09-10T00:00:00.000Z",
                  updatedAt: "2026-09-10T00:01:00.000Z",
                },
              ],
            },
          ],
        },
        response: new Response(null, { status: 200 }),
      } as never;
    }
    return {
      data: { url: "/api/local-files/cache.signature", expiresInSeconds: 300 },
      response: new Response(null, { status: 200 }),
    } as never;
  });
  vi.spyOn(client, "POST").mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);
  vi.spyOn(client, "DELETE").mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/works/work-cached/editor"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route
              path="/works/:id/editor"
              element={<TranslationEditorPage />}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(screen.getByText("正在打开翻译工作区…")).toBeTruthy();
  expect(await screen.findByText("最新服务端标题")).toBeTruthy();
  expect(screen.getByDisplayValue("刚保存到云端的内容")).toBeTruthy();
  expect(screen.queryByText("旧缓存标题")).toBeNull();
});

test("asks before entering an editor that already has an active collaborator", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000041",
    username: "proofreader",
    displayName: "校对员",
    roles: ["proofreader"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:proofread"],
  };
  vi.spyOn(client, "GET").mockResolvedValue({
    data: {
      workId: "00000000-0000-4000-8000-000000000050",
      title: "协作中的作品",
      sourceLanguage: "ja",
      collaborationMode: "single",
      workflowStatus: "proofreading",
      reviewStatus: "normal",
      openReviewCase: null,
      workRevision: 2,
      editorEpoch: 1,
      canEdit: true,
      editStages: ["proofread"],
      canExportLabelPlus: true,
      joinableStage: null,
      submissionStage: "proofread",
      assignedImageIds: [],
      contributionCurrent: false,
      multiStageReady: false,
      hasUnsubmittedChanges: false,
      revisionStages: [],
      translationAttentionStage: null,
      translationAttentionVersionNumber: null,
      images: [],
      latestVersion: null,
      activeParticipants: [],
    },
    response: new Response(null, { status: 200 }),
  } as never);
  vi.spyOn(client, "POST").mockImplementation(async (path, options) => {
    if (path !== "/api/works/{workId}/translations/presence")
      throw new Error(`Unexpected POST ${path}`);
    const mode = (options as { body: { mode: "view" | "edit" } }).body.mode;
    return {
      data: {
        expiresInSeconds: 90,
        items: [
          {
            userId: "00000000-0000-4000-8000-000000000042",
            displayName: "正在编辑的译者",
            mode: "edit",
            stages: ["translate"],
            isCurrentSession: false,
            lastSeenAt: "2026-09-08T00:00:00.000Z",
          },
          {
            userId: user.id,
            displayName: user.displayName,
            mode,
            stages: ["proofread"],
            isCurrentSession: true,
            lastSeenAt: "2026-09-08T00:00:00.000Z",
          },
        ],
      },
      response: new Response(null, { status: 200 }),
    } as never;
  });
  vi.spyOn(client, "DELETE").mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/works/work-2/editor"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route
              path="/works/:id/editor"
              element={<TranslationEditorPage />}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("已有成员正在编辑")).toBeTruthy();
  expect(screen.getByText("正在编辑的译者")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "添加框内" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "进入协作" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "添加框内" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

test("raises a review from the editor and explains why formal submission is blocked", async () => {
  const user: CurrentUser = {
    canSkipProofreading: false,
    id: "00000000-0000-4000-8000-000000000061",
    username: "translator-review",
    displayName: "发起人",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 1,
    permissions: ["works:read", "works:translate", "works:review:raise"],
  };
  let reviewOpen = false;
  let reviewRequest:
    | {
        expectedRevision: number;
        reason: string;
      }
    | undefined;
  vi.spyOn(client, "GET").mockImplementation(async (path) => {
    if (path !== "/api/works/{workId}/translations")
      throw new Error(`Unexpected GET ${path}`);
    return {
      data: {
        workId: "00000000-0000-4000-8000-000000000070",
        title: "需要暂停确认的作品",
        sourceLanguage: "ja",
        collaborationMode: "single",
        workflowStatus: "translating",
        reviewStatus: reviewOpen ? "needs_review" : "normal",
        openReviewCase: reviewOpen
          ? {
              id: "00000000-0000-4000-8000-000000000071",
              reason: "等待原作者确认专有名词",
              openedByName: user.displayName,
              resolution: null,
              resolutionNote: null,
              createdAt: "2026-09-09T00:00:00.000Z",
            }
          : null,
        workRevision: reviewOpen ? 4 : 3,
        editorEpoch: 1,
        canEdit: true,
        editStages: ["translate"],
        canExportLabelPlus: true,
        joinableStage: null,
        submissionStage: "translate",
        assignedImageIds: [],
        contributionCurrent: false,
        multiStageReady: false,
        hasUnsubmittedChanges: false,
        revisionStages: [],
        translationAttentionStage: null,
        translationAttentionVersionNumber: null,
        images: [],
        latestVersion: null,
        activeParticipants: [],
      },
      response: new Response(null, { status: 200 }),
    } as never;
  });
  vi.spyOn(client, "POST").mockImplementation(async (path, options) => {
    if (path === "/api/works/{workId}/translations/presence") {
      return {
        data: { items: [], expiresInSeconds: 90 },
        response: new Response(null, { status: 200 }),
      } as never;
    }
    if (path === "/api/works/{workId}/reviews") {
      reviewRequest = (
        options as {
          body: {
            expectedRevision: number;
            reason: string;
          };
        }
      ).body;
      reviewOpen = true;
      return {
        data: {
          id: "00000000-0000-4000-8000-000000000071",
          workId: "00000000-0000-4000-8000-000000000070",
          workTitle: "需要暂停确认的作品",
          authorId: "00000000-0000-4000-8000-000000000072",
          authorName: "作者",
          workflowStatus: "translating",
          reviewStatus: "needs_review",
          openedFromWorkflowStatus: "translating",
          reason: "等待原作者确认专有名词",
          status: "open",
          openedById: user.id,
          openedByName: user.displayName,
          resolvedById: null,
          resolvedByName: null,
          resolution: null,
          targetWorkflowStatus: null,
          resolutionNote: null,
          workRevision: 4,
          revision: 0,
          createdAt: "2026-09-09T00:00:00.000Z",
          resolvedAt: null,
        },
        response: new Response(null, { status: 200 }),
      } as never;
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  vi.spyOn(client, "DELETE").mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/works/work-3/editor"]}>
        <Routes>
          <Route element={<Outlet context={user} />}>
            <Route
              path="/works/:id/editor"
              element={<TranslationEditorPage />}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  expect(await screen.findByText("需要暂停确认的作品")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "内容审核" }));
  fireEvent.change(screen.getByLabelText(/问题与需要确认的内容/), {
    target: { value: "等待原作者确认专有名词" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "内容审核" })).getByRole(
      "button",
      { name: "内容审核" },
    ),
  );

  expect(await screen.findByText("作品只读挂起，本地草稿保留")).toBeTruthy();
  expect(screen.getByText("等待原作者确认专有名词")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "提交翻译" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(reviewRequest).toMatchObject({
    expectedRevision: 3,
    reason: "等待原作者确认专有名词",
  });
});
