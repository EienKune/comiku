import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { client, queryClient } from "../account/api";
import { ReviewRequestActions } from "./ReviewRequestActions";

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ReviewRequestActions reviewId="review" workId="work" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const result = (data: object) =>
  ({ data, response: new Response(null, { status: 200 }) }) as never;

test("withdraw uses the fresh baseline, updates caches and removes its button once closed", async () => {
  let review = {
    canWithdraw: true,
    workRevision: 6,
    editorEpoch: 8,
    status: "open",
  };
  vi.spyOn(client, "GET").mockImplementation(async () => result(review));
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    review = {
      ...review,
      canWithdraw: false,
      workRevision: 7,
      editorEpoch: 9,
      status: "resolved",
    };
    return result(review);
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  queryClient.setQueryData(["work", "work"], { revision: 6 });
  queryClient.setQueryData(["works", "read"], { items: [] });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "撤销审核请求" }));
  await screen.findByText("审核请求已撤销，已恢复原制作进度");
  expect(post).toHaveBeenCalledWith(
    "/api/reviews/{id}/withdraw",
    expect.objectContaining({
      body: expect.objectContaining({
        expectedRevision: 6,
        expectedEditorEpoch: 8,
      }),
    }),
  );
  expect(screen.queryByRole("button", { name: "撤销审核请求" })).toBeNull();
  expect(queryClient.getQueryState(["work", "work"])?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(["works", "read"])?.isInvalidated).toBe(
    true,
  );
});
test("a completed concurrent decision refreshes the result after a withdrawal conflict", async () => {
  let allowed = true;
  vi.spyOn(client, "GET").mockImplementation(async () =>
    result({ canWithdraw: allowed, workRevision: 6, editorEpoch: 8 }),
  );
  vi.spyOn(client, "POST").mockImplementation(async () => {
    allowed = false;
    return {
      error: { message: "审核事项已处理" },
      response: new Response(null, { status: 409 }),
    } as never;
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "撤销审核请求" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "审核事项已处理",
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "撤销审核请求" })).toBeNull(),
  );
});
test("non-applicants see the context link but cannot withdraw", async () => {
  vi.spyOn(client, "GET").mockResolvedValue(result({ canWithdraw: false }));
  mount();
  expect(
    await screen.findByRole("link", { name: "查看内容审核" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(queryClient.getQueryData(["review", "review"])).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "撤销审核请求" })).toBeNull();
});
