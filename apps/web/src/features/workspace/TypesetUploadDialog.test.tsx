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
    expect(post.mock.calls.some(([path]) => path.endsWith("/extract"))).toBe(
      false,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "已预览核对，所选图片为成图（包含说明页）",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查提交条件" }));
    await screen.findByText("检查通过：保存 2 张并提交嵌字");
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

test("restores frozen multi-page mapping, submits only own pages, and shows personal receipt on resume", async () => {
  localStorage.setItem("comiku:typeset-upload-session:user", "session");
  const images = [1, 2, 3].map((number) => ({
    id: `image${number}`,
    uploadFileId: "zip",
    sourceName: `plain${number}.png`,
    width: 100,
    height: 100,
    size: 20,
    workNumber: null,
    pageNumber: null,
    warnings: [],
  }));
  const session = {
    id: "session",
    status: "previewed",
    expiresAt: "2030-01-01T00:00:00Z",
    maxWorks: 20,
    maxTotalBytes: 512 * 1024 * 1024,
    files: [
      {
        id: "zip",
        sourceName: "plain.zip",
        archive: true,
        status: "processed",
        error: null,
        upload: null,
        images,
      },
    ],
  };
  let completed = false;
  const get = vi.spyOn(client, "GET").mockImplementation(
    async (path: string) =>
      ({
        data: path.includes("handoff-manifest")
          ? {
              items: [
                {
                  workId: "work16",
                  workNumber: 16,
                  title: "Multi",
                  canDownload: true,
                },
              ],
            }
          : path.endsWith("/collaboration")
            ? {
                collaborationMode: "multi",
                participants: [
                  { id: "mine", userId: "user", user: { displayName: "Me" } },
                ],
                pages: [1, 2, 3].map((number) => ({
                  id: `p${number}`,
                  orderIndex: number - 1,
                  assignment: {
                    participantId: number === 2 ? "other" : "mine",
                  },
                })),
                drafts: [],
              }
            : path.endsWith("/url")
              ? {
                  url: "https://example.invalid/fixture.png",
                  expiresInSeconds: 300,
                }
              : {
                  ...session,
                  ...(completed
                    ? {
                        receipts: [
                          {
                            workNumber: 16,
                            workId: "work16",
                            imageIds: images.map((image) => image.id),
                            versionId: null,
                            stageSubmitted: true,
                            workCompleted: false,
                          },
                        ],
                      }
                    : {}),
                },
        response: new Response(),
      }) as never,
  );
  let finish: (() => void) | undefined;
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path: string) => {
      if (path.endsWith("/plans"))
        return {
          data: {
            items: [
              {
                workNumber: 16,
                workId: "work16",
                title: "Multi",
                previewId: "frozen",
                workRevision: 3,
                editorEpoch: 0,
                handoffStartedAt: "2026-11-20T00:00:00Z",
                imageCount: 3,
                savedImageCount: 2,
                ignored: ["plain2.png"],
                error: null,
              },
            ],
          },
          response: new Response(),
        } as never;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      completed = true;
      return {
        data: {
          workId: "work16",
          versionId: null,
          stageSubmitted: true,
          workCompleted: false,
        },
        response: new Response(),
      } as never;
    });
  const postCalls = () => post.mock.calls as unknown as [string, unknown][];
  const getCalls = () => get.mock.calls as unknown as [string, unknown][];
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
  await screen.findByText("plain1.png");
  fireEvent.click(screen.getByRole("combobox", { name: "本组成图目标" }));
  fireEvent.click(await screen.findByRole("option", { name: "#16 · Multi" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "按当前顺序对应全部原稿" }),
  );
  expect(
    screen
      .getAllByRole("combobox", { name: "对应原稿" })
      .map((element) => element.textContent),
  ).toEqual(["第 1 页 · 本人", "第 2 页 · 将忽略", "第 3 页 · 本人"]);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "已核对缺失／冲突编号并确认人工目标",
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "已预览核对，所选图片为成图（包含说明页）",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "检查提交条件" }));
  await screen.findByText(
    "检查通过：保存 2 张并提交本人负责页，忽略非本人负责的 1 张",
  );
  expect(
    postCalls().find(([path]) => path.endsWith("/plans"))?.[1],
  ).toMatchObject({
    body: {
      groups: [
        {
          workNumber: 16,
          pageMappings: [
            { imageId: "image1", workImageId: "p1" },
            { imageId: "image2", workImageId: "p2" },
            { imageId: "image3", workImageId: "p3" },
          ],
        },
      ],
    },
  });
  const confirm = screen.getByRole("button", { name: "确认上传并提交嵌字" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await screen.findByText("正在确认 #16");
  expect(
    postCalls().filter(([path]) => path.endsWith("/confirm")),
  ).toHaveLength(1);
  finish!();
  await screen.findByText("已保存成图并提交本人负责页，等待其他成员");
  fireEvent.click(screen.getByRole("button", { name: "恢复上次会话" }));
  await waitFor(() =>
    expect(
      getCalls().filter(
        ([path]) => path === "/api/typeset/upload-sessions/{id}",
      ),
    ).toHaveLength(2),
  );
  expect(
    await screen.findByText("已保存成图并提交本人负责页，等待其他成员"),
  ).toBeTruthy();
  expect(postCalls().some(([path]) => path.endsWith("/extract"))).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "确认上传并提交嵌字",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("a restored completed work missing from the manifest does not block the remaining work", async () => {
  localStorage.setItem("comiku:typeset-upload-session:user", "session");
  const session = {
    id: "session",
    status: "previewed",
    expiresAt: "2030-01-01T00:00:00Z",
    maxWorks: 20,
    maxTotalBytes: 512 * 1024 * 1024,
    files: [16, 11].map((number) => ({
      id: `file${number}`,
      sourceName: `${number}.png`,
      archive: false,
      status: "processed",
      error: null,
      upload: null,
      images: [
        {
          id: `image${number}`,
          uploadFileId: `file${number}`,
          sourceName: `${number}-001.png`,
          width: 100,
          height: 100,
          size: 20,
          workNumber: number,
          pageNumber: 1,
          warnings: [],
        },
      ],
    })),
    receipts: [
      {
        workNumber: 16,
        workId: "work16",
        imageIds: ["image16"],
        versionId: null,
        stageSubmitted: true,
        workCompleted: false,
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
                  workId: "work11",
                  workNumber: 11,
                  title: "Remaining",
                  canDownload: true,
                },
              ],
            }
          : path.endsWith("/collaboration")
            ? {
                collaborationMode: "single",
                participants: [],
                pages: [],
                drafts: [],
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
  const post = vi.spyOn(client, "POST").mockResolvedValue({
    data: { items: [] },
    response: new Response(),
  } as never);
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
  await screen.findByText("已保存成图并提交本人负责页，等待其他成员");
  const check = screen.getByRole("button", { name: "检查提交条件" });
  await waitFor(() =>
    expect((check as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "已预览核对，所选图片为成图（包含说明页）",
    }),
  );
  fireEvent.click(check);
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(post.mock.calls[0][1]).toMatchObject({
    body: { groups: [{ workNumber: 11, imageIds: ["image11"] }] },
  });
  expect(
    (post.mock.calls[0][1] as { body: { groups: unknown[] } }).body.groups,
  ).toHaveLength(1);
});
