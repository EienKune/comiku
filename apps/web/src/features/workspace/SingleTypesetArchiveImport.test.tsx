import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { uploadTypesetFiles } from "./typeset-upload-transfer";
import { SingleTypesetArchiveImport } from "./SingleTypesetArchiveImport";
import { File as NodeFile } from "node:buffer";
import { zipSync } from "fflate";
vi.mock("./typeset-upload-transfer", () => ({ uploadTypesetFiles: vi.fn() }));
vi.mock("./typeset-batch-api", () => ({
  refreshTypesetWork: vi.fn(async () => undefined),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
test("single ZIP accepts free image count and explicit preview ordering, then saves without submission", async () => {
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:fixture");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.mocked(uploadTypesetFiles).mockResolvedValue({
    id: "session",
    status: "previewed",
    files: [{ images: [{ id: "b" }] }, { images: [{ id: "a" }] }],
  } as never);
  const bodies: unknown[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url.endsWith("/preview-session"))
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
      files: [
        new File(
          [
            zipSync({
              "a.png": new Uint8Array([1, 2, 3]),
              "b.png": new Uint8Array([1, 2, 3]),
            }) as BlobPart,
          ],
          "1_成图.zip",
          { type: "application/zip" },
        ),
      ],
    },
  });
  await screen.findByText("2 · b.png");
  expect(uploadTypesetFiles).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "前移" })[1]);
  fireEvent.click(screen.getByRole("button", { name: "保存整份成图版本" }));
  await waitFor(() => expect(bodies.length).toBe(1));
  expect((bodies[0] as { mappings: unknown[] }).mappings).toEqual([
    { imageId: "b", workImageId: null, position: "free" },
    { imageId: "a", workImageId: null, position: "free" },
  ]);
  expect(urls.some((url) => url.includes("/stages/submit"))).toBe(false);
});

test("replays a committed single ZIP apply after its response is lost without rebinding an adopted preview", async () => {
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:fixture");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.mocked(uploadTypesetFiles).mockResolvedValue({
    id: "session",
    files: [{ images: [{ id: "a" }] }],
  } as never);
  let bound = 0;
  const applies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/preview-session")) {
        bound++;
        return applies.length
          ? Response.json(
              { message: "上传预览已采用，请先核对保存结果" },
              { status: 409 },
            )
          : Response.json({
              sessionId: "session",
              expectedRevision: 5,
              images: [],
            });
      }
      if (url.endsWith("/apply")) {
        applies.push(JSON.parse(String(init?.body)));
        return applies.length === 1
          ? new Response("<!DOCTYPE html>Gateway timeout", { status: 504 })
          : Response.json({ revision: 6, versionId: "adopted-version" });
      }
      return Response.json({ url: "/fixture.png" });
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SingleTypesetArchiveImport workId="work" revision={5} images={[]} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("导入单作品成图 ZIP"), {
    target: {
      files: [
        new File(
          [zipSync({ "a.png": new Uint8Array([1]) }) as BlobPart],
          "1_成图.zip",
        ),
      ],
    },
  });
  await screen.findByText("1 · a.png");
  fireEvent.click(screen.getByRole("button", { name: "保存整份成图版本" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "服务器响应超时",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存整份成图版本" }));
  await screen.findByText("单人成图版本已保存，请确认整份完整后提交嵌字");
  expect(uploadTypesetFiles).toHaveBeenCalledOnce();
  expect(bound).toBe(1);
  expect(applies).toHaveLength(2);
  expect(applies[1]).toEqual(applies[0]);
});
