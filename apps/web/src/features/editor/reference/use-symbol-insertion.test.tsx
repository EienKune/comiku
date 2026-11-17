import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useSymbolInsertion } from "./use-symbol-insertion";

const update = vi.fn();
const copy = vi.fn();
function Fixture({
  scope = "image-1",
  writable = true,
  localOnly = false,
  removed = false,
}: {
  scope?: string;
  writable?: boolean;
  localOnly?: boolean;
  removed?: boolean;
}) {
  const [text, setText] = useState("甲乙丙");
  const [selectedEntryId, setSelected] = useState<string | null>("entry-1");
  const insertion = useSymbolInsertion({
    scope,
    writable,
    selectedEntryId,
    entries: removed
      ? []
      : [{ id: "entry-1", translatedText: text, localOnly }],
    onUpdate: (id, value) => {
      update(id, value);
      setText(value);
    },
  });
  return (
    <>
      {!removed && (
        <textarea
          aria-label="译文"
          value={text}
          disabled={!writable || localOnly}
          {...insertion.bindTextarea("entry-1")}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <textarea aria-label="备注" />
      <button onClick={() => setSelected("entry-2")}>选择其他条目</button>
      <div data-editor-reference-tools>
        <button onClick={() => void insertion.insert("☆")}>符号</button>
      </div>
      <p role="status">{insertion.status}</p>
    </>
  );
}
beforeEach(() => {
  copy.mockReset().mockResolvedValue(undefined);
  update.mockReset();
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function select(start = 1, end = 2) {
  const area = screen.getByLabelText("译文") as HTMLTextAreaElement;
  area.focus();
  area.setSelectionRange(start, end);
  fireEvent.select(area);
  return area;
}
async function insert() {
  fireEvent.click(screen.getByRole("button", { name: "符号" }));
  await act(async () => {});
}

test("replaces only the confirmed textarea range through state and retains the new caret for repeated insertion", async () => {
  render(<Fixture />);
  const area = select();
  await insert();
  expect(area.value).toBe("甲☆丙");
  expect(update).toHaveBeenLastCalledWith("entry-1", "甲☆丙");
  expect(area.selectionStart).toBe(2);
  screen.getByRole("button", { name: "符号" }).focus();
  await insert();
  expect(area.value).toBe("甲☆☆丙");
  expect(copy).not.toHaveBeenCalled();
});
test("no confirmed target and focus moving to a note offer clipboard instead of changing translation", async () => {
  render(<Fixture />);
  await insert();
  expect(copy).toHaveBeenCalledWith("☆");
  select();
  (screen.getByLabelText("备注") as HTMLTextAreaElement).focus();
  await insert();
  expect(update).not.toHaveBeenCalled();
  expect(copy).toHaveBeenCalledTimes(2);
});

test("records the latest input value and caret after a paste without relying on a keyup event", async () => {
  render(<Fixture />);
  const area = select();
  fireEvent.input(area, {
    target: { value: "新粘贴内容", selectionStart: 2, selectionEnd: 2 },
  });
  screen.getByRole("button", { name: "符号" }).focus();
  await insert();
  expect(area.value).toBe("新粘☆贴内容");
  expect(copy).not.toHaveBeenCalled();
});
test.each(["image", "entry", "deleted", "readonly", "local"])(
  "invalidates the old target on %s context change and never revives it",
  async (kind) => {
    const { rerender } = render(<Fixture />);
    select();
    if (kind === "entry")
      fireEvent.click(screen.getByRole("button", { name: "选择其他条目" }));
    else
      rerender(
        <Fixture
          scope={kind === "image" ? "image-2" : "image-1"}
          removed={kind === "deleted"}
          writable={kind !== "readonly"}
          localOnly={kind === "local"}
        />,
      );
    await insert();
    expect(update).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith("☆");
    rerender(<Fixture />);
    await insert();
    expect(update).not.toHaveBeenCalled();
  },
);
test("does not insert during IME composition and can insert after explicit composition end", async () => {
  render(<Fixture />);
  const area = select();
  fireEvent.compositionStart(area);
  await insert();
  expect(update).not.toHaveBeenCalled();
  expect(copy).toHaveBeenCalledWith("☆");
  fireEvent.compositionEnd(area);
  await insert();
  expect(area.value).toBe("甲☆丙");
});
test("keeps IME composition fenced when partial input changes the controlled value", async () => {
  render(<Fixture />);
  const area = select();
  fireEvent.compositionStart(area);
  fireEvent.change(area, { target: { value: "甲入力丙" } });
  area.setSelectionRange(3, 3);
  fireEvent.select(area);
  fireEvent.keyUp(area, { key: "Process", isComposing: true });
  await insert();
  expect(update).not.toHaveBeenCalled();
  expect(copy).toHaveBeenCalledWith("☆");
});
test("leaving the browser invalidates a saved selection", async () => {
  render(<Fixture />);
  select();
  fireEvent(window, new Event("blur"));
  await insert();
  expect(update).not.toHaveBeenCalled();
  expect(copy).toHaveBeenCalledWith("☆");
});
test("opening a reference control preserves target but a disconnected textarea cannot be used", async () => {
  const { unmount } = render(<Fixture />);
  const area = select();
  screen.getByRole("button", { name: "符号" }).focus();
  await insert();
  expect(area.value).toBe("甲☆丙");
  unmount();
  render(<Fixture />);
  await insert();
  expect(update).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledWith("☆");
});
