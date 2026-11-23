import { afterEach, beforeAll, expect, test, vi } from "vitest";
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
  vi.unstubAllGlobals();
});

const user: CurrentUser = {
  id: "proof",
  username: "proof",
  displayName: "校对员",
  roles: ["proofreader"],
  languageCapabilities: ["ja"],
  isActive: true,
  mustChangePassword: false,
  revision: 1,
  canSkipProofreading: false,
  permissions: ["works:read", "works:proofread"],
};
const entry = {
  id: "entry",
  workImageId: "page-one",
  orderIndex: 0,
  markerX: 0.3,
  markerY: 0.3,
  markerPositionType: "inside",
  translatedText: "旧译文",
  note: null,
  revision: 1,
};
const image = {
  id: "page-one",
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
  editStages: ["proofread"],
  editableImageIds: ["page-one", "page-two"],
  proofreadRequiresLease: true,
  proofreadLeases: [] as {
    workImageId: string;
    displayName: string;
    expiresAt: string;
  }[],
  canExportLabelPlus: true,
  joinableStage: null,
  submissionStage: "proofread" as string | null,
  cancelableSubmissionStage: null as "translate" | "proofread" | null,
  assignedImageIds: [] as string[],
  pageAssignments: [] as {
    workImageId: string;
    userId: string;
    generation: number;
    draftRevision?: number;
    submittedAt: string | null;
  }[],
  contributionCurrent: false,
  multiStageReady: false,
  hasUnsubmittedChanges: false,
  revisionStages: [],
  latestVersion: null,
  activeParticipants: [],
  images: [image, { ...image, id: "page-two", orderIndex: 1, entries: [] }],
};

function setup(editor = base) {
  vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data:
          path === "/api/works/{workId}/translations"
            ? editor
            : { url: "/api/local-files/fixture", expiresInSeconds: 300 },
        response: new Response(null, { status: 200 }),
      }) as never,
  );
  vi.spyOn(client, "POST").mockResolvedValue({
    data: { items: [], expiresInSeconds: 90 },
    response: new Response(null, { status: 200 }),
  } as never);
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
      <MemoryRouter initialEntries={["/works/work/editor"]}>
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
}

test("a dual-role proofreader is offered proofreading alone after all translations arrive", async () => {
  setup({
    ...base,
    cancelableSubmissionStage: "translate",
  });
  expect(await screen.findByRole("button", { name: "提交校对" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "取消翻译提交" })).toBeNull();
  expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
});

test("keeps same-stage actions accessible when a translator has both submitted and pending pages", async () => {
  setup({
    ...base,
    workflowStatus: "translating",
    editStages: ["translate"],
    submissionStage: "translate",
    proofreadRequiresLease: false,
    cancelableSubmissionStage: "translate",
  });
  expect(await screen.findByRole("button", { name: "提交翻译" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "取消翻译提交" })).toBeNull();
  const more = screen.getByRole("button", { name: "更多操作" });
  fireEvent.click(more);
  const cancel = screen.getByRole("button", { name: "取消翻译提交" });
  fireEvent.click(cancel);
  const dialog = await screen.findByRole("dialog", { name: "取消翻译提交？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(more);
  expect(screen.queryByRole("button", { name: "取消翻译提交" })).toBeNull();
  expect(
    (vi.mocked(client.POST).mock.calls as unknown as [string][]).some(
      ([path]) => path === "/api/works/{id}/stages/submission/cancel",
    ),
  ).toBe(false);

  fireEvent.keyDown(more, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "取消翻译提交" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "取消翻译提交" })).toBeNull();
  expect(document.activeElement).toBe(more);
  fireEvent.click(more);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("button", { name: "取消翻译提交" })).toBeNull();
});

test("directly offers a translator their own withdrawal while translating", async () => {
  setup({
    ...base,
    workflowStatus: "translating",
    canEdit: false,
    editStages: ["translate"],
    submissionStage: null,
    cancelableSubmissionStage: "translate",
    proofreadRequiresLease: false,
  });
  fireEvent.click(await screen.findByRole("button", { name: "取消翻译提交" }));
  expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  const dialog = await screen.findByRole("dialog", { name: "取消翻译提交？" });
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("does not offer upstream withdrawal once proofreading has started", async () => {
  setup({
    ...base,
    workflowStatus: "proofreading",
    editStages: ["translate", "proofread"],
  });
  expect(await screen.findByRole("button", { name: "提交校对" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  expect(screen.queryByRole("button", { name: "取消翻译提交" })).toBeNull();
});

test.each([200, 409])(
  "withdraws the original translation stage through the existing API and refreshes after HTTP %s",
  async (status) => {
    const editor = {
      ...base,
      canEdit: false,
      editStages: [],
      submissionStage: null,
      cancelableSubmissionStage: "translate" as const,
    };
    setup(editor);
    await screen.findByRole("button", { name: "取消翻译提交" });
    expect(screen.queryByRole("button", { name: "提交校对" })).toBeNull();
    vi.mocked(client.GET).mockImplementation(
      async (path) =>
        ({
          data:
            path === "/api/works/{workId}/translations"
              ? {
                  ...editor,
                  cancelableSubmissionStage: null,
                  workflowStatus:
                    status === 200 ? "translating" : "proofreading",
                }
              : { url: "/api/local-files/fixture", expiresInSeconds: 300 },
          response: new Response(null, { status: 200 }),
        }) as never,
    );
    vi.mocked(client.POST).mockImplementation(
      async () =>
        ({
          data: status === 200 ? { id: "work" } : undefined,
          error: status === 409 ? { message: "下游已开始" } : undefined,
          response: new Response(null, { status }),
        }) as never,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消翻译提交" }));
    const dialog = await screen.findByRole("dialog", {
      name: "取消翻译提交？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消提交" }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/works/{id}/stages/submission/cancel",
        expect.objectContaining({
          body: expect.objectContaining({
            stage: "translate",
            expectedRevision: 3,
            expectedEditorEpoch: 1,
          }),
        }),
      ),
    );
    expect(
      await screen.findByText(
        status === 200
          ? "翻译提交已取消，可以继续修改。"
          : "校对已开始保存，翻译提交已不能撤回；已更新当前状态。",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  },
);

test("proofreading opens directly and navigation never obtains or releases a page lease", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  setup();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  expect(screen.queryByRole("button", { name: "编辑本页" })).toBeNull();
  expect(screen.queryByRole("button", { name: "保存并结束编辑" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByAltText("第 2 页")).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

test("dirty proofreading saves with the ordinary revision and epoch fences without a lease heartbeat", async () => {
  const intervals = vi.spyOn(window, "setInterval");
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    data: { ...entry, translatedText: "本地校对", revision: 2 },
    response: new Response(null, { status: 200 }),
  } as never);
  setup();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("旧译文"), {
    target: { value: "本地校对" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  const body = (
    patch.mock.calls as unknown as [string, { body: Record<string, unknown> }][]
  )[0][1].body;
  expect(body).toMatchObject({
    expectedRevision: 1,
    expectedEditorEpoch: 1,
    translatedText: "本地校对",
  });
  expect(body).not.toHaveProperty("leaseToken");
  expect(body).not.toHaveProperty("editorInstanceId");
  expect(intervals.mock.calls.some(([, delay]) => delay === 20_000)).toBe(
    false,
  );
});

test("an ordinary multi proofreader imports all mapped pages using the preview content baseline", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  setup();
  const imported = {
    ...base,
    workRevision: 4,
    editorEpoch: 2,
    images: [
      {
        ...image,
        entries: [
          { ...entry, translatedText: "普通二校完整导入的译文", revision: 2 },
        ],
      },
      base.images[1],
    ],
  };
  vi.mocked(client.POST).mockImplementation(
    async (path) =>
      ({
        data:
          path === "/api/works/{workId}/labelplus/imports/preview"
            ? {
                formatVersion: "1,0",
                contentBaseline: "preview-baseline",
                imageCount: 2,
                markerCount: 1,
                mappings: base.images.map((page, index) => ({
                  sourceFileName: `page-${index + 1}.png`,
                  targetImageId: page.id,
                  targetFileName: `page-${index + 1}.png`,
                  markerCount: page.entries.length,
                })),
                warnings: [],
                blockingIssues: [],
                canImport: true,
              }
            : path === "/api/works/{workId}/labelplus/imports"
              ? imported
              : { items: [], expiresInSeconds: 90 },
        response: new Response(null, { status: 200 }),
      }) as never,
  );
  const open = await screen.findByRole("button", {
    name: "导入 LabelPlus",
  });
  expect(user.roles).toEqual(["proofreader"]);
  expect((open as HTMLButtonElement).disabled).toBe(false);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "导入 LabelPlus",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  const input = screen.getByLabelText(
    "选择 LabelPlus 文件",
  ) as HTMLInputElement;
  const chooseFile = vi.spyOn(input, "click");
  fireEvent.click(screen.getByRole("button", { name: "导入 LabelPlus" }));
  expect(chooseFile).toHaveBeenCalledOnce();
  fireEvent.change(input, {
    target: {
      files: [
        new File(["synthetic fixture"], "proofread.txt", {
          type: "text/plain",
        }),
      ],
    },
  });
  expect(await screen.findByText("LABELPLUS 导入预览")).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "覆盖并导入" });
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(confirm);
  expect(
    await screen.findByText(/已导入 2 个图片章节和 1 个标记/),
  ).toBeTruthy();
  const calls = vi.mocked(client.POST).mock.calls as unknown as [
    string,
    { body: FormData },
  ][];
  const body = calls.find(
    ([path]) => path === "/api/works/{workId}/labelplus/imports",
  )![1].body;
  expect(body.get("stage")).toBe("proofread");
  expect(body.get("expectedContentBaseline")).toBe("preview-baseline");
  expect(JSON.parse(String(body.get("pageAccess")))).toEqual([
    { imageId: "page-one" },
    { imageId: "page-two" },
  ]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue("普通二校完整导入的译文")).toBeTruthy();
});

test("keeps unowned translation pages read only while allowing the owner page", async () => {
  setup({
    ...base,
    workflowStatus: "translating",
    editStages: ["translate"],
    submissionStage: "translate",
    proofreadRequiresLease: false,
    editableImageIds: ["page-two"],
  });
  const text = await screen.findByDisplayValue("旧译文");
  expect((text as HTMLTextAreaElement).readOnly).toBe(true);
  expect((text as HTMLTextAreaElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "编辑本页" })).toBeNull();
  expect(screen.queryByLabelText("本页分工")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByAltText("第 2 页");
  expect(screen.queryByText("本人负责，可编辑", { exact: false })).toBeNull();
  expect(screen.queryByText("此页不在本人当前可编辑范围。")).toBeNull();
});

test("failed proofreading saves preserve local text and do not require a lock to retry", async () => {
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    error: { message: "保存失败" },
    response: new Response(null, { status: 500 }),
  } as never);
  setup();
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("旧译文"), {
    target: { value: "尚未保存的本地译文" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(screen.getByDisplayValue("尚未保存的本地译文")).toBeTruthy();
  expect(
    (screen.getByDisplayValue("尚未保存的本地译文") as HTMLTextAreaElement)
      .readOnly,
  ).toBe(false);
  expect(screen.queryByRole("button", { name: "编辑本页" })).toBeNull();
});

test("saves the exact owned draft before submitting without a second completion step", async () => {
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    data: {
      ...entry,
      translatedText: "保存后直接提交",
      revision: 2,
      mutation: {
        workRevision: 4,
        editorEpoch: 1,
        workflowStatus: "translating",
        submissionStage: "translate",
      },
    },
    response: new Response(null, { status: 200 }),
  } as never);
  setup({
    ...base,
    workflowStatus: "translating",
    editStages: ["translate"],
    submissionStage: "translate",
    proofreadRequiresLease: false,
    editableImageIds: ["page-one"],
    assignedImageIds: ["page-one"],
    pageAssignments: [
      {
        workImageId: "page-one",
        userId: user.id,
        generation: 7,
        submittedAt: null,
      },
    ],
  } as typeof base);
  const text = await screen.findByDisplayValue("旧译文");
  await waitFor(() =>
    expect((text as HTMLTextAreaElement).disabled).toBe(false),
  );
  fireEvent.change(text, { target: { value: "保存后直接提交" } });
  fireEvent.click(screen.getByRole("button", { name: "提交翻译" }));
  await waitFor(() =>
    expect(client.POST).toHaveBeenCalledWith(
      "/api/works/{id}/stages/submit",
      expect.objectContaining({
        body: expect.objectContaining({
          stage: "translate",
          expectedRevision: 4,
        }),
      }),
    ),
  );
  expect(patch).toHaveBeenCalledWith(
    "/api/translation-entries/{entryId}",
    expect.objectContaining({
      body: expect.objectContaining({
        expectedAssignmentGeneration: 7,
        translatedText: "保存后直接提交",
      }),
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(vi.mocked(patch).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(client.POST).mock.invocationCallOrder.at(-1)!,
  );
});

test("keeps punctuation approval open after synchronizing a dirty draft in the same submit action", async () => {
  vi.spyOn(client, "PATCH").mockResolvedValue({
    data: {
      ...entry,
      translatedText: "保存后,允许提交",
      revision: 2,
      mutation: {
        workRevision: 4,
        editorEpoch: 1,
        workflowStatus: "translating",
        submissionStage: "translate",
      },
    },
    response: new Response(null, { status: 200 }),
  } as never);
  setup({
    ...base,
    workflowStatus: "translating",
    editStages: ["translate"],
    submissionStage: "translate",
    proofreadRequiresLease: false,
    editableImageIds: ["page-one"],
    assignedImageIds: ["page-one"],
    pageAssignments: [
      {
        workImageId: "page-one",
        userId: user.id,
        generation: 7,
        submittedAt: null,
      },
    ],
  });
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("旧译文"), {
    target: { value: "保存后,允许提交" },
  });
  fireEvent.click(screen.getByRole("button", { name: "提交翻译" }));
  expect(
    await screen.findByRole("dialog", { name: "提交翻译阶段？" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "仍然提交" }));
  await waitFor(() =>
    expect(client.POST).toHaveBeenCalledWith(
      "/api/works/{id}/stages/submit",
      expect.objectContaining({
        body: expect.objectContaining({ expectedRevision: 4 }),
      }),
    ),
  );
});

test("loads a changed cloud draft for review before sending exact pending page heads", async () => {
  const mine = {
    ...base,
    workflowStatus: "translating",
    editStages: ["translate"],
    submissionStage: "translate",
    proofreadRequiresLease: false,
    editableImageIds: ["page-one"],
    assignedImageIds: ["page-one"],
    pageAssignments: [
      {
        workImageId: "page-one",
        userId: user.id,
        generation: 7,
        draftRevision: 1,
        submittedAt: null,
      },
    ],
  };
  setup(mine);
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).disabled,
    ).toBe(false),
  );
  const changed = {
    ...mine,
    workRevision: 4,
    pageAssignments: [{ ...mine.pageAssignments[0], draftRevision: 2 }],
    images: [
      {
        ...image,
        entries: [
          { ...entry, translatedText: "另一设备最新译文", revision: 2 },
        ],
      },
      mine.images[1],
    ],
  };
  vi.mocked(client.GET).mockImplementation(
    async (path) =>
      ({
        data:
          path === "/api/works/{workId}/translations"
            ? changed
            : { url: "/api/local-files/fixture", expiresInSeconds: 300 },
        response: new Response(null, { status: 200 }),
      }) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "提交翻译" }));
  expect(await screen.findByText(/云端负责页或归属已变化/)).toBeTruthy();
  expect(screen.getByDisplayValue("另一设备最新译文")).toBeTruthy();
  expect(
    (vi.mocked(client.POST).mock.calls as unknown as [string, unknown][]).some(
      ([path]) => path === "/api/works/{id}/stages/submit",
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "提交翻译" }));
  await waitFor(() =>
    expect(client.POST).toHaveBeenCalledWith(
      "/api/works/{id}/stages/submit",
      expect.objectContaining({
        body: expect.objectContaining({
          expectedRevision: 4,
          pageHeads: [{ imageId: "page-one", generation: 7, draftRevision: 2 }],
        }),
      }),
    ),
  );
});

test("another active editor never blocks direct proofreading entry", async () => {
  setup({
    ...base,
    activeParticipants: [
      {
        userId: "other",
        displayName: "其他校对",
        mode: "edit",
        isCurrentSession: false,
      },
    ] as never,
  });
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).readOnly,
    ).toBe(false),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("已有成员正在编辑")).toBeNull();
});

test("page navigation stays available immediately without an acquisition request", async () => {
  setup();
  await screen.findByDisplayValue("旧译文");
  expect(
    (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByAltText("第 2 页")).toBeTruthy();
});

test("direct entry makes an authorized proofreader writable without collaboration or page-lock controls", async () => {
  setup(base);
  const text = (await screen.findByDisplayValue(
    "旧译文",
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(text.readOnly).toBe(false));
  expect(text.disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "编辑本页" })).toBeNull();
  expect(screen.queryByRole("button", { name: "进入协作" })).toBeNull();
  expect(screen.queryByRole("button", { name: "仅查看" })).toBeNull();
  expect(
    (
      vi.mocked(client.POST).mock.calls as unknown as [
        string,
        { body: { mode: string } },
      ][]
    ).some(
      ([path, options]) =>
        path === "/api/works/{workId}/translations/presence" &&
        options?.body?.mode === "edit",
    ),
  ).toBe(true);
});

test("a qualified but unjoined reader keeps selectable readonly translation and notes without joining", async () => {
  const patch = vi.spyOn(client, "PATCH");
  setup({
    ...base,
    canEdit: false,
    joinableStage: "proofread" as never,
    editableImageIds: [],
    images: [{ ...image, entries: [{ ...entry, note: "可复制备注" }] }],
  } as never);
  const text = (await screen.findByDisplayValue(
    "旧译文",
  )) as HTMLTextAreaElement;
  const note = screen.getByDisplayValue("可复制备注") as HTMLTextAreaElement;
  for (const field of [text, note]) {
    expect(field.readOnly).toBe(true);
    expect(field.disabled).toBe(false);
    field.focus();
    field.setSelectionRange(0, field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
    expect(fireEvent.keyDown(field, { key: "c", ctrlKey: true })).toBe(true);
    fireEvent.keyDown(field, { key: "Delete" });
    fireEvent.keyDown(field, { key: "x", ctrlKey: true });
  }
  expect(text.value).toBe("旧译文");
  expect(note.value).toBe("可复制备注");
  expect(patch).not.toHaveBeenCalled();
  expect(
    (
      vi.mocked(client.POST).mock.calls as unknown as [
        string,
        { body: { mode: string } },
      ][]
    ).every(
      ([path, options]) =>
        path === "/api/works/{workId}/translations/presence" &&
        options.body.mode === "view",
    ),
  ).toBe(true);
});
