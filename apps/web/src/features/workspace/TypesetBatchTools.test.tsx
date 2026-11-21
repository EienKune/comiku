import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { client, queryClient } from "../account/api";
import { TypesetBatchTools } from "./TypesetBatchTools";
import {
  TopbarActionsContext,
  type TopbarActionRegistration,
} from "../account/topbar-actions";

function ToolsShell({ switchable = false }: { switchable?: boolean }) {
  const [registration, setRegistration] =
    useState<TopbarActionRegistration | null>(null);
  const [enabled, setEnabled] = useState(true);
  return (
    <TopbarActionsContext.Provider value={setRegistration}>
      <header aria-label="顶部工具栏">{registration?.content}</header>
      <main>
        <h1>作品</h1>
        {switchable && (
          <button onClick={() => setEnabled((value) => !value)}>
            切换视图
          </button>
        )}
        <TypesetBatchTools enabled={enabled} />
      </main>
    </TopbarActionsContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
});

test("freezes the full manifest, delivers a controlled queue, and keeps failed items retryable", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const createObjectURL = vi.fn(() => "blob:test");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    () => undefined,
  );
  const manifest = Array.from({ length: 26 }, (_, index) => ({
    workId: `work-${index}`,
    workNumber: index + 1,
    title: null,
    imageCount: 2,
    workRevision: 3,
    editorEpoch: 4,
    canDownload: true,
    unavailableReason: null,
  }));
  vi.spyOn(client, "GET").mockResolvedValue({
    data: { items: manifest },
    response: new Response(),
  } as never);
  const post = vi.spyOn(client, "POST");
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("https://storage.invalid/"))
      return new Response(new Uint8Array([1, 2, 3]));
    const workId = url.split("/")[3];
    if (workId === "work-0")
      return Response.json({ message: "清单已过期" }, { status: 409 });
    return Response.json({
      id: workId,
      fileName: "work.zip",
      translationVersionId: "formal",
      sourceAssetRevision: 1,
      workRevision: 3,
      editorEpoch: 4,
      totalBytes: 3,
      translationFileName: "翻译.txt",
      translationBase64: "",
      images: [
        {
          fileName: `${workId}.png`,
          size: 3,
          checksum:
            "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
          url: `https://storage.invalid/${workId}.png`,
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = {
    id: "user",
    roles: ["typesetter"],
    permissions: ["works:typeset"],
  };
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={user} />}>
          <Route path="/" element={<ToolsShell />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "批量下载嵌字交接包" }));
  await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(26));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认交接并下载选中项" }));
  await waitFor(() =>
    expect(screen.getAllByText("已取得交接包，已交付浏览器下载")).toHaveLength(
      25,
    ),
  );
  expect(screen.getByText("清单已过期")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "重试此项" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(post).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(76);
  expect(fetchMock.mock.calls[0][0]).toBe(
    "/api/works/work-0/typeset/materials",
  );
  expect(createObjectURL).toHaveBeenCalledTimes(25);
});

test("batch entry visibility changes only inside the topbar, leaving the list body unchanged", () => {
  render(
    <MemoryRouter>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                id: "user",
                roles: ["typesetter"],
                permissions: ["works:typeset"],
              }}
            />
          }
        >
          <Route path="/" element={<ToolsShell switchable />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  const download = screen.getByRole("button", { name: "批量下载嵌字交接包" });
  expect(download.closest("header")).toBeTruthy();
  expect(document.querySelector("main .workspace-batch-tools")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "切换视图" }));
  expect(
    screen.queryByRole("button", { name: "批量下载嵌字交接包" }),
  ).toBeNull();
  expect(screen.getByRole("heading", { name: "作品" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "切换视图" }));
  expect(
    screen
      .getByRole("button", { name: "批量下载嵌字交接包" })
      .closest("header"),
  ).toBeTruthy();
});

test("refreshes the handoff baseline whenever the checklist is reopened after detail changes", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  let revision = 3;
  const get = vi.spyOn(client, "GET").mockImplementation(
    async () =>
      ({
        data: {
          items: [
            {
              workId: "work",
              workNumber: 16,
              title: `版本 ${revision}`,
              imageCount: 2,
              workRevision: revision,
              editorEpoch: 1,
              canDownload: true,
              unavailableReason: null,
            },
          ],
        },
        response: new Response(),
      }) as never,
  );
  render(
    <MemoryRouter>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                id: "user",
                roles: ["typesetter"],
                permissions: ["works:typeset"],
              }}
            />
          }
        >
          <Route path="/" element={<ToolsShell />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "批量下载嵌字交接包" }));
  await screen.findByText("#16 · 版本 3");
  fireEvent.click(screen.getByRole("button", { name: "关闭下载清单" }));
  revision = 4;
  fireEvent.click(screen.getByRole("button", { name: "批量下载嵌字交接包" }));
  await screen.findByText("#16 · 版本 4");
  expect(get).toHaveBeenCalledTimes(2);
});
