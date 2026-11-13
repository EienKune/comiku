import { useState } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { CandidateCompositionEditor } from "./CandidateCompositionEditor";
import { CandidateCompositionConfirmation } from "./CandidateCompositionConfirmation";
import {
  createCompositionDraft,
  type CompositionDraft,
} from "./candidate-composition-model";
import {
  emptyCandidateImportState,
  selectCandidateForImport,
  type ImportCandidate,
} from "./candidate-import-state";
vi.mock("./CandidateImportMedia", () => ({
  CandidateImportThumbnail: ({ mediaId }: { mediaId: string }) => (
    <span>{mediaId}</span>
  ),
}));
vi.mock("./CandidateCompositionPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./CandidateCompositionPreview")>()),
  CandidateCompositionPreview: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>关闭大图</button>
  ),
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
function initial(mode: "merge" | "split") {
  const state = (mode === "merge" ? ["a", "b", "c"] : ["a"]).reduce(
    (state, id) =>
      selectCandidateForImport(
        state,
        {
          id,
          authorId: "author",
          authorName: "作者",
          revision: 1,
          postedAt: "2026-01-01",
          status: "pending",
          media: [1, 2, 3].map((n) => ({ id: `${id}-${n}` })),
        } as ImportCandidate,
        id,
      ),
    emptyCandidateImportState(),
  );
  return createCompositionDraft(state, mode);
}
function Harness({ initialDraft }: { initialDraft: CompositionDraft }) {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <CandidateCompositionEditor
      draft={draft}
      onChange={setDraft}
      onReview={() => {}}
      onClose={() => {}}
    />
  );
}
test("split keeps all originals, creates targets from explicit selection, validates titles and returns removed group images to unassigned", () => {
  render(<Harness initialDraft={initial("split")} />);
  const dialog = screen.getByRole("dialog", { name: "拆分入库" });
  expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
  expect(
    (
      within(dialog).getByRole("button", {
        name: "创建 1 部作品",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "选择 来源帖 1 · 原图 2" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "新建作品" }));
  expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
  const titles = within(dialog).getAllByRole("textbox");
  fireEvent.change(titles[0], { target: { value: "第一作" } });
  fireEvent.change(titles[1], { target: { value: "第二作" } });
  expect(
    (
      within(dialog).getByRole("button", {
        name: "创建 2 部作品",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "移除作品 2，图片回未分配" }),
  );
  const unassigned = within(dialog).getByRole("region", { name: "未分配" });
  expect(within(unassigned).getByText("a-2")).toBeTruthy();
  expect(within(dialog).queryByText("关联系列")).toBeNull();
});
test("merge requires explicit zero-adoption exclusion and disables adopting excluded source images", () => {
  render(<Harness initialDraft={initial("merge")} />);
  const dialog = screen.getByRole("dialog", { name: "合并入库" });
  for (const n of [1, 2, 3])
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: `采用 来源帖 3 · 原图 ${n}`,
      }),
    );
  expect(
    (
      within(dialog).getByRole("button", {
        name: "合并为 1 部作品",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "移出本次合并并保留待处理" }),
  );
  expect(
    (
      within(dialog).getByRole("button", {
        name: "合并为 1 部作品",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (
      within(dialog).getByRole("checkbox", {
        name: "采用 来源帖 3 · 原图 1",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "重新加入此帖" }));
  expect(
    (
      within(dialog).getByRole("checkbox", {
        name: "采用 来源帖 3 · 原图 1",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});
test("one final confirmation shows unadopted thumbnails and all created work links", () => {
  const draft = initial("split");
  draft.groups = [
    { id: "one", title: "第一作", mediaIds: ["a-1"] },
    { id: "two", title: "第二作", mediaIds: ["a-2"] },
  ];
  const { rerender } = render(
    <CandidateCompositionConfirmation
      draft={draft}
      phase="review"
      onConfirm={() => {}}
      onLookup={() => {}}
      onEdit={() => {}}
      onClose={() => {}}
    />,
    { wrapper: MemoryRouter },
  );
  expect(
    screen.getByRole("button", { name: "预览未采用 来源帖 1 · 原图 3" }),
  ).toBeTruthy();
  expect(screen.getByText(/不再出现在待处理/)).toBeTruthy();
  rerender(
    <CandidateCompositionConfirmation
      draft={draft}
      phase="result"
      result={{
        idempotencyKey: "key",
        mode: "split",
        works: [
          {
            workId: "first",
            workNumber: 1,
            title: "第一作",
            imageCount: 1,
            sourceCandidateIds: ["a"],
          },
          {
            workId: "second",
            workNumber: 2,
            title: "第二作",
            imageCount: 1,
            sourceCandidateIds: ["a"],
          },
        ],
        candidates: [],
        unadoptedMediaIds: ["a-3"],
      }}
      onConfirm={() => {}}
      onLookup={() => {}}
      onEdit={() => {}}
      onClose={() => {}}
    />,
  );
  expect(
    screen.getByRole("link", { name: /第一作/ }).getAttribute("href"),
  ).toBe("/works/first");
  expect(
    screen.getByRole("link", { name: /第二作/ }).getAttribute("href"),
  ).toBe("/works/second");
});
