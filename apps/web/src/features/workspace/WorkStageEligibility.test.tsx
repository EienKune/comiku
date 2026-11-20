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

test.each(["single", "multi"] as const)(
  "%s translation participation follows the correct first-proofreader claim rule",
  async (mode) => {
    const work = fixture("translate", mode);
    work.workflowStatus = "pending_proofread";
    work.participants = [work.participants[0]];
    work.participants[0].submittedAt = "2026-11-20T01:00:00Z";
    const post = vi.spyOn(client, "POST").mockResolvedValue({
      data: work,
      response: new Response(null, { status: 200 }),
    } as never);
    await show(work);
    const proofreadRow = [
      ...document.querySelectorAll(".workspace-stage-row"),
    ].find(
      (row) =>
        row.querySelector(".workspace-stage-label strong")?.textContent ===
        "校对",
    ) as HTMLElement;
    if (mode === "single") {
      expect(
        within(proofreadRow).queryByRole("button", { name: "认领" }),
      ).toBeNull();
    } else {
      fireEvent.click(
        within(proofreadRow).getByRole("button", { name: "加入校对" }),
      );
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          "/api/works/{id}/stages/claim",
          expect.objectContaining({
            body: expect.objectContaining({ stage: "proofread" }),
          }),
        ),
      );
    }
  },
);

test("an enrolled multi translator can claim remaining pages", async () => {
  const work = fixture();
  work.images.push({ ...work.images[0], id: "free", orderIndex: 2 });
  await show(work);
  expect(
    screen.getByRole("button", { name: "翻译 · 查看并认领" }),
  ).toBeTruthy();
});

test("an eligible member may join an existing proofreader but cannot add other members", async () => {
  const work = fixture("proofread");
  work.participants = [work.participants[1]];
  await show(work);
  const proofreadRow = [
    ...document.querySelectorAll(".workspace-stage-row"),
  ].find(
    (row) =>
      row.querySelector(".workspace-stage-label strong")?.textContent ===
      "校对",
  ) as HTMLElement;
  expect(
    within(proofreadRow).queryByRole("button", { name: "认领" }),
  ).toBeNull();
  expect(
    within(proofreadRow).getByRole("button", { name: "加入校对" }),
  ).toBeTruthy();
  expect(
    within(proofreadRow).queryByRole("button", { name: "添加校对" }),
  ).toBeNull();
});
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
