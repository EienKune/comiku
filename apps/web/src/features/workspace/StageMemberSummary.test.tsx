import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { components } from "@comiku/api-client";
import { StageMemberSummary } from "./StageMemberSummary";
import { stageSummaryMembers } from "./stage-members";

type Work = components["schemas"]["WorkDetailDto"];
type Participant = Work["participants"][number];
afterEach(cleanup);

function person(id: string, overrides: Partial<Participant> = {}): Participant {
  return {
    id: `p-${id}`,
    userId: id,
    displayName: `成员${id}`,
    stage: "translate",
    participationMode: "collaborator",
    workCreditName: null,
    creditNameSnapshot: null,
    joinedAt: new Date(
      Date.parse("2026-11-20T00:00:00Z") + Number(id) * 1000,
    ).toISOString(),
    submittedAt: null,
    leftAt: null,
    assignedImageIds: [],
    contributionSubmittedAt: null,
    contributionCurrent: false,
    ...overrides,
  };
}
function work(
  participants: Participant[],
  pageAssignments: Work["pageAssignments"] = [],
): Work {
  return {
    id: "work",
    participants,
    pageAssignments,
    images: [],
  } as unknown as Work;
}

test("keeps joining order, retained submissions and distinct users with the same nickname", () => {
  const first = person("1", {
    displayName: "同名",
    submittedAt: "2026-11-20T01:00:00Z",
  });
  const second = person("2", { displayName: "同名" });
  const latest = person("3", { userId: "2", displayName: "同名" });
  const data = work([
    latest,
    second,
    person("4", { leftAt: "2026-11-20T01:00:00Z" }),
    first,
  ]);
  expect(
    stageSummaryMembers(data, "translate").map((member) => member.id),
  ).toEqual([first.id, latest.id]);
  render(<StageMemberSummary work={data} stage="translate" />);
  const trigger = screen.getByRole("button", {
    name: "翻译参与成员，2 人，查看完整名单",
  });
  expect(within(trigger).getAllByText("同名")).toHaveLength(2);
  expect(screen.queryByRole("region")).toBeNull();
  fireEvent.click(trigger);
  const roster = screen.getByRole("region", { name: "翻译参与成员" });
  expect(within(roster).getAllByRole("listitem")).toHaveLength(2);
  expect(within(roster).getByText(/已完成/)).toBeTruthy();
});

test("summarizes a large team with avatars and a remainder and opens the entire scrollable roster", async () => {
  render(
    <StageMemberSummary
      work={work(Array.from({ length: 12 }, (_, i) => person(String(i + 1))))}
      stage="translate"
    />,
  );
  const trigger = screen.getByRole("button", { name: /翻译参与成员，12 人/ });
  expect(within(trigger).getAllByRole("img", { hidden: true })).toHaveLength(3);
  expect(within(trigger).getByText("+9")).toBeTruthy();
  expect(within(trigger).queryByText("12 人")).toBeNull();
  expect(within(trigger).queryByText("成员1")).toBeNull();
  fireEvent.pointerEnter(trigger.parentElement!, { pointerType: "mouse" });
  const roster = screen.getByRole("region", { name: "翻译参与成员" });
  expect(within(roster).getAllByRole("listitem")).toHaveLength(12);
  expect(roster.tabIndex).toBe(0);
  fireEvent.pointerLeave(trigger.parentElement!, { pointerType: "mouse" });
  await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
});

test("supports keyboard opening, Escape, touch activation and outside dismissal", () => {
  render(<StageMemberSummary work={work([person("1")])} stage="translate" />);
  const trigger = screen.getByRole("button", { name: /翻译参与成员/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  const touchEnter = new Event("pointerover", { bubbles: true });
  Object.defineProperty(touchEnter, "pointerType", { value: "touch" });
  fireEvent(trigger.parentElement!, touchEnter);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  expect(screen.getByRole("region")).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("region")).toBeNull();
});

test("keeps a hovered roster open across its gap and while the keyboard scroll area has focus", () => {
  vi.useFakeTimers();
  try {
    render(<StageMemberSummary work={work([person("1")])} stage="translate" />);
    const trigger = screen.getByRole("button", { name: /翻译参与成员/ });
    const root = trigger.parentElement!;
    fireEvent.pointerEnter(root, { pointerType: "mouse" });
    fireEvent.pointerLeave(root, { pointerType: "mouse" });
    fireEvent.pointerEnter(root, { pointerType: "mouse" });
    vi.advanceTimersByTime(150);
    const roster = screen.getByRole("region");
    fireEvent.focus(roster);
    fireEvent.pointerLeave(root, { pointerType: "mouse" });
    vi.advanceTimersByTime(150);
    expect(screen.getByRole("region")).toBe(roster);
    fireEvent.keyDown(roster, { key: "Escape" });
    expect(screen.queryByRole("region")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("shows the current work credit after submission and defaults to the nickname when cleared", () => {
  render(
    <StageMemberSummary
      work={work([
        person("1", {
          workCreditName: "新名字",
          creditNameSnapshot: "旧名字",
          submittedAt: "2026-11-20T00:00:00Z",
        }),
        person("2", {
          workCreditName: null,
          creditNameSnapshot: "旧名字",
          submittedAt: "2026-11-20T00:00:00Z",
        }),
      ])}
      stage="translate"
    />,
  );
  const trigger = screen.getByRole("button", { name: /翻译参与成员/ });
  expect(within(trigger).getByText("成员1")).toBeTruthy();
  expect(screen.queryByText("署名：新名字")).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByText("署名：新名字")).toBeTruthy();
  expect(screen.getByText("署名：成员2")).toBeTruthy();
  expect(screen.queryByText(/旧名字/)).toBeNull();
});

test("uses the released credit list when a member later changes nickname", () => {
  const data = work([person("1", { displayName: "新昵称" })]);
  data.workflowStatus = "published";
  data.publishedCredits = {
    translate: ["发布用名"],
    proofread: [],
    typeset: [],
  };
  render(<StageMemberSummary work={data} stage="translate" />);
  fireEvent.click(screen.getByRole("button", { name: /翻译参与成员/ }));
  expect(screen.getByText("署名：发布用名")).toBeTruthy();
  expect(screen.queryByText("署名：新昵称")).toBeNull();
});

test("does not show an empty stage when authoritative assignments retain an owner", () => {
  const assignments = [
    {
      participantId: "p-1",
      userId: "1",
      workImageId: "image",
      stage: "translate",
    },
  ] as Work["pageAssignments"];
  const data = work(
    [person("1", { leftAt: "2026-11-20T01:00:00Z" })],
    assignments,
  );
  render(<StageMemberSummary work={data} stage="translate" />);
  expect(
    screen.getByRole("button", { name: /翻译参与成员，1 人/ }),
  ).toBeTruthy();
  expect(screen.queryByText("暂无成员认领")).toBeNull();
  cleanup();
  render(<StageMemberSummary work={work([], assignments)} stage="translate" />);
  fireEvent.click(screen.getByRole("button", { name: /翻译参与成员，1 人/ }));
  expect(screen.getByText(/成员资料暂不可用/)).toBeTruthy();
});

test("ignores released assignments and scopes empty text and members to the selected responsibility", () => {
  const data = work([person("1")], [
    {
      participantId: null,
      userId: null,
      workImageId: "image",
      stage: "typeset",
    },
  ] as Work["pageAssignments"]);
  render(<StageMemberSummary work={data} stage="typeset" />);
  expect(screen.getByText("暂无成员认领")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  render(
    <StageMemberSummary work={data} stage="proofread" emptyText="已跳过校对" />,
  );
  expect(screen.getByText("已跳过校对")).toBeTruthy();
});
