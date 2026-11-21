import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { components, CurrentUser } from "@comiku/api-client";
import { client, queryClient } from "../account/api";
import { WorkDetailPage } from "./BusinessPages";

type Work = components["schemas"]["WorkDetailDto"];
vi.mock("./use-work-image-url", () => ({
  useWorkImageUrl: () => ({ data: undefined, isPending: false }),
}));
vi.mock("./TypesetCollaborationPanel", () => ({
  TypesetCollaborationPanel: () => null,
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
  vi.unstubAllGlobals();
  queryClient.clear();
});

const user: CurrentUser = {
  id: "self",
  username: "member",
  displayName: "本人",
  roles: ["translator", "proofreader", "typesetter"],
  permissions: [
    "works:read",
    "works:translate",
    "works:proofread",
    "works:typeset",
  ],
  languageCapabilities: ["ja"],
  isActive: true,
  mustChangePassword: false,
  revision: 0,
  canSkipProofreading: false,
};
function fixture(
  stage: "translate" | "proofread" | "typeset" = "translate",
  mode: "single" | "multi" = "multi",
): Work {
  return {
    id: "work",
    workNumber: 1,
    authorId: "author",
    authorName: "作者",
    title: "操作布局测试",
    sourcePostUrl: null,
    sourceText: null,
    sourceLanguage: "ja",
    collaborationMode: mode,
    workflowStatus:
      stage === "translate"
        ? "translating"
        : stage === "proofread"
          ? "proofreading"
          : "typesetting",
    reviewStatus: "normal",
    priority: 0,
    revision: 3,
    editorEpoch: 0,
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    imageCount: 2,
    coverImageId: null,
    participantCount: mode === "single" ? 1 : 2,
    assignedStages: [stage],
    importedAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    publishedAt: null,
    images: ["one", "two"].map((id, orderIndex) => ({
      id,
      orderIndex,
      fileName: `${id}.png`,
      width: 100,
      height: 100,
    })),
    participants: (mode === "single" ? ["self"] : ["self", "other"]).map(
      (id, index) => ({
        id: `${id}-participant`,
        userId: id,
        displayName: id === "self" ? "本人" : "其他成员",
        stage,
        participationMode: "owner",
        workCreditName: null,
        creditNameSnapshot: null,
        joinedAt: "2026-11-20T00:00:00Z",
        submittedAt: null,
        leftAt: null,
        assignedImageIds: [index === 0 ? "one" : "two"],
        contributionSubmittedAt: null,
        contributionCurrent: false,
      }),
    ),
    events: [],
    openReviewCaseId: null,
  } as unknown as Work;
}
async function show(work: Work, actor = user) {
  vi.spyOn(client, "GET").mockResolvedValue({
    data: work,
    response: new Response(null, { status: 200 }),
  } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/works/work"]}>
        <Routes>
          <Route element={<Outlet context={actor} />}>
            <Route path="/works/:id" element={<WorkDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText("操作布局测试");
}

test.each(["translate", "typeset"] as const)(
  "multi %s cancellation stays inside own management and keeps the leave preview",
  async (stage) => {
    const work = fixture(stage);
    const post = vi.spyOn(client, "POST").mockResolvedValue({
      data: work,
      response: new Response(null, { status: 200 }),
    } as never);
    const request = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            drafts: [
              {
                id: "supplement",
                participantId: "self-participant",
                workImageId: null,
                sourceName: "补充页.png",
              },
              {
                id: "other-supplement",
                participantId: "other-participant",
                workImageId: null,
                sourceName: "他人补充页.png",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", request);
    await show(work, {
      ...user,
      permissions: [...user.permissions, "works:admin"],
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: `${stage === "translate" ? "翻译" : "嵌字"} · 查看分工`,
      }),
    );
    expect(screen.queryByRole("button", { name: "取消接取" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /管理页认领/ }));
    const other = screen.getByRole("dialog", { name: "管理页认领" });
    fireEvent.click(within(other).getByRole("combobox", { name: "管理成员" }));
    fireEvent.click(within(other).getByRole("option", { name: "其他成员" }));
    expect(
      within(other).queryByRole("button", { name: "取消接取" }),
    ).toBeNull();
    fireEvent.click(
      within(other).getByRole("button", { name: "关闭分工窗口" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /管理本人认领/ }));
    const own = screen.getByRole("dialog", { name: "管理本人认领" });
    expect(within(own).getByRole("button", { name: "保存认领" })).toBeTruthy();
    fireEvent.click(within(own).getByRole("button", { name: "取消接取" }));
    let confirmation = await screen.findByRole("dialog", {
      name: `取消${stage === "translate" ? "翻译" : "嵌字"}接取？`,
    });
    expect(confirmation.textContent).toContain("第 1 页");
    expect(confirmation.textContent).not.toContain("第 2 页");
    if (stage === "typeset") {
      expect(confirmation.textContent).toContain("补充页.png");
      expect(confirmation.textContent).not.toContain("他人补充页.png");
    }
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("dialog", { name: "管理本人认领" })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(own).getByRole("button", { name: "取消接取" }));
    confirmation = await screen.findByRole("dialog", {
      name: `取消${stage === "translate" ? "翻译" : "嵌字"}接取？`,
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "取消接取" }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/works/{id}/stages/leave",
        expect.objectContaining({
          body: expect.objectContaining({
            stage,
            expectedRevision: 3,
            confirmClearDraft: true,
            impactImageIds: ["one"],
            impactSupplementIds: stage === "typeset" ? ["supplement"] : [],
          }),
        }),
      ),
    );
    expect(post).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ["translate", "single"],
  ["proofread", "single"],
  ["proofread", "multi"],
] as const)(
  "keeps %s %s cancellation in stage actions",
  async (stage, mode) => {
    await show(fixture(stage, mode));
    fireEvent.click(screen.getByRole("button", { name: "取消接取" }));
    expect(
      await screen.findByRole("dialog", {
        name: `取消${stage === "translate" ? "翻译" : "校对"}接取？`,
      }),
    ).toBeTruthy();
  },
);

test.each([
  ["pending_translate", "进入翻译工作区"],
  ["translating", "进入翻译工作区"],
  ["pending_proofread", "进入校对工作区"],
  ["proofreading", "进入校对工作区"],
  ["pending_typeset", "查看翻译稿"],
  ["pending_publish", "查看翻译稿"],
  ["published", "进入翻译工作区"],
  ["archived", "进入翻译工作区"],
] as const)(
  "keeps one editor link in the current-work heading for a read-only %s viewer",
  async (workflowStatus, label) => {
    await show(
      { ...fixture(), workflowStatus, participants: [] },
      { ...user, roles: [], permissions: ["works:read"] },
    );
    const link = screen.getByRole("link", { name: label });
    expect(link.getAttribute("href")).toBe("/works/work/editor");
    expect(link.closest(".workspace-panel-heading")?.textContent).toContain(
      "当前工作",
    );
    expect(link.querySelector("svg")).toBeTruthy();
    expect(
      document.querySelector(".workspace-page-badges a[href$='/editor']"),
    ).toBeNull();
    expect(
      screen
        .getAllByRole("link")
        .filter((item) => item.getAttribute("href") === "/works/work/editor"),
    ).toHaveLength(1);
  },
);

test("keeps a rejected leave visible inside own management", async () => {
  vi.spyOn(client, "POST").mockResolvedValue({
    error: { message: "分工已更新，请刷新后重试" },
    response: new Response(null, { status: 409 }),
  } as never);
  await show(fixture());
  fireEvent.click(screen.getByRole("button", { name: "翻译 · 查看分工" }));
  fireEvent.click(screen.getByRole("button", { name: /管理本人认领/ }));
  const own = screen.getByRole("dialog", { name: "管理本人认领" });
  fireEvent.click(within(own).getByRole("button", { name: "取消接取" }));
  const confirmation = await screen.findByRole("dialog", {
    name: "取消翻译接取？",
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "取消接取" }),
  );
  expect(await within(own).findByRole("alert")).toHaveProperty(
    "textContent",
    "分工已更新，请刷新后重试",
  );
  expect(
    within(own)
      .getByRole("button", { name: "保存认领" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("keeps credit save beside the input and its hint below the input row", async () => {
  await show(fixture("translate", "single"));
  const input = screen.getByRole("textbox", { name: "翻译署名" });
  const row = input.closest(".ui-field__input-row");
  expect(row).not.toBeNull();
  expect(
    within(row as HTMLElement).getByRole("button", { name: "保存署名" }),
  ).toBeTruthy();
  const hint = document.getElementById(input.getAttribute("aria-describedby")!);
  expect(hint).toBeTruthy();
  expect(row?.contains(hint)).toBe(false);
});

test("members stay in join order and personal controls are outside the compact roster", async () => {
  const work = fixture();
  work.participants[0].joinedAt = "2026-11-20T02:00:00Z";
  work.participants[1].joinedAt = "2026-11-20T01:00:00Z";
  await show(work);
  fireEvent.click(screen.getByRole("button", { name: "翻译 · 查看分工" }));
  const roster = screen
    .getByRole("dialog", { name: "翻译页分工" })
    .querySelector(".workspace-stage-people")!;
  expect(
    [...roster.querySelectorAll(".workspace-participant-name")].map(
      (person) => person.lastChild?.textContent,
    ),
  ).toEqual(["其他成员", "本人"]);
  expect(within(roster as HTMLElement).queryByRole("textbox")).toBeNull();
  expect(
    within(roster as HTMLElement).queryByRole("button", {
      name: /管理本人认领/,
    }),
  ).toBeNull();
  expect(screen.getByRole("textbox", { name: "翻译署名" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /管理本人认领/ })).toBeTruthy();
});

test("admin manages every member including self with explicit release confirmation and no reassignment", async () => {
  const work = fixture();
  work.images.push({ ...work.images[0], id: "free", orderIndex: 2 });
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: work,
    response: new Response(null, { status: 200 }),
  } as never);
  await show(work, {
    ...user,
    permissions: [...user.permissions, "works:admin"],
  });
  fireEvent.click(screen.getByRole("button", { name: /^翻译 · 查看/ }));
  fireEvent.click(screen.getByRole("button", { name: "管理页认领" }));
  const dialog = screen.getByRole("dialog", { name: "管理页认领" });
  const selector = within(dialog).getByRole("combobox", { name: "管理成员" });
  fireEvent.click(selector);
  expect(
    within(dialog)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["本人", "其他成员"]);
  expect(
    within(dialog).queryByRole("checkbox", { name: "选择第 3 页" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("option", { name: "其他成员" }));
  await waitFor(() =>
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "选择第 2 页",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true),
  );
  expect(
    within(dialog).queryByRole("checkbox", { name: "选择第 1 页" }),
  ).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "选择第 2 页" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "保存认领" }));
  const confirmation = await screen.findByRole("dialog", {
    name: "取消这些页的认领？",
  });
  expect(confirmation.textContent).toContain("第 2 页");
  expect(confirmation.textContent).toContain("清空这些页的当前翻译内容和提交");
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "清空并取消认领" }),
  );
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/works/{id}/stages/assignments",
      expect.objectContaining({
        body: expect.objectContaining({
          participantId: "other-participant",
          imageIds: [],
          impactImageIds: ["two"],
          confirmClearDraft: true,
        }),
      }),
    ),
  );
});

test("admin can inspect submitted members without exposing release controls", async () => {
  const work = fixture();
  work.participants[1].submittedAt = "2026-11-20T01:00:00Z";
  await show(work, {
    ...user,
    permissions: [...user.permissions, "works:admin"],
  });
  fireEvent.click(screen.getByRole("button", { name: "翻译 · 查看分工" }));
  fireEvent.click(screen.getByRole("button", { name: "管理页认领" }));
  const dialog = screen.getByRole("dialog", { name: "管理页认领" });
  fireEvent.click(within(dialog).getByRole("combobox", { name: "管理成员" }));
  fireEvent.click(within(dialog).getByRole("option", { name: "其他成员" }));
  expect(within(dialog).getByText("其他成员 · 已提交")).toBeTruthy();
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "保存认领" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "取消接取" })).toBeNull();
});

test("admin preserves a member's submitted pages while releasing their unsubmitted pages", async () => {
  const work = fixture();
  work.participants[1].assignedImageIds.push("one");
  work.participants[0].assignedImageIds = [];
  work.pageAssignments = work.images.map((image, index) => ({
    workImageId: image.id,
    stage: "translate",
    participantId: "other-participant",
    userId: "other",
    submittedAt: index === 0 ? "2026-11-20T01:00:00Z" : null,
  })) as Work["pageAssignments"];
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: work,
    response: new Response(null, { status: 200 }),
  } as never);
  await show(work, {
    ...user,
    permissions: [...user.permissions, "works:admin"],
  });
  fireEvent.click(screen.getByRole("button", { name: "翻译 · 查看分工" }));
  fireEvent.click(screen.getByRole("button", { name: "管理页认领" }));
  const dialog = screen.getByRole("dialog", { name: "管理页认领" });
  fireEvent.click(within(dialog).getByRole("combobox", { name: "管理成员" }));
  fireEvent.click(within(dialog).getByRole("option", { name: "其他成员" }));
  expect(
    within(dialog).queryByRole("checkbox", { name: "选择第 1 页" }),
  ).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "选择第 2 页" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "保存认领" }));
  const confirmation = await screen.findByRole("dialog", {
    name: "取消这些页的认领？",
  });
  expect(confirmation.textContent).toContain("第 2 页");
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "清空并取消认领" }),
  );
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/api/works/{id}/stages/assignments",
      expect.objectContaining({
        body: expect.objectContaining({
          participantId: "other-participant",
          imageIds: ["one"],
          impactImageIds: ["two"],
        }),
      }),
    ),
  );
});

test("lets a member manage previously claimed typesetting pages during translation", async () => {
  await show({ ...fixture("typeset"), workflowStatus: "translating" });
  fireEvent.click(screen.getByRole("button", { name: "嵌字 · 查看分工" }));
  fireEvent.click(screen.getByRole("button", { name: /管理本人认领/ }));
  const dialog = screen.getByRole("dialog", { name: "管理本人认领" });
  expect(
    within(dialog).getByRole("checkbox", { name: "选择第 1 页" }),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "取消接取" })).toBeTruthy();
});
