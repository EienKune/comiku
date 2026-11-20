import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SingleTypesetArchiveImport } from "./SingleTypesetArchiveImport";
vi.mock("./typeset-batch-api", () => ({
  refreshTypesetWork: vi.fn(async () => undefined),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
test("single ZIP accepts free image count and explicit preview ordering, then saves without submission", async () => {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url.endsWith("/preview"))
        return Response.json({
          sessionId: "session",
          expectedRevision: 5,
          images: [
            { id: "a", sourceName: "a.png", suggestedWorkImageId: null },
            { id: "b", sourceName: "b.png", suggestedWorkImageId: null },
          ],
        });
      if (url.endsWith("/apply")) {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ revision: 6, versionId: "version" });
      }
      return Response.json({ url: "/fixture.png" });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SingleTypesetArchiveImport
        workId="work"
        revision={5}
        images={[{ id: "p1", orderIndex: 0 }]}
      />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("导入单作品成图 ZIP"), {
    target: {
      files: [new File(["zip"], "1_成图.zip", { type: "application/zip" })],
    },
  });
  await screen.findByText("2 · b.png");
  fireEvent.click(screen.getAllByRole("button", { name: "前移" })[1]);
  fireEvent.click(screen.getByRole("button", { name: "保存整份成图版本" }));
  await waitFor(() => expect(bodies.length).toBe(1));
  expect((bodies[0] as { mappings: unknown[] }).mappings).toEqual([
    { imageId: "b", workImageId: null, position: "free" },
    { imageId: "a", workImageId: null, position: "free" },
  ]);
  expect(urls.some((url) => url.includes("/stages/submit"))).toBe(false);
});
