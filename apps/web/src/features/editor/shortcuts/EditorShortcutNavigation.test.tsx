import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
import type { CurrentUser, components } from "@comiku/api-client";
import { client } from "../../account/api";
import { TranslationEditorPage } from "../TranslationEditorPage";
import {
  defaultEditorShortcuts,
  writeEditorShortcuts,
} from "./editor-shortcuts";

const accountId = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function fixture(canEdit = true) {
  const user: CurrentUser = {
    id: accountId,
    username: "shortcuts",
    displayName: "快捷键测试",
    roles: ["translator"],
    languageCapabilities: ["ja"],
    isActive: true,
    mustChangePassword: false,
    revision: 0,
    canSkipProofreading: false,
    permissions: ["works:read", "works:translate"],
  };
  const head: components["schemas"]["TranslationEditorDto"] = {
    workId: crypto.randomUUID(),
    workNumber: 1,
    title: "快捷键测试",
    sourceLanguage: "ja",
    collaborationMode: "single",
    workflowStatus: "pending_translate",
    reviewStatus: "normal",
    openReviewCase: null,
    workRevision: 0,
    editorEpoch: 0,
    canEdit,
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
    images: [0, 1].map((orderIndex) => {
      const imageId = crypto.randomUUID();
      return {
        id: imageId,
        orderIndex,
        width: 200,
        height: 300,
        translationRevision: 0,
        entries: [0, 1].map((entryIndex) => ({
          id: crypto.randomUUID(),
          workImageId: imageId,
          orderIndex: entryIndex,
          markerX: 0.2,
          markerY: 0.2,
          markerPositionType: "inside",
          translatedText: `第${orderIndex + 1}页译文${entryIndex + 1}`,
          note: null,
          revision: 0,
          createdById: user.id,
          updatedById: user.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      };
    }),
  };
  const response = (data: unknown) =>
    ({
      data: structuredClone(data),
      response: new Response(null, { status: 200 }),
    }) as never;
  vi.spyOn(client, "GET").mockImplementation(async (path) =>
    response(
      path === "/api/works/{workId}/translations"
        ? head
        : { url: "/api/local-files/shortcut-test", expiresInSeconds: 300 },
    ),
  );
  const postPaths: string[] = [];
  vi.spyOn(client, "POST").mockImplementation(async (path) => {
    postPaths.push(path);
    return response({ items: [], expiresInSeconds: 90 });
  });
  vi.spyOn(client, "DELETE").mockImplementation(async () => response({}));
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
  fireEvent.load(await screen.findByAltText("第 1 页"));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "添加框内" }) as HTMLButtonElement)
        .disabled,
    ).toBe(!canEdit),
  );
  return {
    canvas: screen.getByLabelText(
      "图片标记画布，滚轮缩放，Ctrl 加 Z 撤销连续新标点",
    ),
    postPaths,
  };
}

function press(target: Element, key: string, flags: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...flags,
  });
  fireEvent(target, event);
  return event;
}

test("marker/page navigation stays in the page, retains focus, and makes no write requests", async () => {
  const { canvas, postPaths } = await fixture();
  canvas.focus();
  press(canvas, "ArrowDown");
  expect(screen.getByText("当前选择：标记 1")).toBeTruthy();
  expect(document.activeElement).toBe(canvas);
  press(canvas, "ArrowDown");
  expect(screen.getByText("当前选择：标记 2")).toBeTruthy();
  press(canvas, "ArrowDown");
  expect(screen.getByText("当前选择：标记 2")).toBeTruthy();
  expect(screen.getByAltText("第 1 页")).toBeTruthy();
  press(canvas, "ArrowUp");
  expect(screen.getByText("当前选择：标记 1")).toBeTruthy();
  press(canvas, "ArrowUp");
  expect(screen.getByText("当前选择：标记 1")).toBeTruthy();
  press(canvas, "ArrowLeft");
  expect(screen.getByText("当前选择：标记 1")).toBeTruthy();
  press(canvas, "ArrowRight");
  await screen.findByAltText("第 2 页");
  expect(screen.queryByText(/当前选择/)).toBeNull();
  press(canvas, "ArrowUp");
  expect(screen.getByText("当前选择：标记 2")).toBeTruthy();
  press(canvas, "ArrowRight");
  expect(screen.getByText("当前选择：标记 2")).toBeTruthy();
  expect(
    postPaths.every(
      (path) => path === "/api/works/{workId}/translations/presence",
    ),
  ).toBe(true);
});

test("list navigation ignores text fields, buttons, IME, active dialogs, and repeated keys", async () => {
  const { canvas } = await fixture();
  const list = screen.getByLabelText("译文标记列表");
  list.focus();
  press(list, "ArrowDown");
  expect(screen.getByText("当前选择：标记 1")).toBeTruthy();
  const area = screen.getByDisplayValue("第1页译文1");
  const page = screen.getByRole("button", { name: /预览并跳转页面/ });
  for (const target of [
    area,
    page,
    screen.getByRole("button", { name: "下一页" }),
    screen.getByRole("button", { name: "添加框内" }),
  ]) {
    expect(press(target, "ArrowDown").defaultPrevented).toBe(false);
    expect(press(target, "ArrowRight").defaultPrevented).toBe(false);
  }
  for (const flags of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { ctrlKey: true },
  ])
    expect(press(canvas, "ArrowRight", flags).defaultPrevented).toBe(false);
  fireEvent.compositionStart(area);
  expect(press(canvas, "ArrowRight").defaultPrevented).toBe(false);
  fireEvent.compositionEnd(area);
  fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
  expect(press(canvas, "ArrowRight").defaultPrevented).toBe(false);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }),
  );
  expect(press(canvas, "ArrowRight").defaultPrevented).toBe(true);
  await screen.findByAltText("第 2 页");
});

test("saved custom shortcuts update keycaps and behavior and readonly retains navigation", async () => {
  writeEditorShortcuts(accountId, {
    ...defaultEditorShortcuts,
    pan: "g",
    "next-page": "n",
  });
  const { canvas } = await fixture(false);
  expect(
    screen.getByRole("button", { name: "移动画布" }).querySelector("kbd")
      ?.textContent,
  ).toBe("G");
  expect(
    screen
      .getByRole("button", { name: "移动画布" })
      .getAttribute("aria-keyshortcuts"),
  ).toBe("G");
  canvas.focus();
  expect(press(canvas, "ArrowRight").defaultPrevented).toBe(false);
  expect(press(canvas, "2").defaultPrevented).toBe(false);
  expect(press(canvas, "n").defaultPrevented).toBe(true);
  await screen.findByAltText("第 2 页");
  fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
  fireEvent.keyDown(screen.getByLabelText("移动画布快捷键"), { key: "h" });
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  expect(
    screen.getByRole("button", { name: "移动画布" }).querySelector("kbd")
      ?.textContent,
  ).toBe("H");
  expect(press(canvas, "g").defaultPrevented).toBe(false);
  expect(press(canvas, "h").defaultPrevented).toBe(true);
});

test("readonly translation selection keeps native copy and text navigation without editor shortcuts", async () => {
  await fixture(false);
  const area = screen.getByDisplayValue("第1页译文1") as HTMLTextAreaElement;
  expect(area.readOnly).toBe(true);
  expect(area.disabled).toBe(false);
  area.focus();
  area.setSelectionRange(0, area.value.length);
  expect(press(area, "c", { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(press(area, "ArrowRight").defaultPrevented).toBe(false);
  expect(press(area, "Delete").defaultPrevented).toBe(false);
  expect(screen.getByAltText("第 1 页")).toBeTruthy();
  expect(area.value).toBe("第1页译文1");
});
