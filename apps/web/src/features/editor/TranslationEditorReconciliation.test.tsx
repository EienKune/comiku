import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { CurrentUser } from "@comiku/api-client";
import { client } from "../account/api";
import {
  saveTranslationDraft,
  deleteTranslationDraft,
  loadTranslationDraft,
  createTranslationDraft,
} from "./draft-storage";
import { TranslationEditorPage } from "./TranslationEditorPage";

vi.mock("./draft-storage", async (original) => ({
  ...(await original<typeof import("./draft-storage")>()),
  loadTranslationDraft: vi.fn(async () => null),
  saveTranslationDraft: vi.fn(async () => undefined),
  deleteTranslationDraft: vi.fn(async () => undefined),
}));

beforeAll(() => {
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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const user: CurrentUser = {
  id: "dual",
  username: "dual",
  displayName: "翻校成员",
  roles: ["translator", "proofreader"],
  languageCapabilities: ["ja"],
  isActive: true,
  mustChangePassword: false,
  revision: 1,
  canSkipProofreading: false,
  permissions: ["works:read", "works:translate", "works:proofread"],
};
const entry = {
  id: "entry",
  workImageId: "page",
  orderIndex: 0,
  markerX: 0.3,
  markerY: 0.3,
  markerPositionType: "inside",
  translatedText: "云端译文",
  note: null,
  revision: 1,
};
const image = {
  id: "page",
  orderIndex: 0,
  width: 100,
  height: 100,
  translationRevision: 1,
  entries: [entry],
};
const base = {
  workId: "work",
  workNumber: 1,
  sourceLanguage: "ja",
  collaborationMode: "multi",
  workflowStatus: "pending_proofread",
  reviewStatus: "normal",
  openReviewCase: null,
  workRevision: 3,
  editorEpoch: 1,
  canEdit: true,
  editStages: ["translate", "proofread"],
  editableImageIds: ["page"],
  proofreadRequiresLease: true,
  proofreadLeases: [],
  canExportLabelPlus: true,
  joinableStage: null,
  submissionStage: "proofread" as string | null,
  cancelableSubmissionStage: "translate" as "translate" | "proofread" | null,
  assignedImageIds: ["page"],
  pageAssignments: [],
  contributionCurrent: false,
  multiStageReady: false,
  hasUnsubmittedChanges: false,
  revisionStages: [],
  latestVersion: null,
  activeParticipants: [],
  images: [image],
};
function setup(initial = base) {
  let cloud = { ...initial };
  let heartbeat: (() => void) | undefined;
  const intervals = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
    if (delay === 30_000 && typeof callback === "function")
      heartbeat = () => callback();
    return intervals(callback, delay) as unknown as ReturnType<
      typeof window.setInterval
    >;
  });
  const get = vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data:
          path === "/api/works/{workId}/translations"
            ? cloud
            : { url: "/api/local-files/fixture", expiresInSeconds: 300 },
        response: new Response(null, { status: 200 }),
      }) as never,
  );
  const post = vi.spyOn(client, "POST").mockImplementation(
    async () =>
      ({
        data: {
          items: [],
          expiresInSeconds: 90,
          workRevision: cloud.workRevision,
          editorEpoch: cloud.editorEpoch,
          workflowStatus: cloud.workflowStatus,
          reviewStatus: cloud.reviewStatus,
        },
        response: new Response(null, { status: 200 }),
      }) as never,
  );
  vi.spyOn(client, "DELETE").mockResolvedValue({
    data: { items: [] },
    response: new Response(null, { status: 200 }),
  } as never);
  const fetcher = vi.fn(async (_url, options) =>
    options.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          leaseToken: "token",
          editorEpoch: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          image,
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  const patch = vi
    .spyOn(client, "PATCH")
    .mockRejectedValue(new Error("unexpected stale write"));
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={query}>
      <MemoryRouter initialEntries={["/works/work/editor"]}>
        <Link to="/works/other/editor">打开另一作品</Link>
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
  return {
    get,
    post,
    patch,
    fetcher,
    query,
    setCloud(next: typeof base) {
      cloud = next;
    },
    async beat() {
      await act(async () => {
        heartbeat?.();
      });
    },
    async ready() {
      await screen.findByDisplayValue("云端译文");
      await waitFor(() => expect(heartbeat).toBeTypeOf("function"));
    },
    reads() {
      return (get.mock.calls as unknown as [string][]).filter(
        ([path]) => path === "/api/works/{workId}/translations",
      ).length;
    },
  };
}
const withdrawn = {
  ...base,
  workflowStatus: "translating",
  workRevision: 4,
  editorEpoch: 2,
  canEdit: false,
  submissionStage: null,
  proofreadRequiresLease: false,
  editableImageIds: [],
};

test("a browsing dual-role editor observes withdrawal on the lightweight heartbeat without polling full drafts", async () => {
  const app = setup();
  await app.ready();
  await app.beat();
  expect(app.reads()).toBe(1);
  app.setCloud({ ...base, workRevision: 4 });
  await app.beat();
  expect(app.reads()).toBe(1);
  app.setCloud({ ...withdrawn, workRevision: 5 });
  await app.beat();
  await screen.findByText(/其他翻译成员已撤回提交，作品已退回翻译中/);
  expect(screen.queryByRole("button", { name: "提交校对" })).toBeNull();
  expect(screen.getByRole("button", { name: "取消翻译提交" })).toBeTruthy();
  expect(
    (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  await app.beat();
  expect(app.reads()).toBe(2);
});

test("an edit heartbeat rejected after withdrawal checks view presence once and refreshes the stage", async () => {
  const app = setup();
  await app.ready();
  app.setCloud(withdrawn);
  app.post.mockClear();
  app.post.mockImplementation(async (_path, options) => {
    const mode = (options as { body: { mode: string } }).body.mode;
    return {
      data:
        mode === "view"
          ? {
              items: [],
              expiresInSeconds: 90,
              workRevision: 4,
              editorEpoch: 2,
              workflowStatus: "translating",
              reviewStatus: "normal",
            }
          : undefined,
      error: mode === "edit" ? { message: "需要先加入" } : undefined,
      response: new Response(null, { status: mode === "edit" ? 403 : 200 }),
    } as never;
  });
  await app.beat();
  await screen.findByText(/其他翻译成员已撤回提交/);
  expect(
    (
      app.post.mock.calls as unknown as [string, { body: { mode: string } }][]
    ).map(([, options]) => (options as { body: { mode: string } }).body.mode),
  ).toEqual(["edit", "view"]);
  expect(app.reads()).toBe(2);
});

test("focus checks only presence and a legacy response without head fields does not reload the full draft", async () => {
  const app = setup();
  await app.ready();
  app.post.mockClear();
  app.post.mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(app.post).toHaveBeenCalledTimes(1);
  expect(app.reads()).toBe(1);
});

test("a stale presence reply from before a successful save cannot roll proofreading back", async () => {
  const app = setup();
  await app.ready();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  let finish!: (result: never) => void;
  app.post.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await app.beat();
  app.patch.mockResolvedValue({
    data: {
      ...entry,
      revision: 2,
      translatedText: "本人已保存的校对",
      mutation: {
        workRevision: 4,
        editorEpoch: 2,
        workflowStatus: "proofreading",
        submissionStage: "proofread",
      },
    },
    response: new Response(null, { status: 200 }),
  } as never);
  fireEvent.change(screen.getByDisplayValue("云端译文"), {
    target: { value: "本人已保存的校对" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(app.patch).toHaveBeenCalledTimes(1));
  await screen.findByDisplayValue("本人已保存的校对");
  await act(async () => {
    finish({
      data: {
        items: [],
        expiresInSeconds: 90,
        workRevision: 3,
        editorEpoch: 1,
        workflowStatus: "pending_proofread",
        reviewStatus: "normal",
      },
      response: new Response(null, { status: 200 }),
    } as never);
  });
  expect(app.reads()).toBe(1);
  expect(screen.getByDisplayValue("本人已保存的校对")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "按最新基线恢复本地内容" }),
  ).toBeNull();
});

test("the presence heartbeat refreshes withdrawal and keeps unsaved text copyable", async () => {
  const app = setup();
  await app.ready();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("云端译文"), {
    target: { value: "续期前的本地稿" },
  });
  app.setCloud(withdrawn);
  await app.beat();
  await screen.findByText(/其他翻译成员已撤回提交/);
  expect(
    (screen.getByDisplayValue("续期前的本地稿") as HTMLTextAreaElement)
      .readOnly,
  ).toBe(true);
  expect(app.patch).not.toHaveBeenCalled();
  expect(app.reads()).toBe(2);
});

test("withdrawal keeps unsynced proofreading in its original draft epoch and cannot reapply it into submitted translation pages", async () => {
  const app = setup();
  await app.ready();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("云端译文"), {
    target: { value: "未同步的校对输入" },
  });
  app.setCloud(withdrawn);
  await app.beat();
  await screen.findByRole("button", { name: "按最新基线恢复本地内容" });
  expect(vi.mocked(saveTranslationDraft).mock.calls.at(-1)?.[0]).toMatchObject({
    editorEpoch: 1,
    images: [{ entries: [{ translatedText: "未同步的校对输入" }] }],
  });
  fireEvent.click(
    screen.getByRole("button", { name: "按最新基线恢复本地内容" }),
  );
  await screen.findByText(/当前阶段没有编辑权限，本地草稿已保留/);
  expect(app.patch).not.toHaveBeenCalled();
  const local = screen.getByDisplayValue(
    "未同步的校对输入",
  ) as HTMLTextAreaElement;
  expect(local.disabled).toBe(false);
  expect(local.readOnly).toBe(true);
  expect(screen.getByText(/正在显示未同步本地稿，可选取复制/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "使用服务端版本" }));
  await screen.findByDisplayValue("云端译文");
  expect(screen.queryByDisplayValue("未同步的校对输入")).toBeNull();
});

test("an old successful save cannot replace the refreshed stage or delete the preserved local draft", async () => {
  const app = setup();
  await app.ready();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  let finish!: (result: never) => void;
  app.patch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.change(screen.getByDisplayValue("云端译文"), {
    target: { value: "回包前的本地输入" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(app.patch).toHaveBeenCalledTimes(1));
  app.setCloud(withdrawn);
  await app.beat();
  await screen.findByRole("button", { name: "按最新基线恢复本地内容" });
  vi.mocked(deleteTranslationDraft).mockClear();
  await act(async () => {
    finish({
      data: {
        ...entry,
        revision: 2,
        translatedText: "迟到云端保存",
        mutation: {
          workRevision: 4,
          editorEpoch: 2,
          workflowStatus: "proofreading",
          submissionStage: "proofread",
        },
      },
      response: new Response(null, { status: 200 }),
    } as never);
  });
  expect(screen.queryByRole("button", { name: "提交校对" })).toBeNull();
  expect(screen.queryByDisplayValue("迟到云端保存")).toBeNull();
  expect(
    (screen.getByDisplayValue("回包前的本地输入") as HTMLTextAreaElement)
      .readOnly,
  ).toBe(true);
  expect(deleteTranslationDraft).not.toHaveBeenCalled();
  expect(
    vi.mocked(saveTranslationDraft).mock.calls.at(-1)?.[0].images[0].entries[0]
      .translatedText,
  ).toBe("回包前的本地输入");
});

test("reopening a returned translation keeps the previous epoch's local proofreading visible and copyable", async () => {
  const draft = createTranslationDraft(
    user.id,
    "work",
    [
      {
        ...image,
        entries: [{ ...entry, translatedText: "重新打开仍可复制的校对稿" }],
      },
    ] as never,
    { editorEpoch: 1, latestVersionId: null },
  );
  vi.mocked(loadTranslationDraft).mockResolvedValueOnce(draft);
  const app = setup(withdrawn);
  const local = (await screen.findByDisplayValue(
    "重新打开仍可复制的校对稿",
  )) as HTMLTextAreaElement;
  expect(local.readOnly).toBe(true);
  expect(local.disabled).toBe(false);
  expect(screen.getByText(/正在显示未同步本地稿，可选取复制/)).toBeTruthy();
  expect(app.patch).not.toHaveBeenCalled();
  expect(deleteTranslationDraft).not.toHaveBeenCalled();
});

test("a save conflict that discovers withdrawal shows the local proofreading rather than hiding it behind denied recovery", async () => {
  const app = setup();
  await app.ready();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("云端译文"), {
    target: { value: "冲突仍可复制的校对稿" },
  });
  app.setCloud(withdrawn);
  app.patch.mockResolvedValue({
    error: { message: "阶段已经回退" },
    response: new Response(null, { status: 409 }),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText(/其他翻译成员已撤回提交/);
  const local = screen.getByDisplayValue(
    "冲突仍可复制的校对稿",
  ) as HTMLTextAreaElement;
  expect(local.readOnly).toBe(true);
  expect(local.disabled).toBe(false);
  await app.beat();
  expect(app.reads()).toBe(2);
  expect(
    vi.mocked(saveTranslationDraft).mock.calls.at(-1)?.[0].editorEpoch,
  ).toBe(1);
});

test("the dual-role account cannot recover into somebody else's pages even if it can edit other translation pages", async () => {
  const app = setup();
  await app.ready();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("云端译文"), {
    target: { value: "不属于本人翻译页的校对稿" },
  });
  app.setCloud({ ...withdrawn, canEdit: true });
  await app.beat();
  fireEvent.click(
    await screen.findByRole("button", { name: "按最新基线恢复本地内容" }),
  );
  await screen.findByText(/本地草稿含无权修改或已提交的页/);
  expect(app.patch).not.toHaveBeenCalled();
  expect(
    (
      screen.getByDisplayValue(
        "不属于本人翻译页的校对稿",
      ) as HTMLTextAreaElement
    ).readOnly,
  ).toBe(true);
});

test("a pending heartbeat from another work cannot refresh or replace the current editor", async () => {
  const app = setup();
  await app.ready();
  let finish!: (result: never) => void;
  app.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await app.beat();
  app.setCloud({
    ...base,
    workId: "other",
    images: [
      { ...image, entries: [{ ...entry, translatedText: "另一作品的译文" }] },
    ],
  });
  fireEvent.click(screen.getByRole("link", { name: "打开另一作品" }));
  await screen.findByDisplayValue("另一作品的译文");
  const reads = app.reads();
  await act(async () => {
    finish({
      data: {
        items: [],
        expiresInSeconds: 90,
        workRevision: 4,
        editorEpoch: 2,
        workflowStatus: "translating",
        reviewStatus: "normal",
      },
      response: new Response(null, { status: 200 }),
    } as never);
  });
  expect(app.reads()).toBe(reads);
  expect(screen.getByDisplayValue("另一作品的译文")).toBeTruthy();
  expect(screen.queryByText(/其他翻译成员已撤回提交/)).toBeNull();
});

test("a late presence response cannot restore old proofreading permissions after withdrawal", async () => {
  const app = setup();
  await app.ready();
  app.setCloud(withdrawn);
  await app.beat();
  await screen.findByText(/其他翻译成员已撤回提交/);
  app.post.mockResolvedValue({
    data: {
      items: [],
      workRevision: 3,
      editorEpoch: 1,
      workflowStatus: "pending_proofread",
      reviewStatus: "normal",
    },
    response: new Response(null, { status: 200 }),
  } as never);
  await app.beat();
  expect(
    (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  expect(app.query.getQueryData(["translation-editor", "work"])).toMatchObject({
    workflowStatus: "translating",
    editorEpoch: 2,
  });
  expect(app.fetcher).not.toHaveBeenCalled();
});

test("navigating from a hydrated work cannot delete or overwrite the destination's stored local draft", async () => {
  const app = setup();
  await app.ready();
  const draft = createTranslationDraft(
    user.id,
    "other",
    [
      {
        ...image,
        entries: [{ ...entry, translatedText: "另一作品已有的本地稿" }],
      },
    ] as never,
    { editorEpoch: 1, latestVersionId: null },
  );
  vi.mocked(loadTranslationDraft).mockResolvedValueOnce(draft);
  vi.mocked(deleteTranslationDraft).mockClear();
  vi.mocked(saveTranslationDraft).mockClear();
  app.setCloud({ ...withdrawn, workId: "other" });
  fireEvent.click(screen.getByRole("link", { name: "打开另一作品" }));
  expect(
    (
      (await screen.findByDisplayValue(
        "另一作品已有的本地稿",
      )) as HTMLTextAreaElement
    ).readOnly,
  ).toBe(true);
  expect(deleteTranslationDraft).not.toHaveBeenCalledWith(user.id, "other");
  expect(saveTranslationDraft).not.toHaveBeenCalled();
});

test("a full read older than the observed stage signal keeps old editing frozen until a current read succeeds", async () => {
  const app = setup();
  await app.ready();
  app.setCloud(withdrawn);
  app.get.mockImplementationOnce(
    async () =>
      ({ data: base, response: new Response(null, { status: 200 }) }) as never,
  );
  await app.beat();
  await screen.findByText(/读取到旧的作品状态/);
  expect(
    (screen.getByDisplayValue("云端译文") as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新读取当前状态" }));
  await screen.findByText(/其他翻译成员已撤回提交/);
  expect(screen.queryByRole("button", { name: "提交校对" })).toBeNull();
  expect(app.reads()).toBe(3);
});

test("a colleague starting translation keeps the current owner's dirty page editable without reloading snapshots", async () => {
  const translating = {
    ...base,
    workflowStatus: "pending_translate",
    editStages: ["translate"],
    submissionStage: "translate",
    pageAssignments: [],
  };
  const app = setup(translating);
  await app.ready();
  fireEvent.change(screen.getByDisplayValue("云端译文"), {
    target: { value: "本人页尚未保存" },
  });
  app.setCloud({
    ...translating,
    workflowStatus: "translating",
    workRevision: 4,
  });
  await app.beat();
  expect(app.reads()).toBe(1);
  const local = screen.getByDisplayValue(
    "本人页尚未保存",
  ) as HTMLTextAreaElement;
  expect(local.readOnly).toBe(false);
  expect(
    screen.queryByRole("button", { name: "按最新基线恢复本地内容" }),
  ).toBeNull();
  expect(app.query.getQueryData(["translation-editor", "work"])).toMatchObject({
    workflowStatus: "translating",
    editorEpoch: 1,
    workRevision: 4,
  });
});

test("explicit recovery after proofreading starts restores only unchanged tracked entries and keeps a colleague's page", async () => {
  const otherEntry = {
    ...entry,
    id: "other-entry",
    workImageId: "other-page",
    translatedText: "同事最新译文",
    revision: 2,
  };
  const otherPage = {
    ...image,
    id: "other-page",
    orderIndex: 1,
    entries: [otherEntry],
  };
  const draft = createTranslationDraft(
    user.id,
    "work",
    [
      { ...image, entries: [{ ...entry, translatedText: "首笔前的本人修改" }] },
      {
        ...otherPage,
        entries: [{ ...otherEntry, translatedText: "同事旧译文", revision: 1 }],
      },
    ] as never,
    { editorEpoch: 1, latestVersionId: null },
    Date.now(),
    [entry.id],
  );
  vi.mocked(loadTranslationDraft).mockResolvedValueOnce(draft);
  const app = setup({
    ...base,
    workflowStatus: "proofreading",
    workRevision: 4,
    editorEpoch: 2,
    editableImageIds: ["page", "other-page"],
    images: [image, otherPage],
  });
  await app.ready();
  fireEvent.click(
    await screen.findByRole("button", { name: "按最新基线恢复本地内容" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("首笔前的本人修改") as HTMLTextAreaElement)
        .readOnly,
    ).toBe(false),
  );
  app.patch.mockResolvedValue({
    data: { ...entry, translatedText: "首笔前的本人修改", revision: 2 },
    response: new Response(null, { status: 200 }),
  } as never);
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(app.patch).toHaveBeenCalledTimes(1));
  expect(app.patch).toHaveBeenCalledWith(
    "/api/translation-entries/{entryId}",
    expect.objectContaining({
      params: { path: { entryId: "entry" } },
      body: expect.objectContaining({
        expectedEditorEpoch: 2,
        expectedRevision: 1,
        translatedText: "首笔前的本人修改",
      }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByDisplayValue("同事最新译文")).toBeTruthy();
  expect(screen.queryByDisplayValue("同事旧译文")).toBeNull();
});
