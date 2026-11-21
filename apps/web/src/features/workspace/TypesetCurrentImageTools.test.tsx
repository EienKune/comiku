import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TypesetCurrentImageTools } from "./TypesetCurrentImageTools";
import { uploadTypesetFiles } from "./typeset-upload-transfer";
vi.mock("./typeset-upload-transfer", () => ({ uploadTypesetFiles: vi.fn() }));
vi.mock("./typeset-batch-api", () => ({
  refreshTypesetWork: vi.fn(async () => undefined),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("single pending-publication tools add an explicit cover and confirm removal using the current immutable version", async () => {
  vi.mocked(uploadTypesetFiles).mockResolvedValue({
    id: "session",
    files: [{ images: [{ id: "verified-image" }] }],
  } as never);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:fixture");
      static revokeObjectURL = vi.fn();
    },
  );
  const requests: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/versions"))
        return Response.json({
          items: [
            {
              id: "version",
              images: [{ id: "cover", supplementId: "stable-cover" }],
            },
          ],
        });
      if (url.endsWith("/url")) return Response.json({ url: "/fixture.png" });
      return Response.json({});
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TypesetCurrentImageTools
        workId="work"
        versionId="version"
        imageId="cover"
        workImageId={null}
        images={[]}
        revision={9}
        canReplace
      />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "删除当前补充图" });
  fireEvent.change(screen.getByLabelText("新增单人补充成品图"), {
    target: {
      files: [new File(["image"], "cover.png", { type: "image/png" })],
    },
  });
  expect(await screen.findByAltText("待新增补充图预览")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认新增补充图" }));
  await waitFor(() =>
    expect(
      requests.some(
        (r) =>
          r.url.endsWith("/supplements/from-session") &&
          r.init?.method === "POST",
      ),
    ).toBe(true),
  );
  const add = requests.find(
    (r) =>
      r.url.endsWith("/supplements/from-session") && r.init?.method === "POST",
  )!;
  const body = JSON.parse(String(add.init?.body));
  expect(body).toMatchObject({
    position: "end",
    expectedRevision: 9,
    sessionId: "session",
    uploadImageId: "verified-image",
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "删除当前补充图",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "删除当前补充图" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /^删除补充图$/ }));
  await waitFor(() =>
    expect(
      requests.some((r) => r.url.endsWith("/supplements/cover/delete")),
    ).toBe(true),
  );
  const remove = requests.find((r) =>
    r.url.endsWith("/supplements/cover/delete"),
  )!;
  expect(JSON.parse(String(remove.init?.body)).expectedRevision).toBe(9);
});
