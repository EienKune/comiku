import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { CurrentUser, components } from "@comiku/api-client";
import { client } from "../account/api";
import { TranslationEditorPage } from "./TranslationEditorPage";

type Entry = components["schemas"]["TranslationEntryDto"];
type Editor = components["schemas"]["TranslationEditorDto"];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const user: CurrentUser = {
    id: "00000000-0000-4000-8000-000000000001",
    username: "interaction",
    displayName: "交互译者",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 0,
    canSkipProofreading: false,
    permissions: ["works:read", "works:translate"],
  };
  const head: Editor = {
    workId: crypto.randomUUID(),
    workNumber: 1,
    title: "交互验收",
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "pending_translate",
    reviewStatus: "normal",
    openReviewCase: null,
    workRevision: 0,
    editorEpoch: 0,
    canEdit: true,
    editStages: ["translate"],
    canExportLabelPlus: true,
    joinableStage: null,
    submissionStage: "translate",
    cancelableSubmissionStage: null,
    assignedImageIds: [],
    contributionCurrent: false,
    multiStageReady: false,
    hasUnsubmittedChanges: false,
    revisionStages: [],
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    latestVersion: null,
    typesetHandoffStartedAt: null,
    activeParticipants: [],
    canSkipProofreading: false,
    skipProofreadingUnavailableReason: null,
    images: [0, 1].map((orderIndex) => ({
      id: crypto.randomUUID(),
      orderIndex,
      width: 200,
      height: 300,
      translationRevision: 0,
      entries: [],
    })),
  };
  let delayCreate: (() => Promise<void>) | null = null;
  let failCreate = false;
  const created = new Map<string, Entry>();
  const response = (data: unknown, status = 200) =>
    ({
      data: status < 400 ? structuredClone(data) : undefined,
      error: status >= 400 ? { message: "版本已变化" } : undefined,
      response: new Response(null, { status }),
    }) as never;
  const mutation = () => ({
    editorEpoch: head.editorEpoch,
    workRevision: ++head.workRevision,
    workflowStatus: head.workflowStatus,
    submissionStage: "translate",
    imageRevisions: [],
  });
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    response(
      path === "/api/works/{workId}/translations"
        ? head
        : { url: "/api/local-files/interactions", expiresInSeconds: 300 },
    ),
  );
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path, options) => {
      if (path !== "/api/work-images/{imageId}/markers")
        return response({ items: [], expiresInSeconds: 90 });
      if (delayCreate) await delayCreate();
      const input = options as {
        params: { path: { imageId: string } };
        body: {
          markerX: number;
          markerY: number;
          markerPositionType: "inside" | "outside";
          idempotencyKey: string;
        };
      };
      const image = head.images.find(
        (image) => image.id === input.params.path.imageId,
      )!;
      if (!created.has(input.body.idempotencyKey)) {
        const entry: Entry = {
          id: crypto.randomUUID(),
          workImageId: image.id,
          orderIndex: image.entries.length,
          markerX: input.body.markerX,
          markerY: input.body.markerY,
          markerPositionType: input.body.markerPositionType,
          translatedText: "",
          note: null,
          revision: 0,
          createdById: user.id,
          updatedById: user.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        image.entries.push(entry);
        image.translationRevision++;
        created.set(input.body.idempotencyKey, entry);
      }
      head.workflowStatus = "translating";
      if (failCreate) throw new Error("创建响应丢失");
      return response({ ...image, mutation: mutation() });
    });
  const del = vi
    .spyOn(client, "DELETE")
    .mockImplementation(async (path, options) => {
      if (path !== "/api/translation-entries/{entryId}")
        return response({ items: [], expiresInSeconds: 90 });
      const input = options as {
        params: { path: { entryId: string } };
        body: {
          expectedRevision: number;
          expectedImageRevision: number;
          expectedEditorEpoch: number;
        };
      };
      const image = head.images.find((image) =>
        image.entries.some((entry) => entry.id === input.params.path.entryId),
      )!;
      const entry = image.entries.find(
        (entry) => entry.id === input.params.path.entryId,
      )!;
      if (
        input.body.expectedRevision !== entry.revision ||
        input.body.expectedImageRevision !== image.translationRevision ||
        input.body.expectedEditorEpoch !== head.editorEpoch
      )
        return response(null, 409);
      image.entries = image.entries
        .filter((entry) => entry.id !== input.params.path.entryId)
        .map((entry, orderIndex) => ({ ...entry, orderIndex }));
      image.translationRevision++;
      return response({ ...image, mutation: mutation() });
    });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/works/${head.workId}/editor`]}>
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
  const img = await screen.findByAltText("第 1 页");
  vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 300,
    right: 200,
    bottom: 300,
  } as DOMRect);
  const canvas = screen.getByLabelText(
    "图片标记画布，Alt 加滚轮缩放，Ctrl 加 Z 撤销连续新标点",
  );
  canvas.setPointerCapture = vi.fn();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "添加框内" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  const point = () =>
    fireEvent.pointerDown(canvas, { clientX: 40, clientY: 60, pointerId: 1 });
  const undo = () => fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
  return {
    head,
    post,
    del,
    deleteCalls: () =>
      del.mock.calls as unknown as [
        string,
        { params: { path: { entryId: string } } },
      ][],
    createCalls: () => post.mock.calls as unknown as [string, unknown][],
    canvas,
    img,
    point,
    undo,
    setDelay: (delay: () => Promise<void>) => {
      delayCreate = delay;
    },
    failCreate: () => {
      failCreate = true;
    },
  };
}

test("defaults to pan, preserves marker selection and removes ordering controls", async () => {
  const f = await fixture();
  expect(
    screen
      .getByRole("button", { name: "移动画布" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: "选择" })).toBeNull();
  f.point();
  fireEvent.pointerUp(f.canvas);
  expect(f.head.images[0].entries).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "添加框内" }));
  f.point();
  await screen.findByRole("button", { name: "标记 1" });
  expect(screen.queryByRole("button", { name: "上移" })).toBeNull();
  expect(screen.queryByRole("button", { name: "下移" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "移动画布" }));
  fireEvent.click(screen.getByRole("button", { name: "标记 1" }));
  await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
});

test("Alt wheel consumes only canvas zoom and keeps the pointer anchor and limits", async () => {
  const f = await fixture();
  const ordinary = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: -100,
    clientX: 150,
    clientY: 150,
  });
  fireEvent(f.canvas, ordinary);
  expect(ordinary.defaultPrevented).toBe(false);
  const alt = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    altKey: true,
    deltaY: -100,
    clientX: 150,
    clientY: 150,
  });
  fireEvent(f.canvas, alt);
  expect(alt.defaultPrevented).toBe(true);
  expect(f.img.parentElement?.style.transform).toBe(`scale(${Math.exp(0.2)})`);
  expect(f.img.parentElement?.parentElement?.style.transform).toBe(
    `translate(${50 * (1 - Math.exp(0.2))}px, 0px)`,
  );
  fireEvent.wheel(f.canvas, { altKey: true, deltaY: -10000 });
  expect(f.img.parentElement?.style.transform).toBe("scale(3)");
  fireEvent.wheel(f.canvas, { altKey: true, deltaY: 10000 });
  expect(f.img.parentElement?.style.transform).toBe("scale(0.4)");
  const outside = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    altKey: true,
    deltaY: -100,
  });
  fireEvent(screen.getByText("译文条目"), outside);
  expect(outside.defaultPrevented).toBe(false);
  expect(f.img.parentElement?.style.transform).toBe("scale(0.4)");
});

test.each(["shortcut", "button"])(
  "%s deletion serializes after in-flight creation and deletes its resolved server ID",
  async (method) => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setDelay(() => gate);
    fireEvent.click(screen.getByRole("button", { name: "添加框内" }));
    f.point();
    await screen.findByText("待创建");
    if (method === "shortcut") f.undo();
    else fireEvent.click(screen.getByRole("button", { name: "删除标记" }));
    expect(f.head.images[0].entries).toHaveLength(0);
    expect(
      f
        .deleteCalls()
        .filter(([path]) => path === "/api/translation-entries/{entryId}"),
    ).toHaveLength(0);
    release();
    await waitFor(() => expect(f.head.images[0].translationRevision).toBe(2));
    expect(f.head.images[0].entries).toHaveLength(0);
    expect(f.head.workflowStatus).toBe("translating");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "标记 1" })).toBeNull(),
    );
  },
);

test("undo removes successive synchronized outside markers in LIFO order", async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "添加框外" }));
  f.point();
  await screen.findByRole("button", { name: "标记 1" });
  const first = f.head.images[0].entries[0].id;
  f.point();
  await screen.findByRole("button", { name: "标记 2" });
  const second = f.head.images[0].entries[1].id;
  f.undo();
  f.undo();
  await waitFor(() => expect(f.head.images[0].entries).toHaveLength(0));
  const ids = f
    .deleteCalls()
    .filter(([path]) => path === "/api/translation-entries/{entryId}")
    .map(
      ([, options]) =>
        (options as { params: { path: { entryId: string } } }).params.path
          .entryId,
    );
  expect(ids).toEqual([second, first]);
});

test("offline local marker is removable without creating a server record", async () => {
  const f = await fixture();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "添加框内" }));
  f.point();
  await screen.findByText("待创建");
  f.undo();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "标记 1" })).toBeNull(),
  );
  expect(
    f
      .createCalls()
      .filter(([path]) => path === "/api/work-images/{imageId}/markers"),
  ).toHaveLength(0);
  expect(f.head.workflowStatus).toBe("pending_translate");
});

test("lost creation response retains the draft instead of silently orphaning a marker", async () => {
  const f = await fixture();
  f.failCreate();
  fireEvent.click(screen.getByRole("button", { name: "添加框内" }));
  f.point();
  await screen.findByText("保存失败，本地草稿仍保留");
  f.undo();
  await screen.findByText("创建结果尚未确认，请先同步标点，再使用删除按钮。");
  expect(f.head.images[0].entries).toHaveLength(1);
  expect(screen.getByRole("button", { name: "标记 1" })).toBeTruthy();
});

test.each(["tool", "page", "text", "blur"])(
  "%s ends the continuous undo session",
  async (boundary) => {
    const f = await fixture();
    fireEvent.click(screen.getByRole("button", { name: "添加框内" }));
    f.point();
    await screen.findByRole("button", { name: "标记 1" });
    if (boundary === "tool") {
      fireEvent.click(screen.getByRole("button", { name: "移动画布" }));
      fireEvent.click(screen.getByRole("button", { name: "添加框内" }));
    }
    if (boundary === "page") {
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    }
    if (boundary === "text") {
      const text = screen.getByPlaceholderText("输入对应译文");
      text.focus();
      const e = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        ctrlKey: true,
      });
      fireEvent(text, e);
      expect(e.defaultPrevented).toBe(false);
    }
    if (boundary === "blur") fireEvent(window, new Event("blur"));
    f.canvas.focus();
    f.undo();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.head.images[0].entries).toHaveLength(1);
  },
);

test.each(["entry", "image", "epoch"])(
  "a conflicting %s version stops queued undos and preserves the collaborator change",
  async (conflict) => {
    const f = await fixture();
    fireEvent.click(screen.getByRole("button", { name: "添加框内" }));
    f.point();
    await screen.findByRole("button", { name: "标记 1" });
    f.point();
    await screen.findByRole("button", { name: "标记 2" });
    f.head.images[0].entries[1].translatedText = "其他成员内容";
    if (conflict === "entry") f.head.images[0].entries[1].revision++;
    if (conflict === "image") f.head.images[0].translationRevision++;
    if (conflict === "epoch") f.head.editorEpoch++;
    f.undo();
    f.undo();
    await screen.findByText("删除前条目或图片顺序已更新。");
    expect(f.head.images[0].entries).toHaveLength(2);
    expect(screen.getByDisplayValue("其他成员内容")).toBeTruthy();
    expect(
      f
        .deleteCalls()
        .filter(([path]) => path === "/api/translation-entries/{entryId}"),
    ).toHaveLength(1);
  },
);
