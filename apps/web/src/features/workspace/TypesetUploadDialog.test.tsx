import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client, queryClient } from "../account/api";
import { TypesetUploadDialog } from "./TypesetUploadDialog";
import { createComikuClient } from "@comiku/api-client";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  queryClient.clear();
});

test("the real API client serializes extraction as a JSON write with the request marker", async () => {
  const api = createComikuClient("http://localhost:5173");
  const fetch = vi.fn(async (request: Request) => {
    expect(request.url).toBe(
      "http://localhost:5173/api/typeset/upload-sessions/session/extract",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("X-Comiku-Request")).toBe("1");
    expect(request.credentials).toBe("include");
    expect(await request.json()).toEqual({});
    return new Response(JSON.stringify({ id: "session" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const result = await api.POST("/api/typeset/upload-sessions/{id}/extract", {
    params: { path: { id: "session" } },
    body: {},
    fetch,
  });
  expect(result.response.ok).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

test.each([true, false])(
  "restored upload requires image confirmation and retries the same frozen plan (stageSubmitted=%s)",
  async (stageSubmitted) => {
    localStorage.setItem("comiku:typeset-upload-session:user", "session");
    const session = {
      id: "session",
      status: "previewed",
      expiresAt: "2030-01-01T00:00:00Z",
      maxWorks: 20,
      maxTotalBytes: 512 * 1024 * 1024,
      files: [
        {
          id: "zip",
          sourceName: "139.zip",
          archive: true,
          status: "processed",
          error: null,
          upload: null,
          images: [10, 2].map((page) => ({
            id: `image${page}`,
            uploadFileId: "zip",
            sourceName: `139-${page}成图.png`,
            width: 100,
            height: 100,
            size: 20,
            workNumber: 139,
            pageNumber: page,
            warnings: [],
          })),
        },
      ],
    };
    vi.spyOn(client, "GET").mockImplementation(
      async (path: string) =>
        ({
          data: path.includes("handoff-manifest")
            ? {
                items: [
                  {
                    workId: "work",
                    workNumber: 139,
                    title: null,
                    canDownload: true,
                  },
                ],
              }
            : path.endsWith("/url")
              ? {
                  url: "https://example.invalid/fixture.png",
                  expiresInSeconds: 300,
                }
              : session,
          response: new Response(),
        }) as never,
    );
    let attempts = 0;
    const post = vi.fn(async (path: string, input?: unknown) => {
      void input;
      if (path.endsWith("/extract"))
        return { data: session, response: new Response() } as never;
      if (path.endsWith("/plans"))
        return {
          data: {
            items: [
              {
                workNumber: 139,
                workId: "work",
                title: null,
                previewId: "frozen-preview",
                workRevision: 4,
                editorEpoch: 2,
                handoffStartedAt: "2026-10-02T00:00:00Z",
                imageCount: 2,
                error: null,
              },
            ],
          },
          response: new Response(),
        } as never;
      attempts++;
      return attempts === 1
        ? ({
            error: { message: "作品或交接基线已变化" },
            response: new Response(null, { status: 409 }),
          } as never)
        : ({
            data: { workId: "work", versionId: "version", stageSubmitted },
            response: new Response(),
          } as never);
    });
    vi.spyOn(client, "POST").mockImplementation(post as never);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <Routes>
            <Route element={<Outlet context={{ id: "user" }} />}>
              <Route
                path="/"
                element={
                  <TypesetUploadDialog
                    open
                    onClose={vi.fn()}
                    onHandoff={vi.fn()}
                    onStatus={vi.fn()}
                  />
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复上次会话" }));
    await screen.findByText("139-2成图.png");
    expect(
      post.mock.calls.find(([path]) => path.endsWith("/extract"))?.[1],
    ).toMatchObject({ body: {} });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "已预览核对，所选图片为成图（包含说明页）",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查提交条件" }));
    await screen.findByText("检查通过：2 张，可上传并提交嵌字");
    const planned = post.mock.calls.find(([path]) =>
      path.endsWith("/plans"),
    )?.[1] as {
      body: { groups: { imageIds: string[]; contentConfirmed: boolean }[] };
    };
    expect(planned.body.groups[0]).toMatchObject({
      imageIds: ["image2", "image10"],
      contentConfirmed: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "确认上传并提交嵌字" }));
    await screen.findByText("作品或交接基线已变化");
    fireEvent.click(screen.getByRole("button", { name: "重试此项" }));
    await screen.findByText(
      stageSubmitted
        ? "已上传成图并提交嵌字，进入待发布"
        : "此会话已保存成图版本，未提交嵌字；请到作品详情处理",
    );
    await waitFor(() => expect(attempts).toBe(2));
    for (const [, input] of post.mock.calls.filter(([path]) =>
      path.endsWith("/confirm"),
    ))
      expect((input as { body: unknown }).body).toEqual({
        previewId: "frozen-preview",
      });
    expect(
      post.mock.calls.some(([path]) => path.includes("/stages/submit")),
    ).toBe(false);
  },
);
