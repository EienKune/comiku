import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { client } from "../account/api";
import { CandidateImageEditor } from "./CandidateImageEditor";
vi.mock("../account/account-context", () => ({
  useAccount: () => ({ id: "actor" }),
}));
const candidate = {
  id: "post",
  revision: 2,
  authorName: "Artist",
  status: "pending",
  media: ["one", "two", "three"].map((id, orderIndex) => ({
    id,
    orderIndex,
    externalMediaId: id,
    width: null,
    height: null,
    mediaType: "image",
  })),
} as components["schemas"]["CandidateDto"];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.spyOn(client, "GET").mockResolvedValue({
    data: {
      url: "https://example.invalid/image.png",
      expiresInSeconds: 300,
      status: "ready",
    },
    response: new Response(),
  } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  const apply = vi.fn(),
    close = vi.fn(),
    reset = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <CandidateImageEditor
        candidate={candidate}
        onApply={apply}
        onClose={close}
        onResetSource={reset}
      />
    </QueryClientProvider>,
  );
  return { apply, close };
}
test("choosing and reordering submits only a local ordered subset; source stays complete", () => {
  const post = vi.spyOn(client, "POST");
  const { apply } = mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "选入原图 2" }));
  fireEvent.keyDown(
    screen.getByRole("button", { name: "拖动 原图 3 调整顺序" }),
    { key: "ArrowUp" },
  );
  fireEvent.click(screen.getByRole("button", { name: "应用调整" }));
  expect(apply).toHaveBeenCalledWith(["three", "one"]);
  expect(post).not.toHaveBeenCalled();
  expect(candidate.media).toHaveLength(3);
});
test("zero images cannot apply and Cancel never applies", () => {
  const { apply, close } = mount();
  for (const checkbox of screen.getAllByRole("checkbox"))
    fireEvent.click(checkbox);
  expect(
    (screen.getByRole("button", { name: "应用调整" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(close).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});
test("ordered thumbnail preview stays inside native editor and follows the chosen order", () => {
  const { close } = mount();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "拖动 原图 3 调整顺序" }),
    { key: "ArrowUp" },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "预览入库第 2 页，原图 3" }),
  );
  const editor = screen.getByRole("dialog", { name: "整理入库图片" }),
    preview = screen.getByRole("dialog", { name: /入库第 2 页（原图 3）/ });
  expect(editor.contains(preview)).toBe(true);
  fireEvent.keyDown(preview, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(within(editor).queryByRole("dialog")).toBeNull();
});
