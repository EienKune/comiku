import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { components, CurrentUser } from "@comiku/api-client";
import { client, queryClient } from "../account/api";
import { WorkDetailPage } from "./BusinessPages";
import { downloadPrepared } from "./transfers-api";

vi.mock("./transfers-api", async (original) => ({
  ...(await original<typeof import("./transfers-api")>()),
  downloadPrepared: vi.fn(),
}));
vi.mock("./TypesetCollaborationPanel", () => ({
  TypesetCollaborationPanel: () => <section aria-label="成图协作" />,
}));
const actor = {
  id: "self",
  username: "member",
  displayName: "本人",
  roles: ["translator", "typesetter"],
  permissions: ["works:read", "works:translate", "works:typeset"],
  languageCapabilities: ["ja"],
  isActive: true,
  mustChangePassword: false,
  revision: 0,
  canSkipProofreading: false,
} as CurrentUser;
type Work = components["schemas"]["WorkDetailDto"];
function fixture(joined: boolean): Work {
  return {
    id: "work",
    workNumber: 16,
    authorId: "author",
    authorName: "作者",
    title: "嵌字入口测试",
    sourcePostUrl: null,
    sourceText: null,
    sourceLanguage: "ja",
    collaborationMode: "multi",
    workflowStatus: "pending_typeset",
    reviewStatus: "normal",
    priority: 0,
    revision: 3,
    editorEpoch: 1,
    typesetHandoffStartedAt: null,
    translationAttentionStage: null,
    translationAttentionVersionNumber: null,
    imageCount: 1,
    coverImageId: null,
    participantCount: 1,
    assignedStages: [joined ? "typeset" : "translate"],
    importedAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    publishedAt: null,
    images: [
      {
        id: "page",
        orderIndex: 0,
        fileName: "page.png",
        width: 100,
        height: 100,
      },
    ],
    participants: [
      {
        id: "participant",
        userId: actor.id,
        displayName: actor.displayName,
        stage: joined ? "typeset" : "translate",
        participationMode: "owner",
        workCreditName: null,
        creditNameSnapshot: null,
        joinedAt: "2026-11-20T00:00:00Z",
        submittedAt: joined ? null : "2026-11-20T01:00:00Z",
        leftAt: null,
        assignedImageIds: ["page"],
        contributionSubmittedAt: null,
        contributionCurrent: false,
      },
    ],
    events: [],
    openReviewCaseId: null,
  } as unknown as Work;
}
async function show(read: () => Work) {
  vi.spyOn(client, "GET").mockImplementation(
    async () => ({ data: read(), response: new Response() }) as never,
  );
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
  await screen.findByText("嵌字入口测试");
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  queryClient.clear();
});

test("an inspection download before claiming stays an inspection and explains the next step", async () => {
  await show(() => fixture(false));
  expect(
    screen.getByRole("link", { name: "进入翻译工作区" }).getAttribute("href"),
  ).toBe("/works/work/editor");
  expect(screen.queryByRole("link", { name: "查看成图" })).toBeNull();
  expect(
    screen.getByText(
      "检查下载不会开始嵌字。请先在任务组协调中认领嵌字页，再下载交接包并开始。",
    ),
  ).toBeTruthy();
  expect(downloadPrepared).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "下载嵌字交接包" }));
  await waitFor(() =>
    expect(downloadPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ requireCurrentParticipation: false }),
    ),
  );
});

test("an interrupted current-member handoff reconciles the committed start and offers upload next", async () => {
  let work = fixture(true);
  vi.mocked(downloadPrepared).mockImplementationOnce(async () => {
    work = {
      ...work,
      revision: 4,
      editorEpoch: 2,
      workflowStatus: "typesetting",
      typesetHandoffStartedAt: "2026-11-21T01:00:00Z",
    };
    throw new Error("下载响应中断");
  });
  await show(() => work);
  expect(screen.queryByRole("link", { name: "上传与提交成图" })).toBeNull();
  const handoff = screen
    .getByRole("heading", { name: "嵌字交接材料" })
    .closest("section");
  expect(handoff?.nextElementSibling).toBe(
    screen.getByRole("region", { name: "成图协作" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "下载交接包并开始嵌字" }));
  expect(
    await screen.findByRole("button", { name: "重新下载嵌字交接包" }),
  ).toBeTruthy();
  expect(downloadPrepared).toHaveBeenCalledWith(
    expect.objectContaining({
      requireCurrentParticipation: true,
      expectedRevision: 3,
    }),
  );
  expect(queryClient.getQueryData(["work", "work"])).toMatchObject({
    revision: 4,
    workflowStatus: "typesetting",
  });
});
