import { beforeAll, afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { components } from "@comiku/api-client";
import { PageClaimControl } from "./PageClaimControl";
import { client } from "../account/api";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
vi.mock("./use-work-image-url", () => ({
  useWorkImageUrl: () => ({
    data: { url: "https://example.test/sample.png" },
    isPending: false,
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const work = {
  id: "work",
  revision: 3,
  images: [{ id: "one" }, { id: "two" }, { id: "three" }],
  participants: [],
  pageAssignments: [
    {
      workImageId: "two",
      stage: "translate",
      userId: "other",
      participantId: "other-member",
    },
    {
      workImageId: "three",
      stage: "translate",
      userId: null,
      participantId: null,
      generation: 2,
    },
  ],
} as unknown as components["schemas"]["WorkDetailDto"];

test("claims only selected free pages in one request and requires at least one page", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: work,
    response: new Response(null, { status: 200 }),
  } as never);
  const updated = vi.fn();
  render(
    <PageClaimControl
      work={work}
      stage="translate"
      canClaim
      onUpdated={updated}
    />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText("剩余 2 页未分配")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "翻译 · 查看并认领" }));
  expect(
    screen.getByRole("button", { name: "认领 0 页" }).hasAttribute("disabled"),
  ).toBe(true);
  const pages = screen.getAllByRole("checkbox");
  expect(pages).toHaveLength(2);
  fireEvent.click(pages[1]);
  fireEvent.click(screen.getByRole("button", { name: "认领 1 页" }));
  await waitFor(() => expect(updated).toHaveBeenCalledWith(work));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(
    "/api/works/{id}/stages/claim",
    expect.objectContaining({
      body: expect.objectContaining({
        imageIds: ["three"],
        expectedRevision: 3,
      }),
    }),
  );
});

test("retains the full selection after an atomic claim conflict", async () => {
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    error: { message: "第 3 页已被认领" },
    response: new Response(null, { status: 409 }),
  } as never);
  render(
    <PageClaimControl
      work={work}
      stage="translate"
      canClaim
      onUpdated={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "翻译 · 查看并认领" }));
  fireEvent.click(screen.getByRole("button", { name: "全选空闲页" }));
  fireEvent.click(screen.getByRole("button", { name: "认领 2 页" }));
  await screen.findByRole("alert");
  expect(screen.getByText("第 3 页已被认领")).toBeTruthy();
  expect(
    screen
      .getAllByRole("checkbox")
      .every((box) => (box as HTMLInputElement).checked),
  ).toBe(true);
  expect(post).toHaveBeenCalledTimes(1);
});

test("viewers can inspect every page and open its original without claiming", () => {
  render(
    <PageClaimControl
      canClaim={false}
      work={work}
      stage="translate"
      onUpdated={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "翻译 · 查看分工" }));
  expect(
    screen.getAllByRole("button", { name: /放大第 .* 页原图/ }),
  ).toHaveLength(3);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "放大第 2 页原图" }));
  expect(screen.getByRole("dialog", { name: /第 2 页原图/ })).toBeTruthy();
});

test.each(["translate", "typeset"] as const)(
  "%s shows submitted progress after all original pages are assigned and restores availability after release",
  (stage) => {
    const assigned = {
      ...work,
      pageAssignments: work.images.map((image, index) => ({
        workImageId: image.id,
        stage,
        userId: "other",
        participantId: "other-member",
        submittedAt: index === 0 ? "2026-11-20T00:00:00Z" : null,
      })),
    } as unknown as components["schemas"]["WorkDetailDto"];
    const props = { stage, canClaim: false, onUpdated: vi.fn() };
    const view = render(<PageClaimControl {...props} work={assigned} />);
    expect(screen.getByText("已提交 1 / 3 页")).toBeTruthy();
    expect(screen.queryByText("剩余 0 页未分配")).toBeNull();
    view.rerender(
      <PageClaimControl
        {...props}
        work={{
          ...assigned,
          pageAssignments: assigned.pageAssignments.map((page, index) =>
            index === 1 ? { ...page, participantId: null, userId: null } : page,
          ),
        }}
      />,
    );
    expect(screen.getByText("剩余 1 页未分配")).toBeTruthy();
    expect(screen.queryByText("已提交 1 / 3 页")).toBeNull();
    view.rerender(
      <PageClaimControl
        {...props}
        work={{ ...assigned, images: [], pageAssignments: [] }}
      />,
    );
    expect(screen.getByText("剩余 0 页未分配")).toBeTruthy();
  },
);
