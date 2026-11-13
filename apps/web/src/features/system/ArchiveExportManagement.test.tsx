import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { StrictMode } from "react";
import { client } from "../account/api";
import { ArchiveExportManagement } from "./ArchiveExportManagement";

type Run = components["schemas"]["ArchiveExportRunDto"];
const settings = {
  enabled: true,
  revision: 2,
  bandwidthLimitMiB: 0,
  packageTargetBytes: "2147483648",
  retentionDays: 7,
};
const preview = {
  workCount: 2,
  imageCount: 4,
  textCount: 1,
  missingRenderedCount: 1,
  estimatedBytes: "1048576",
  warningCount: 0,
  failureCount: 0,
};
const run = (extra: Partial<Run> = {}): Run => ({
  ...preview,
  id: "archive-run",
  revision: 3,
  status: "succeeded",
  year: 2026,
  month: 11,
  content: "both",
  includeArchived: false,
  includeDiscarded: false,
  createdAt: "2026-11-13T00:00:00Z",
  completedAt: "2026-11-13T00:01:00Z",
  expiresAt: "2099-11-20T00:00:00Z",
  packageCount: 1,
  completedPackageCount: 1,
  capturedMonthCount: 1,
  completedBytes: "1048576",
  error: null,
  filesStatus: "available",
  filesDeletedAt: null,
  deletionError: null,
  ...extra,
});
const pack = {
  id: "package-one",
  ordinal: 1,
  status: "succeeded",
  fileName: "2026-11-001.zip",
  bytes: "1048576",
  checksum: "abc123",
  error: null,
  downloadable: true,
};
function response(data: unknown, status = 200) {
  return { data, response: new Response(null, { status }) };
}
type Options = {
  params?: {
    query?: { cursor?: string; limit?: number };
    path?: { id: string; packageId?: string };
  };
  body?: Record<string, unknown>;
  signal?: AbortSignal;
};
// Spy on a concrete signature: openapi-fetch's generic methods otherwise infer
// `never` for mock call arguments when assertions narrow to one typed endpoint.
const testClient = client as unknown as Record<
  "GET" | "POST" | "PATCH",
  (path: string, options?: Options) => Promise<ReturnType<typeof response>>
>;
function mockReads(rows: Run[] = [], config = settings) {
  return vi.spyOn(testClient, "GET").mockImplementation((async (
    path: string,
    options?: Options,
  ) => {
    if (path === "/api/archive-exports/settings") return response(config);
    if (path.endsWith("/packages/{packageId}/download"))
      return response({
        url: "https://archive.example.test/signed.zip",
        fileName: pack.fileName,
        expiresInSeconds: 300,
      });
    if (path.endsWith("/packages"))
      return response({
        items: [pack],
        nextCursor: options?.params?.query?.cursor ? null : "packages-next",
      });
    if (path.endsWith("/issues"))
      return response({
        items: [
          {
            id: "issue",
            workId: "work",
            workNumber: 1024,
            codes: ["missing_rendered"],
          },
        ],
        nextCursor: options?.params?.query?.cursor ? null : "issues-next",
      });
    if (path === "/api/archive-exports")
      return response({
        items: rows,
        nextCursor: options?.params?.query?.cursor ? null : "runs-next",
      });
    throw new Error(`Unexpected read ${path}`);
  }) as never);
}
function mount(enabled = true) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = (active: boolean) => (
    <QueryClientProvider client={cache}>
      <ArchiveExportManagement enabled={active} />
    </QueryClientProvider>
  );
  const view = render(element(enabled));
  return {
    ...view,
    cache,
    setEnabled: (active: boolean) => view.rerender(element(active)),
  };
}
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("a disabled deployment explains availability and never previews or creates", async () => {
  const get = mockReads([], { ...settings, enabled: false });
  const post = vi.spyOn(testClient, "POST");
  mount();
  expect(await screen.findByText(/此部署尚未启用归档导出/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "预览导出" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText("归档生成带宽（MiB/s）") as HTMLInputElement).value,
  ).toBe("0");
  expect(get.mock.calls.map((call) => call[0])).toEqual([
    "/api/archive-exports/settings",
    "/api/archive-exports",
  ]);
  expect(post).not.toHaveBeenCalled();
});

test("preview binds a scope snapshot, invalidates on changes, and create reuses its idempotency key after lost reply", async () => {
  mockReads();
  const post = vi.spyOn(testClient, "POST");
  post
    .mockResolvedValueOnce(response(preview) as never)
    .mockRejectedValueOnce(new Error("回执丢失"))
    .mockResolvedValueOnce(response(run()) as never);
  mount();
  await screen.findByText("暂无导出记录。");
  fireEvent.change(screen.getByLabelText("入库年份"), {
    target: { value: "2025" },
  });
  fireEvent.click(screen.getByRole("button", { name: "预览导出" }));
  fireEvent.click(await screen.findByRole("button", { name: "创建导出任务" }));
  await screen.findByText("回执丢失");
  fireEvent.click(screen.getByRole("button", { name: "创建导出任务" }));
  await screen.findByText(/导出任务已创建/);
  const creates = post.mock.calls.filter(
    (call) => call[0] === "/api/archive-exports",
  );
  expect(creates).toHaveLength(2);
  expect(creates[0][1]?.body).toMatchObject({
    year: 2025,
    content: "both",
    includeArchived: false,
    includeDiscarded: false,
  });
  expect(creates[1][1]?.body).toEqual(creates[0][1]?.body);
  post.mockResolvedValueOnce(response(preview) as never);
  fireEvent.click(screen.getByRole("button", { name: "预览导出" }));
  await screen.findByRole("button", { name: "创建导出任务" });
  fireEvent.click(screen.getByLabelText("包含归档作品"));
  expect(screen.queryByRole("button", { name: "创建导出任务" })).toBeNull();
});

test("a late preview response cannot authorize a changed form", async () => {
  mockReads();
  let resolve!: (value: unknown) => void;
  const post = vi.spyOn(testClient, "POST").mockImplementation(
    (() =>
      new Promise((done) => {
        resolve = done;
      })) as never,
  );
  mount();
  await screen.findByText("暂无导出记录。");
  fireEvent.click(screen.getByRole("button", { name: "预览导出" }));
  const signal = (post.mock.calls[0][1] as Options).signal;
  fireEvent.change(screen.getByLabelText("入库年份"), {
    target: { value: "2024" },
  });
  await act(async () => resolve(response(preview)));
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole("button", { name: "创建导出任务" })).toBeNull();
});

test("settings CAS conflict keeps draft, requires explicit version adoption, and applies unlimited to running jobs", async () => {
  const get = mockReads([run({ status: "generating" })]);
  const patch = vi
    .spyOn(testClient, "PATCH")
    .mockResolvedValueOnce(response(undefined, 409) as never)
    .mockResolvedValueOnce(response({ ...settings, revision: 5 }) as never);
  mount();
  await screen.findByText("生成中");
  fireEvent.change(screen.getByLabelText("归档生成带宽（MiB/s）"), {
    target: { value: "8" },
  });
  fireEvent.change(screen.getByLabelText("归档生成带宽（MiB/s）"), {
    target: { value: "0" },
  });
  get.mockImplementationOnce((async () =>
    response({ ...settings, revision: 4, bandwidthLimitMiB: 8 })) as never);
  fireEvent.click(screen.getByRole("button", { name: "保存带宽" }));
  await screen.findByText(/设置已被其他管理员更新/);
  expect(
    (screen.getByLabelText("归档生成带宽（MiB/s）") as HTMLInputElement).value,
  ).toBe("0");
  expect(
    (screen.getByRole("button", { name: "保存带宽" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "采用最新版本并保留输入" }),
  );
  expect(patch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "保存带宽" }));
  await screen.findByText(/生成带宽已保存/);
  expect(patch.mock.calls[0][1]?.body).toEqual({
    expectedRevision: 2,
    bandwidthLimitMiB: 0,
  });
  expect(patch.mock.calls[1][1]?.body).toEqual({
    expectedRevision: 4,
    bandwidthLimitMiB: 0,
  });
});

test("packages and work issues load only when expanded, with independent bounded cursor pages", async () => {
  const get = mockReads([run()]);
  mount();
  await screen.findByText("已完成");
  expect(get.mock.calls).toHaveLength(2);
  expect(get.mock.calls[1][1]?.params?.query).toEqual({
    limit: 10,
    cursor: undefined,
  });
  fireEvent.click(screen.getByRole("button", { name: "查看与下载" }));
  await screen.findByText(pack.fileName);
  await screen.findByText(/作品 #1024/);
  expect(
    get.mock.calls.find((call) => call[0].endsWith("/packages"))?.[1]?.params
      ?.query,
  ).toEqual({ limit: 20, cursor: undefined });
  fireEvent.click(screen.getByRole("button", { name: "下一页分包" }));
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) =>
          (call[1] as Options)?.params?.query?.cursor === "packages-next",
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页异常" }));
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) => (call[1] as Options)?.params?.query?.cursor === "issues-next",
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "下一页记录" }));
  await waitFor(() =>
    expect(
      get.mock.calls.some(
        (call) => (call[1] as Options)?.params?.query?.cursor === "runs-next",
      ),
    ).toBe(true),
  );
});

test("download requests a package link and hands the private R2 URL to the browser", async () => {
  mockReads([run()]);
  const downloads: { href: string; fileName: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ href: this.href, fileName: this.download });
  });
  mount();
  await screen.findByText("已完成");
  fireEvent.click(screen.getByRole("button", { name: "查看与下载" }));
  fireEvent.click(await screen.findByRole("button", { name: "下载 ZIP" }));
  await screen.findByText(/已交付浏览器下载/);
  expect(downloads).toEqual([
    {
      href: "https://archive.example.test/signed.zip",
      fileName: pack.fileName,
    },
  ]);
});

test("delete needs a downloaded confirmation and preserves retryable history on failure", async () => {
  mockReads([
    run({ filesStatus: "delete_failed", deletionError: "storage_unavailable" }),
  ]);
  const post = vi
    .spyOn(testClient, "POST")
    .mockRejectedValueOnce(new Error("删除请求失败"));
  mount();
  await screen.findByText("ZIP 删除失败，可重试");
  fireEvent.click(screen.getByRole("button", { name: "重试删除 ZIP" }));
  const dialog = screen.getByRole("dialog", { name: "删除导出 ZIP" });
  const confirm = within(dialog).getByRole("button", {
    name: "确认删除 ZIP",
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(
    within(dialog).getByLabelText("我已下载并核对需要保留的文件"),
  );
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await screen.findByText("删除请求失败");
  expect(post.mock.calls[0][0]).toBe("/api/archive-exports/{id}/delete-files");
  expect(post.mock.calls[0][1]?.body).toMatchObject({
    expectedRevision: 3,
    confirmedDownloaded: true,
  });
  expect(screen.getByText("ZIP 删除失败，可重试")).toBeTruthy();
  expect(confirm.disabled).toBe(false);
});

test("a refreshed task revision locks deletion until checkbox is reconfirmed", async () => {
  const get = mockReads([run()]);
  const { cache } = mount();
  await screen.findByText("已完成");
  fireEvent.click(screen.getByRole("button", { name: "删除 ZIP" }));
  fireEvent.click(screen.getByLabelText("我已下载并核对需要保留的文件"));
  get.mockImplementation((async (path: string) =>
    path.endsWith("/settings")
      ? response(settings)
      : response({
          items: [run({ revision: 4 })],
          nextCursor: null,
        })) as never);
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ["archive-exports", "runs"] });
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "确认删除 ZIP",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "重新核对当前任务" }));
  expect(
    (screen.getByLabelText("我已下载并核对需要保留的文件") as HTMLInputElement)
      .checked,
  ).toBe(false);
});

test("deleting files disable downloads and poll only on the visible active panel; drafts survive", async () => {
  vi.useFakeTimers();
  const get = mockReads([run({ filesStatus: "deleting" })]);
  const { setEnabled } = mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(screen.getByText("ZIP 删除中")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("入库年份"), {
    target: { value: "2022" },
  });
  fireEvent.click(screen.getByRole("button", { name: "查看与下载" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(screen.getByText(pack.fileName)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "下载 ZIP" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const before = get.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5500);
  });
  expect(get.mock.calls.length).toBeGreaterThan(before);
  setEnabled(false);
  const hiddenBefore = get.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(get.mock.calls.length).toBe(hiddenBefore);
  setEnabled(true);
  await act(async () => {});
  expect((screen.getByLabelText("入库年份") as HTMLInputElement).value).toBe(
    "2022",
  );
});

test("historical terminal records never poll and inactive panels perform no reads", async () => {
  const get = mockReads([run()]);
  const { setEnabled } = mount(false);
  expect(get).not.toHaveBeenCalled();
  setEnabled(true);
  await screen.findByText("已完成");
  const before = get.mock.calls.length;
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(get.mock.calls.length).toBe(before);
});

test("cancellation and failed-package retry carry the observed run revision without offering active deletion", async () => {
  mockReads([
    run({ status: "generating" }),
    run({ id: "failed-run", revision: 9, status: "partial" }),
  ]);
  const post = vi
    .spyOn(testClient, "POST")
    .mockResolvedValue(response(run({ status: "cancelling" })) as never);
  mount();
  await screen.findByText("生成中");
  const generating = screen.getByText("生成中").closest("article")!;
  expect(
    within(generating).queryByRole("button", { name: "删除 ZIP" }),
  ).toBeNull();
  fireEvent.click(within(generating).getByRole("button", { name: "取消任务" }));
  await screen.findByText(/已请求取消/);
  expect(post.mock.calls[0][0]).toBe("/api/archive-exports/{id}/cancel");
  expect(post.mock.calls[0][1]).toMatchObject({
    params: { path: { id: "archive-run" } },
    body: { expectedRevision: 3 },
  });
  post.mockResolvedValueOnce(
    response(
      run({ id: "failed-run", revision: 10, status: "queued" }),
    ) as never,
  );
  fireEvent.click(screen.getByRole("button", { name: "重试失败包" }));
  await screen.findByText(/已请求重试失败分包/);
  expect(post.mock.calls[1][0]).toBe("/api/archive-exports/{id}/retry");
  expect(post.mock.calls[1][1]).toMatchObject({
    params: { path: { id: "failed-run" } },
    body: { expectedRevision: 9 },
  });
});

test("a hidden document stops activity polling and closes native deletion dialogs while retaining drafts", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const get = mockReads([run(), run({ id: "active", status: "generating" })]);
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(get).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(screen.getByText("生成中")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("归档生成带宽（MiB/s）"), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "删除 ZIP" }));
  expect(screen.getByRole("dialog", { name: "删除导出 ZIP" })).toBeTruthy();
  expect(document.body.style.overflow).toBe("hidden");
  visibility.mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  const before = get.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(get.mock.calls.length).toBe(before);
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(
    (screen.getByLabelText("归档生成带宽（MiB/s）") as HTMLInputElement).value,
  ).toBe("12");
});

test("known run, cleanup, and package error codes have readable labels while unknown codes remain visible", async () => {
  const get = mockReads([
    run({
      error: "archive_owner_unsettled",
      deletionError: "archive_cleanup_failed",
    }),
  ]);
  const original = get.getMockImplementation()!;
  get.mockImplementation(async (path, options) =>
    path.endsWith("/packages")
      ? response({
          items: [
            { ...pack, error: "archive_generation_failed" },
            { ...pack, id: "unknown", error: "future_diagnostic_code" },
          ],
          nextCursor: null,
        })
      : original(path, options),
  );
  mount();
  await screen.findByText("已完成");
  fireEvent.click(screen.getByRole("button", { name: "查看与下载" }));
  expect(
    await screen.findByText("上次执行尚未确认停止，请联系维护者恢复"),
  ).toBeTruthy();
  expect(await screen.findByText("归档生成失败，请重试失败分包")).toBeTruthy();
  expect(screen.getByText(/导出文件清理失败，请重试删除/)).toBeTruthy();
  expect(screen.getByText("future_diagnostic_code")).toBeTruthy();
});

test("native modal focus and scroll lock recover after a StrictMode effect replay", async () => {
  mockReads([run()]);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
      this.querySelector<HTMLButtonElement>("button")?.focus();
    }),
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: close,
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={cache}>
        <ArchiveExportManagement />
      </QueryClientProvider>
    </StrictMode>,
  );
  await screen.findByText("已完成");
  const opener = screen.getByRole("button", { name: "删除 ZIP" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "删除导出 ZIP" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("");
  expect(close).toHaveBeenCalled();
});
