import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { CandidateCard } from "./CandidateCard";

vi.mock("./CandidateMediaPreview", () => ({
  CandidateMediaPreview: () => <div />,
}));
afterEach(cleanup);

const fixture = {
  id: "post",
  status: "pending",
  hashtags: [],
  tagRuleMatches: [],
  classificationTags: [{ label: "comic", text: "Comic", tone: "success" }],
  canRetryAnalysis: true,
  media: [{ id: "page-one" }, { id: "page-two" }],
  externalPostUrl: "https://example.test/post",
  triageReasons: [],
} as unknown as components["schemas"]["CandidateDto"];

function mount(candidate = fixture) {
  const toggle = vi.fn(),
    retry = vi.fn(),
    order = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CandidateCard
        candidate={candidate}
        statusLabel="Status"
        author={<h2>Artist</h2>}
        description={<p>Description</p>}
        canManage
        selected={false}
        selectionDisabled={false}
        onToggle={toggle}
        onRetryAnalysis={retry}
        onToggleOrdering={order}
      />
    </QueryClientProvider>,
  );
  return { toggle, retry, order };
}

test("partial analysis keeps a successful category and retry, independent of image ordering", () => {
  const { toggle, retry, order } = mount();
  expect(screen.getByRole("button", { name: "Comic" })).toBeTruthy();
  const retryButton = screen.getByRole("button", { name: "重试识别" });
  expect(retryButton.title).toContain("已成功的结果会保留");
  fireEvent.click(retryButton);
  fireEvent.click(screen.getByRole("button", { name: "图片顺序" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "选择" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(order).toHaveBeenCalledOnce();
  expect(toggle).toHaveBeenCalledOnce();
  expect(
    document
      .querySelector(".candidate-card-footer")
      ?.lastElementChild?.contains(screen.getByRole("link", { name: "原帖" })),
  ).toBe(true);
});

test("imported cards do not offer selection or page ordering", () => {
  mount({ ...fixture, status: "imported" });
  expect(screen.queryByRole("checkbox", { name: "选择" })).toBeNull();
  expect(screen.queryByRole("button", { name: "图片顺序" })).toBeNull();
  expect(screen.getByRole("link", { name: "原帖" })).toBeTruthy();
});
