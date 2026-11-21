import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client, queryClient } from "../account/api";
import { TypesetUploadDialog } from "./TypesetUploadDialog";
import { createComikuClient } from "@comiku/api-client";
import * as batchApi from "./typeset-batch-api";
import * as transferApi from "./typeset-upload-transfer";
import * as localApi from "./typeset-local-files";
import * as planApi from "./typeset-upload-plan";
import { File as NodeFile } from "node:buffer";
import { zipSync } from "fflate";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function showUploadDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
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
}

test("restores an incomplete direct session through exact original-file reselection and retains completed pages", async () => {
  localStorage.setItem("comiku:typeset-upload-session:user", "session");
  const file = (id: string, processed: boolean) => ({
    id,
    sourceName: `21-00${id}.png`,
    size: 1,
    contentType: "image/png",
    checksum: "a".repeat(64),
    uploadMissing: false,
    archive: false,
    status: processed ? "processed" : "pending",
    error: null,
    upload: processed
      ? null
      : {
          url: "https://storage.invalid/pending",
          method: "PUT",
          headers: { "If-None-Match": "*" },
        },
    images: processed
      ? [
          {
            id: `image${id}`,
            uploadFileId: id,
            sourceName: `21-00${id}.png`,
            width: 640,
            height: 960,
            size: 1,
            workNumber: 21,
            pageNumber: Number(id),
            warnings: [],
          },
        ]
      : [],
  });
  const previous = {
    id: "session",
    status: "previewed",
    maxWorks: 20,
    maxTotalBytes: 512 * 1024 * 1024,
    files: [file("1", true), file("2", false)],
  };
  const ready = { ...previous, files: [file("1", true), file("2", true)] };
  let confirmed = false;
  vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data: String(path).includes("handoff-manifest")
          ? { items: [] }
          : confirmed
            ? ready
            : previous,
        response: new Response(),
      }) as never,
  );
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    throw new Error(
      "Must neither create another session nor extract direct images",
    );
  });
  vi.spyOn(planApi, "uploadFileChecksum").mockImplementation(async (file) =>
    (file.lastModified === 1 ? "b" : "a").repeat(64),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 640, height: 960, close: vi.fn() })),
  );
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/files/2/verify")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        width: 640,
        height: 960,
      });
      confirmed = true;
      return Response.json(ready.files[1]);
    }
    expect(url).toBe("https://storage.invalid/pending");
    expect(new Headers(init?.headers).get("If-None-Match")).toBe("*");
    return new Response(null, { status: 412 });
  });
  vi.stubGlobal("fetch", network);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:reselected");
      static revokeObjectURL = vi.fn();
    },
  );
  const { container } = showUploadDialog();
  fireEvent.click(screen.getByRole("button", { name: "恢复上次会话" }));
  await screen.findByText(/重新选择此会话的全部原文件/);
  expect(screen.getByText("21-001.png")).toBeTruthy();
  expect(network).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: {
      files: [
        new File(["z"], "21-002.png", { lastModified: 1 }),
        new File(["x"], "21-001.png"),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "继续恢复上传" }));
  await screen.findByText("重试文件与上传会话不匹配，请重新选择文件");
  expect(network).not.toHaveBeenCalled();
  expect(screen.getByText("21-001.png")).toBeTruthy();
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: {
      files: [new File(["y"], "21-002.png"), new File(["x"], "21-001.png")],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "继续恢复上传" }));
  await screen.findByText("21-002.png");
  await waitFor(() =>
    expect(screen.queryByText(/重新选择此会话的全部原文件/)).toBeNull(),
  );
  expect(screen.getByText("21-001.png")).toBeTruthy();
  expect(network).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
  expect(localStorage.getItem("comiku:typeset-upload-session:user")).toBe(
    "session",
  );
});

test("restores only exact owned session files from the original ZIP, releasing every local preview on failure and success", async () => {
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 640, height: 960, close: vi.fn() })),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:reselected");
      static revokeObjectURL = vi.fn();
    },
  );
  localStorage.setItem("comiku:typeset-upload-session:user", "session");
  const file = (id: number, processed: boolean) => ({
    id: String(id),
    sourceName: "page.png",
    size: 1,
    contentType: "image/png",
    checksum: (id === 1 ? "a" : "b").repeat(64),
    uploadMissing: false,
    archive: false,
    status: processed ? "processed" : "pending",
    error: null,
    upload: processed
      ? null
      : {
          url: "https://storage.invalid/owned",
          method: "PUT",
          headers: { "If-None-Match": "*" },
        },
    images: processed
      ? [
          {
            id: `image${id}`,
            uploadFileId: String(id),
            sourceName: `done${id}.png`,
            width: 640,
            height: 960,
            size: 1,
            workNumber: 21,
            pageNumber: id,
            warnings: [],
          },
        ]
      : [],
  });
  const previous = {
    id: "session",
    status: "previewed",
    maxWorks: 20,
    maxTotalBytes: 512 * 1024 * 1024,
    files: [file(1, true), file(2, false)],
  };
  const ready = { ...previous, files: [file(1, true), file(2, true)] };
  let confirmed = false,
    checks = 0;
  vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data: String(path).includes("handoff-manifest")
          ? { items: [] }
          : confirmed
            ? ready
            : previous,
        response: new Response(),
      }) as never,
  );
  const post = vi.spyOn(client, "POST").mockImplementation(async () => {
    throw new Error("Must retain original session and avoid extraction");
  });
  vi.spyOn(planApi, "uploadFileChecksum").mockImplementation(async (file) =>
    (({ X: "a", Y: "b", Z: "c" })[(await file.text()) as "X"] ?? "d").repeat(
      64,
    ),
  );
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/files/2/verify")) {
      if (++checks === 1) throw new TypeError("Verification reply lost");
      confirmed = true;
      return Response.json(ready.files[1]);
    }
    expect(url).toBe("https://storage.invalid/owned");
    expect(await (init?.body as File).text()).toBe("Y");
    return new Response(null, { status: 412 });
  });
  vi.stubGlobal("fetch", network);
  const { container } = showUploadDialog();
  fireEvent.click(screen.getByRole("button", { name: "恢复上次会话" }));
  await screen.findByText("done1.png");
  fireEvent.click(screen.getByRole("button", { name: "改为新建上传" }));
  expect(screen.queryByText("done1.png")).toBeNull();
  expect(screen.queryByText(/重新选择此会话的全部原文件/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "恢复上次会话" }));
  await screen.findByText(/重新选择此会话的全部原文件/);
  const original = new File(
    [
      zipSync({
        "foreign/page.png": new Uint8Array([90]),
        "own1/page.png": new Uint8Array([88]),
        "own2/page.png": new Uint8Array([89]),
      }) as BlobPart,
    ],
    "21_成图.zip",
  );
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [original] },
  });
  fireEvent.click(screen.getByRole("button", { name: "继续恢复上传" }));
  await screen.findByText(/上传连接中断/);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(3);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  expect(screen.getByText("done1.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "继续恢复上传" }));
  await screen.findByText("done2.png");
  await waitFor(() =>
    expect(screen.queryByText(/重新选择此会话的全部原文件/)).toBeNull(),
  );
  expect(
    network.mock.calls.filter(([url]) => !url.endsWith("/verify")),
  ).toHaveLength(1);
  expect(createImageBitmap).toHaveBeenCalledTimes(3);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  expect(post).not.toHaveBeenCalled();
});

test.each(["resume"] as const)(
  "keeps successful batch images visible alongside a failed ZIP after %s",
  async (entry) => {
    const result = {
      id: "partial",
      status: "previewed",
      expiresAt: "2030-01-01T00:00:00Z",
      maxWorks: 20,
      maxTotalBytes: 512 * 1024 * 1024,
      files: [
        {
          id: "good",
          size: 12,
          checksum: "a".repeat(64),
          contentType: "application/zip",
          uploadMissing: false,
          sourceName: "21.zip",
          archive: true,
          status: "processed",
          error: null,
          upload: null,
          images: [
            {
              id: "image",
              uploadFileId: "good",
              sourceName: "21-001成图.png",
              width: 10,
              height: 10,
              size: 12,
              workNumber: 21,
              pageNumber: 1,
              warnings: [],
            },
          ],
        },
        {
          id: "bad",
          size: 12,
          checksum: "b".repeat(64),
          contentType: "application/zip",
          uploadMissing: false,
          sourceName: "22.zip",
          archive: true,
          status: "failed",
          error: "ZIP 无法解析",
          upload: null,
          images: [],
        },
      ],
    };
    vi.spyOn(client, "GET").mockImplementation(
      async (path: string) =>
        ({
          data: path.includes("handoff-manifest") ? { items: [] } : result,
          response: new Response(),
        }) as never,
    );
    vi.spyOn(client, "POST").mockImplementation(
      async () => ({ data: result, response: new Response() }) as never,
    );
    if (entry === "resume")
      localStorage.setItem("comiku:typeset-upload-session:user", "partial");
    else
      vi.spyOn(transferApi, "uploadTypesetFiles").mockResolvedValue(
        result as Awaited<ReturnType<typeof transferApi.uploadTypesetFiles>>,
      );
    const { container } = showUploadDialog();
    if (entry === "resume")
      fireEvent.click(screen.getByRole("button", { name: "恢复上次会话" }));
    else {
      fireEvent.change(container.querySelector("input[type=file]")!, {
        target: { files: [new File(["test"], "21.zip")] },
      });
      fireEvent.click(screen.getByRole("button", { name: "上传并解析预览" }));
    }
    expect(await screen.findByText("21-001成图.png")).toBeTruthy();
    expect(screen.getByText(/22.zip.*ZIP 无法解析/)).toBeTruthy();
  },
);

test("local previews send no bytes and a failed selected transfer retries its existing session", async () => {
  const file = new File(["synthetic"], "11.png", { type: "image/png" });
  const session = { id: "retry-session", files: [] } as unknown as Awaited<
    ReturnType<typeof transferApi.uploadTypesetFiles>
  >;
  const upload = vi
    .spyOn(transferApi, "uploadTypesetFiles")
    .mockImplementation(async (_files, options) => {
      options?.onSession?.(session);
      throw new Error("11.png：上传失败（HTTP 502）。请重试上传");
    });
  vi.spyOn(localApi, "prepareLocalTypesetImages").mockResolvedValue([
    {
      id: "local",
      uploadFileId: "container",
      sourceName: file.name,
      width: 10,
      height: 10,
      size: file.size,
      workNumber: 11,
      pageNumber: 1,
      warnings: [],
      target: "11",
      included: true,
      archive: false,
      file,
      localUrl: "blob:fixture",
    },
  ]);
  vi.spyOn(localApi, "releaseLocalTypesetImages").mockImplementation(
    () => undefined,
  );
  vi.spyOn(client, "GET").mockImplementation(
    async (path) =>
      ({
        data: String(path).includes("handoff-manifest")
          ? { items: [{ workId: "work", workNumber: 11, title: "Work" }] }
          : { collaborationMode: "single", pages: [], participants: [] },
        response: new Response(),
      }) as never,
  );
  const { container } = showUploadDialog();
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "本地解析预览" }));
  await screen.findByText("11.png");
  expect(upload).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "检查提交条件",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "已预览核对，所选图片为成图（包含说明页）",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "检查提交条件" }));
  await screen.findByText("11.png：上传失败（HTTP 502）。请重试上传");
  expect(localStorage.getItem("comiku:typeset-upload-session:user")).toBe(
    "retry-session",
  );
  expect(screen.getByText("11.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "检查提交条件" }));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  expect(upload.mock.calls[1][0]).toEqual([file]);
  expect(upload.mock.calls[1][1]?.sessionId).toBe("retry-session");
  await screen.findByText("11.png：上传失败（HTTP 502）。请重试上传");
});

test("batch footer waits for every result, preserves confirmed receipts on refresh failure, and retries only failures", async () => {
  localStorage.setItem("comiku:typeset-upload-session:user", "session");
  const session = {
    id: "session",
    status: "previewed",
    maxWorks: 20,
    maxTotalBytes: 512 * 1024 * 1024,
    files: [11, 16].map((number) => ({
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
  };
  vi.spyOn(client, "GET").mockImplementation(
    async (path: string) =>
      ({
        data: path.includes("handoff-manifest")
          ? {
              items: [11, 16].map((number) => ({
                workId: `work${number}`,
                workNumber: number,
                title: null,
              })),
            }
          : path.endsWith("/collaboration")
            ? {
                collaborationMode: "single",
                participants: [],
                pages: [],
                drafts: [],
              }
            : path.endsWith("/url")
              ? { url: "https://example.invalid/fixture.png" }
              : session,
        response: new Response(),
      }) as never,
  );
  vi.spyOn(batchApi, "refreshTypesetWork").mockRejectedValue(
    new Error("刷新连接中断"),
  );
  let finishSecond: (() => void) | undefined;
  let secondAttempts = 0;
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path: string, input: unknown) => {
      if (path.endsWith("/plans"))
        return {
          data: {
            items: [11, 16].map((number) => ({
              workNumber: number,
              workId: `work${number}`,
              previewId: `preview${number}`,
              imageCount: 1,
              error: null,
            })),
          },
          response: new Response(),
        } as never;
      const number =
        (input as { body: { previewId: string } }).body.previewId ===
        "preview11"
          ? 11
          : 16;
      if (number === 16 && ++secondAttempts === 1) {
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
        return {
          error: { message: "版本冲突，请重试" },
          response: new Response(null, { status: 409 }),
        } as never;
      }
      return {
        data: {
          workId: `work${number}`,
          stageSubmitted: true,
          workCompleted: number === 11,
        },
        response: new Response(),
      } as never;
    });
  const onClose = vi.fn();
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
                  onClose={onClose}
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
  await screen.findByText("11-001.png");
  for (const checkbox of screen.getAllByRole("checkbox", {
    name: "已预览核对，所选图片为成图（包含说明页）",
  }))
    fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "检查提交条件" }));
  await screen.findAllByText("检查通过：保存 1 张并提交嵌字");
  fireEvent.click(screen.getByRole("button", { name: "确认上传并提交嵌字" }));
  await waitFor(() => expect(finishSecond).toBeTypeOf("function"));
  const pending = screen.getByRole("status", { name: "批量交稿结果" });
  expect(pending.textContent).toContain("正在提交 2 / 2 部作品");
  expect(pending.textContent).not.toContain("交稿完成");
  expect(
    (screen.getByRole("button", { name: "关闭成图上传" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  finishSecond!();
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "批量交稿结果" }).textContent,
    ).toContain("部分作品未完成"),
  );
  expect(
    screen.getByRole("status", { name: "批量交稿结果" }).textContent,
  ).toContain("1 部进入待发布");
  expect(
    screen.getByRole("status", { name: "批量交稿结果" }).textContent,
  ).toContain("1 部未完成");
  expect(screen.getAllByRole("button", { name: "重试此项" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "重试此项" }));
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "批量交稿结果" }).textContent,
    ).toContain("本人已交稿，等待其他成员"),
  );
  const result = screen.getByRole("status", { name: "批量交稿结果" });
  expect(result.textContent).toContain("1 部进入待发布");
  expect(result.textContent).toContain("1 部等待其他成员");
  expect(
    screen.queryByRole("button", { name: "确认上传并提交嵌字" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "重试此项" })).toBeNull();
  const confirms = (post.mock.calls as unknown as [string, unknown][]).filter(
    ([path]) => path.endsWith("/confirm"),
  );
  expect(confirms).toHaveLength(3);
  expect(
    confirms.map(
      ([, input]) => (input as { body: { previewId: string } }).body.previewId,
    ),
  ).toEqual(["preview11", "preview16", "preview16"]);
  fireEvent.click(
    within(result.parentElement!).getByRole("button", { name: "关闭" }),
  );
  expect(onClose).toHaveBeenCalledOnce();
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
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "批量交稿结果" }).textContent,
      ).toContain(stageSubmitted ? "交稿完成" : "成图已保存，嵌字尚未提交"),
    );
    expect(
      screen.queryByRole("button", { name: "确认上传并提交嵌字" }),
    ).toBeNull();
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
    screen.queryByRole("button", { name: "确认上传并提交嵌字" }),
  ).toBeNull();
  expect(
    screen.getByRole("status", { name: "批量交稿结果" }).textContent,
  ).toContain("本人已交稿，等待其他成员");
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
