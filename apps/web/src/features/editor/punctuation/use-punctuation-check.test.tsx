import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { EditableTranslationImage } from "../draft-storage";
import { usePunctuationCheck } from "./use-punctuation-check";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const update = vi.fn();
function Fixture({
  ready = true,
  writable = true,
  epoch = 0,
  workId = "work",
  localOnly = false,
  canRepair,
}: {
  ready?: boolean;
  writable?: boolean;
  epoch?: number;
  workId?: string;
  localOnly?: boolean;
  canRepair?: () => boolean;
}) {
  const [page, setPage] = useState(0);
  const [images, setImages] = useState<EditableTranslationImage[]>(() =>
    [0, 1].map((index) => ({
      id: `image:${index}`,
      orderIndex: index,
      width: 100,
      height: 100,
      translationRevision: 0,
      entries: [
        {
          id: index ? "local:pending" : "saved",
          workImageId: `image:${index}`,
          orderIndex: 0,
          markerX: 0.5,
          markerY: 0.5,
          markerPositionType: "inside",
          translatedText: index ? "第二页？" : "😀老师！",
          note: null,
          revision: 0,
          localOnly: index > 0 && localOnly,
          createdById: "user",
          updatedById: "user",
          createdAt: "2026-11-18T00:00:00Z",
          updatedAt: "2026-11-18T00:00:00Z",
        },
      ],
    })),
  );
  const apply = (id: string, text: string) => {
    update(id, text);
    setImages((current) =>
      current.map((image) => ({
        ...image,
        entries: image.entries.map((entry) =>
          entry.id === id ? { ...entry, translatedText: text } : entry,
        ),
      })),
    );
  };
  const punctuation = usePunctuationCheck({
    scope: { workId, editorEpoch: epoch, latestVersionId: null },
    images,
    ready,
    writable,
    canRepair,
    getTextarea: (id) => document.querySelector(`textarea[data-entry="${id}"]`),
    onLocate: (result) =>
      setPage(images.findIndex((image) => image.id === result.imageId)),
    onUpdate: apply,
  });
  const entry = images[page].entries[0];
  return (
    <div
      onCompositionStartCapture={punctuation.compositionStart}
      onCompositionEndCapture={punctuation.compositionEnd}
    >
      {punctuation.tools}
      {punctuation.notice}
      <textarea
        aria-label="译文"
        data-entry={entry.id}
        value={entry.translatedText}
        disabled={!writable}
        onChange={(event) => apply(entry.id, event.target.value)}
      />
      <button onClick={() => apply("saved", "已修改！")}>异步修改</button>
      <button
        onClick={() =>
          setImages((current) =>
            current.map((image) => ({
              ...image,
              entries: image.entries.filter(
                (item) => item.id !== "local:pending",
              ),
            })),
          )
        }
      >
        删除第二页 Label
      </button>
    </div>
  );
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "检查标点" }));
  return screen.getByRole("dialog", { name: "标点检查" });
}
function mockNativeEdit() {
  const edit = vi.fn((_command: string, _ui: boolean, value: string) => {
    const node = document.activeElement as HTMLTextAreaElement;
    const next =
      node.value.slice(0, node.selectionStart) +
      value +
      node.value.slice(node.selectionEnd);
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(node, next);
    node.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value,
      }),
    );
    return true;
  });
  Object.defineProperty(document, "execCommand", {
    value: edit,
    configurable: true,
  });
  return edit;
}

test("checks the current unsaved draft across pages and locates the exact UTF-16 range without rewriting text", async () => {
  update.mockClear();
  render(<Fixture />);
  fireEvent.change(screen.getByLabelText("译文"), {
    target: { value: "😀草稿！" },
  });
  const dialog = open();
  expect(within(dialog).getByText(/已检查 2 页译文/)).toBeTruthy();
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(within(dialog).getAllByRole("button", { name: "定位" })[0]);
  const first = screen.getByLabelText("译文") as HTMLTextAreaElement;
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect([first.selectionStart, first.selectionEnd]).toEqual([4, 5]);
  expect(first.value).toBe("😀草稿！");
  const secondDialog = open();
  fireEvent.click(
    within(secondDialog).getAllByRole("button", { name: "定位" })[1],
  );
  const second = screen.getByLabelText("译文") as HTMLTextAreaElement;
  await waitFor(() => expect(document.activeElement).toBe(second));
  expect(second.value).toBe("第二页？");
  await waitFor(() =>
    expect([second.selectionStart, second.selectionEnd]).toEqual([3, 4]),
  );
  expect(update).toHaveBeenCalledTimes(1);
});

test("repairs through a native edit and existing update callback, with no state-only fallback", async () => {
  update.mockClear();
  const native = mockNativeEdit();
  render(<Fixture />);
  fireEvent.click(within(open()).getByRole("button", { name: "替换为 !" }));
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith("insertText", false, "!"),
  );
  expect(native.mock.results[0]).toMatchObject({ type: "return" });
  expect((screen.getByLabelText("译文") as HTMLTextAreaElement).value).toBe(
    "😀老师!",
  );
  expect(update).toHaveBeenCalledWith("saved", "😀老师!");
  expect(screen.getByText(/已替换，可在译文框中撤销/)).toBeTruthy();
  Object.defineProperty(document, "execCommand", {
    value: undefined,
    configurable: true,
  });
  const dialog = open();
  fireEvent.click(within(dialog).getByRole("button", { name: "替换为 ?" }));
  expect((screen.getByLabelText("译文") as HTMLTextAreaElement).value).toBe(
    "第二页？",
  );
  await waitFor(() =>
    expect(screen.getByText(/浏览器未能执行可撤销的替换/)).toBeTruthy(),
  );
});

test("invalidates changed text, deleted labels, different works and epochs before applying", () => {
  const native = mockNativeEdit();
  const { rerender } = render(<Fixture />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "异步修改" }));
  expect(
    (screen.getByRole("button", { name: "替换为 !" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "删除第二页 Label" }));
  expect(
    (screen.getByRole("button", { name: "替换为 ?" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  rerender(<Fixture epoch={1} workId="other" />);
  expect(screen.getAllByText("已失效")).toHaveLength(2);
  expect(native).not.toHaveBeenCalled();
});

test("blocks repair after permission loss and suppresses check and locate during IME composition", () => {
  const native = mockNativeEdit();
  const { rerender } = render(<Fixture />);
  const node = screen.getByLabelText("译文");
  fireEvent.compositionStart(node);
  fireEvent.click(screen.getByRole("button", { name: "检查标点" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.compositionEnd(node);
  open();
  fireEvent.compositionStart(node);
  fireEvent.click(screen.getAllByRole("button", { name: "定位" })[0]);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.compositionEnd(node);
  rerender(<Fixture writable={false} />);
  expect(
    (screen.getByRole("button", { name: "替换为 !" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(native).not.toHaveBeenCalled();
});

test("does not claim a completed check before all drafts are available", () => {
  render(<Fixture ready={false} />);
  expect(
    (screen.getByRole("button", { name: "检查标点" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByText("未发现所检查的标点问题。")).toBeNull();
});

test("checks pending local labels but retains the editor's wait-for-creation edit boundary", () => {
  const native = mockNativeEdit();
  render(<Fixture localOnly />);
  const dialog = open();
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
  expect(
    (
      within(dialog).getByRole("button", {
        name: "替换为 ?",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      within(dialog).getAllByRole("button", {
        name: "定位",
      })[1] as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(native).not.toHaveBeenCalled();
});

test("honors a live submission fence even before the parent rerenders", async () => {
  const native = mockNativeEdit();
  let submitting = false;
  render(<Fixture canRepair={() => !submitting} />);
  fireEvent.click(within(open()).getByRole("button", { name: "替换为 !" }));
  submitting = true;
  await waitFor(() =>
    expect(
      screen.getByText("目标已变化或当前不能操作，请重新检查。"),
    ).toBeTruthy(),
  );
  expect(native).not.toHaveBeenCalled();
});

test("rechecks scope and permission after cross-page navigation before a queued native edit", async () => {
  const native = mockNativeEdit();
  const { rerender } = render(<Fixture />);
  fireEvent.click(within(open()).getByRole("button", { name: "替换为 ?" }));
  rerender(<Fixture epoch={1} writable={false} />);
  await waitFor(() =>
    expect(
      screen.getByText("目标已变化或当前不能操作，请重新检查。"),
    ).toBeTruthy(),
  );
  expect(native).not.toHaveBeenCalled();
  expect((screen.getByLabelText("译文") as HTMLTextAreaElement).value).toBe(
    "第二页？",
  );
});
