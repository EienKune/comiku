import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { uploadTypesetFiles } from "./typeset-upload-transfer";
import { TypesetCollaborationPanel } from "./TypesetCollaborationPanel";
vi.mock("./typeset-upload-transfer", () => ({ uploadTypesetFiles: vi.fn() }));
beforeEach(() => {
  vi.mocked(uploadTypesetFiles).mockResolvedValue({
    id: "session",
    status: "previewed",
  } as never);
});
vi.mock("./typeset-batch-api", () => ({
  refreshTypesetWork: vi.fn(async () => undefined),
}));
const state = {
  revision: 5,
  editorEpoch: 2,
  workflowStatus: "typesetting",
  handoffReady: true,
  participants: [
    { id: "pa", userId: "a", user: { displayName: "甲" } },
    { id: "pb", userId: "b", user: { displayName: "乙" } },
  ],
  pages: [
    { id: "p1", orderIndex: 0, assignment: { participantId: "pa" } },
    { id: "p2", orderIndex: 1, assignment: { participantId: "pa" } },
    { id: "p3", orderIndex: 2, assignment: { participantId: "pb" } },
  ],
  drafts: [
    {
      id: "d1",
      workImageId: "p1",
      participantId: "pa",
      position: "page",
      sourceName: "1.png",
      revision: 1,
      submittedRevision: null,
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function mount(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return render(
    <QueryClientProvider client={client}>
      <TypesetCollaborationPanel workId="work" actorId="a" workRevision={5} />
    </QueryClientProvider>,
  );
}

test("previews current-work files, ignores other owners and saves only explicit own mappings without submitting", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/preview-session"))
        return Response.json({
          sessionId: "session",
          expectedRevision: 5,
          images: [
            { id: "i2", sourceName: "10-002.png", suggestedWorkImageId: "p2" },
            { id: "i3", sourceName: "10-003.png", suggestedWorkImageId: "p3" },
          ],
        });
      if (url.endsWith("/apply")) return Response.json({ revision: 6 });
      if (url.includes("/url")) return Response.json({ url: "/fixture.png" });
      return Response.json(state);
    }),
  );
  mount();
  expect(await screen.findByText("本人缺页：2")).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "提交本人全部成图",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("上传成图或 ZIP"), {
    target: {
      files: [new File(["zip"], "10_成图.zip", { type: "application/zip" })],
    },
  });
  expect(
    await screen.findByRole("heading", { name: "确认保存映射" }),
  ).toBeTruthy();
  expect(screen.getByText("该文件将被忽略，不覆盖他人页")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存本批草稿" }));
  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith("/apply"))).toBe(true),
  );
  expect(calls.some((c) => c.url.endsWith("/preview"))).toBe(false);
  const binding = calls.find((c) => c.url.endsWith("/preview-session"))!;
  expect(JSON.parse(String(binding.init?.body))).toMatchObject({
    sessionId: "session",
    expectedRevision: 5,
  });
  const apply = calls.find((c) => c.url.endsWith("/apply"))!;
  expect(JSON.parse(String(apply.init?.body)).mappings).toEqual([
    { imageId: "i2", workImageId: "p2", position: "page" },
  ]);
  expect(new Headers(apply.init?.headers).get("X-Comiku-Request")).toBe("1");
  expect(calls.some((c) => c.url.includes("/stages/submit"))).toBe(false);
});

test("published output remains viewable with no upload or self-submission mutations", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.includes("/url")
          ? { url: "/fixture.png" }
          : { ...state, workflowStatus: "published" },
      ),
    ),
  );
  mount();
  await screen.findByText("本人缺页：2");
  expect(screen.queryByLabelText("上传成图或 ZIP")).toBeNull();
  expect(screen.queryByRole("button", { name: "提交本人全部成图" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "第 1 页成图" }));
  expect(
    await screen.findByRole("region", { name: "原图成图对比" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("替换当前成图")).toBeNull();
});

test("keeps the own-page upload entry discoverable before handoff starts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.includes("/url")
          ? { url: "/fixture.png" }
          : {
              ...state,
              workflowStatus: "pending_typeset",
              handoffReady: false,
            },
      ),
    ),
  );
  mount();
  const picker = await screen.findByLabelText("上传成图或 ZIP");
  expect((picker as HTMLInputElement).disabled).toBe(true);
  expect(
    screen.getByText("先下载交接包并开始嵌字，再上传本人认领页的成图。"),
  ).toBeTruthy();
  expect(screen.getByText("本人认领：第 1、2 页")).toBeTruthy();
});

test("shows failed uploads next to the picker and retries the same files before mapping", async () => {
  vi.mocked(uploadTypesetFiles).mockRejectedValueOnce(
    new Error("21-002.png：上传失败（HTTP 502）"),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/preview-session")
          ? {
              sessionId: "session",
              expectedRevision: 5,
              images: [
                {
                  id: "i2",
                  sourceName: "21-002.png",
                  suggestedWorkImageId: "p2",
                },
              ],
            }
          : url.includes("/url")
            ? { url: "/fixture.png" }
            : state,
      ),
    ),
  );
  mount();
  const input = await screen.findByLabelText("上传成图或 ZIP");
  const files = [new File(["png"], "21-002.png", { type: "image/png" })];
  fireEvent.change(input, { target: { files } });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("HTTP 502");
  const firstPage = screen.getByRole("button", { name: "第 1 页成图" });
  expect(
    alert.compareDocumentPosition(firstPage) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试上传" }));
  await screen.findByRole("heading", { name: "确认保存映射" });
  expect(vi.mocked(uploadTypesetFiles).mock.calls[1][0][0]).toBe(files[0]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("observes cached thumbnails too so a stale signed URL refreshes on remount", async () => {
  const callbacks: IntersectionObserverCallback[] = [];
  const targets: Element[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe(target: Element) {
        targets.push(target);
      }
      disconnect() {}
    },
  );
  const fetcher = vi.fn(async (url: string) =>
    Response.json(url.includes("/url") ? { url: "/fresh.png" } : state),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    [
      "typeset-collaboration-image",
      "/api/works/work/typeset/collaboration/drafts/d1/url?variant=thumbnail",
      1,
    ],
    { url: "/expired.png" },
    { updatedAt: Date.now() - 180000 },
  );
  mount(client);
  const image = await screen.findByRole("img", { name: "第 1 页成图" });
  expect(image.getAttribute("src")).toBe("/expired.png");
  await waitFor(() => expect(targets).toContain(image));
  act(() => {
    for (const callback of callbacks)
      callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
  });
  await waitFor(() => expect(image.getAttribute("src")).toBe("/fresh.png"));
  expect(
    fetcher.mock.calls.some(([url]) => url.includes("/drafts/d1/url")),
  ).toBe(true);
});
