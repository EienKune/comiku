import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { client } from "../account/api";
import { SourceFetchHistory } from "./SourceFetchHistory";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("management history loads on entry and preserves retry and recovered account information", async () => {
  const get = vi.spyOn(client, "GET").mockResolvedValue({
    data: [
      {
        id: "run",
        trigger: "scheduled",
        status: "succeeded",
        attempts: 2,
        jobStatus: "succeeded",
        nextRetryAt: null,
        startedAt: "2026-10-26T12:00:00Z",
        completedAt: "2026-10-26T12:01:00Z",
        items: [
          {
            id: "item",
            authorName: "Fixture author",
            platform: "pixiv",
            adapterKey: "pixiv_gallery_dl",
            status: "succeeded",
            pagesFetched: 3,
            candidatesCreated: 1,
            candidatesExisting: 2,
            mediaStored: 4,
            errorCode: "interrupted",
            errorMessage: "进程中断，已从持久游标恢复",
          },
        ],
      },
    ],
    response: new Response(),
  } as never);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SourceFetchHistory />
    </QueryClientProvider>,
  );
  expect(get).toHaveBeenCalledWith("/api/source-fetch/runs");
  fireEvent.click(await screen.findByRole("button", { name: /查看批次详情/ }));
  expect(await screen.findByText("重试 1 次")).toBeTruthy();
  expect(screen.getByText(/Fixture author/)).toBeTruthy();
  expect(screen.getByText(/进程中断/)).toBeTruthy();
});
