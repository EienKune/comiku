import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
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

test("browses without a lease, explicitly acquires fresh page content, and releases on navigation", async () => {
  const fetcher = vi.fn().mockImplementation(async (_url, options) =>
    options.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          leaseToken: "token",
          editorEpoch: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          image: {
            ...image,
            entries: [{ ...entry, translatedText: "最新云端译文" }],
          },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  setup();
  const text = await screen.findByDisplayValue("旧译文");
  const permission = screen.getByLabelText("本页编辑权限");
  expect(permission.closest(".translation-entry-panel")).toBeTruthy();
  expect(
    screen.getByLabelText("编辑工具").previousElementSibling?.tagName,
  ).toBe("HEADER");
  expect((text as HTMLTextAreaElement).disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "完成我的部分" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "编辑本页" }));
  const fresh = await screen.findByDisplayValue("最新云端译文");
  await waitFor(() =>
    expect((fresh as HTMLTextAreaElement).disabled).toBe(false),
  );
  expect(
    screen
      .getByRole("button", { name: "保存并结束编辑" })
      .closest(".translation-entry-panel"),
  ).toBeTruthy();
  expect(screen.queryByText("浏览不占用编辑锁")).toBeNull();
  const acquire = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(acquire.expectedEditorEpoch).toBe(1);
  expect(acquire.editorInstanceId).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1][1].method).toBe("DELETE");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    editorInstanceId: acquire.editorInstanceId,
    leaseToken: "token",
  });
  expect(await screen.findByAltText("第 2 页")).toBeTruthy();
});

test("renews without an image and preserves the dirty page while merging the new epoch", async () => {
  let heartbeat: (() => void) | undefined;
  const nativeInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
    if (delay === 20_000 && typeof callback === "function")
      heartbeat = () => callback();
    return nativeInterval(callback, delay) as unknown as ReturnType<
      typeof window.setInterval
    >;
  });
  const fetcher = vi.fn().mockImplementation(async (_url, input) => {
    if (input.method === "DELETE") return new Response(null, { status: 204 });
    const renew = Boolean(JSON.parse(input.body).leaseToken);
    return Response.json({
      leaseToken: "token",
      editorEpoch: renew ? 2 : 1,
      expiresAt: new Date(
        Date.now() + (renew ? 120_000 : 60_000),
      ).toISOString(),
      ...(!renew && { image }),
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    data: {
      ...entry,
      translatedText: "尚未保存的本地校对",
      revision: 2,
      mutation: {
        workRevision: 4,
        editorEpoch: 2,
        workflowStatus: "proofreading",
        submissionStage: "proofread",
      },
    },
    response: new Response(null, { status: 200 }),
  } as never);
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "编辑本页" }));
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("旧译文"), {
    target: { value: "尚未保存的本地校对" },
  });
  await waitFor(() => expect(heartbeat).toBeTypeOf("function"));
  await act(async () => {
    heartbeat?.();
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(
    (screen.getByDisplayValue("尚未保存的本地校对") as HTMLTextAreaElement)
      .disabled,
  ).toBe(false);
  expect(screen.queryByDisplayValue("旧译文")).toBeNull();
  expect(screen.getByRole("button", { name: "保存并结束编辑" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      "/api/translation-entries/{entryId}",
      expect.objectContaining({
        body: expect.objectContaining({
          expectedEditorEpoch: 2,
          leaseToken: "token",
          translatedText: "尚未保存的本地校对",
        }),
      }),
    ),
  );
});

test("an ordinary multi proofreader can open LabelPlus and import all pages under their leases", async () => {
  const fetcher = vi.fn().mockImplementation(async (url, input) =>
    input.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          leaseToken: String(url).includes("page-one")
            ? "token-one"
            : "token-two",
          editorEpoch: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          image: String(url).includes("page-one")
            ? base.images[0]
            : base.images[1],
        }),
  );
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
  expect((open as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "编辑本页" }));
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
  expect(JSON.parse(String(body.get("pageAccess")))).toEqual([
    {
      imageId: "page-one",
      editorInstanceId: expect.any(String),
      leaseToken: "token-one",
    },
    {
      imageId: "page-two",
      editorInstanceId: expect.any(String),
      leaseToken: "token-two",
    },
  ]);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([, options]) => options.method === "DELETE"),
    ).toHaveLength(2),
  );
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
  expect((text as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "编辑本页" })).toBeNull();
  expect(screen.queryByLabelText("本页分工")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByAltText("第 2 页");
  expect(screen.queryByText("本人负责，可编辑", { exact: false })).toBeNull();
  expect(screen.queryByText("此页不在本人当前可编辑范围。")).toBeNull();
});

test("saves with the instance lease and stays on the page when saving fails", async () => {
  const fetcher = vi.fn().mockImplementation(async (_url, options) =>
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
  const patch = vi.spyOn(client, "PATCH").mockResolvedValue({
    error: { message: "保存失败" },
    response: new Response(null, { status: 500 }),
  } as never);
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "编辑本页" }));
  await waitFor(() =>
    expect(
      (screen.getByDisplayValue("旧译文") as HTMLTextAreaElement).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByDisplayValue("旧译文"), {
    target: { value: "尚未保存的本地译文" },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch).toHaveBeenCalledWith(
    "/api/translation-entries/{entryId}",
    expect.objectContaining({
      body: expect.objectContaining({
        leaseToken: "token",
        editorInstanceId: JSON.parse(fetcher.mock.calls[0][1].body)
          .editorInstanceId,
      }),
    }),
  );
  expect(await screen.findByText(/当前页尚未保存成功/)).toBeTruthy();
  expect(screen.getByDisplayValue("尚未保存的本地译文")).toBeTruthy();
  expect(screen.getByAltText("第 1 页")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
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

test("can request a page whose last known holder has since released it", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      leaseToken: "new-token",
      editorEpoch: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      image,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  setup({
    ...base,
    proofreadLeases: [
      {
        workImageId: image.id,
        displayName: "上一位校对",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  });
  expect(await screen.findByText(/上一位校对/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑本页" }));
  expect(
    await screen.findByRole("button", { name: "保存并结束编辑" }),
  ).toBeTruthy();
});

test("keeps the acquired page current while its edit request is in flight", async () => {
  let respond!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, options) =>
      options.method === "DELETE"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : new Promise<Response>((resolve) => {
            respond = resolve;
          }),
    ),
  );
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "编辑本页" }));
  expect(
    (screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: /预览并跳转页面/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => {
    respond(
      Response.json({
        leaseToken: "a",
        editorEpoch: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        image,
      }),
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByAltText("第 2 页")).toBeTruthy();
});
