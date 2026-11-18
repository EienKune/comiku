import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  act,
} from "@testing-library/react";
import { EditorShortcutDialog } from "./EditorShortcutDialog";
import {
  captureShortcut,
  defaultEditorShortcuts,
  editorShortcutStorageKey,
  readEditorShortcuts,
  shortcutLabel,
  validateEditorShortcuts,
  writeEditorShortcuts,
} from "./editor-shortcuts";
import { useEditorShortcuts } from "./use-editor-shortcuts";

beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("shortcut validation rejects duplicates, browser/editing combinations and malformed saved data", () => {
  expect(validateEditorShortcuts(defaultEditorShortcuts)).toBeNull();
  expect(
    validateEditorShortcuts({ ...defaultEditorShortcuts, pan: "2" }),
  ).toContain("相同");
  for (const key of [
    "Escape",
    "Tab",
    "Enter",
    " ",
    "F5",
    "Backspace",
    "Delete",
    "Control",
    "Shift",
    "Dead",
  ])
    expect(
      captureShortcut(new KeyboardEvent("keydown", { key })) ?? {},
    ).not.toHaveProperty("shortcut");
  for (const flags of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
  ])
    expect(
      captureShortcut(new KeyboardEvent("keydown", { key: "a", ...flags })),
    ).toHaveProperty("error");
  expect(
    captureShortcut(
      new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true }),
    ),
  ).toEqual({ shortcut: "Shift+ArrowUp" });
  expect(captureShortcut(new KeyboardEvent("keydown", { key: "A" }))).toEqual({
    shortcut: "a",
  });
  expect(
    captureShortcut(
      new KeyboardEvent("keydown", { key: "1", isComposing: true }),
    ),
  ).toBeNull();
  expect(shortcutLabel("Shift+ArrowUp")).toBe("Shift + ↑");
  for (const value of [
    "not json",
    "null",
    JSON.stringify({ version: 2, bindings: defaultEditorShortcuts }),
    JSON.stringify({ version: 1, bindings: { pan: "2" } }),
  ]) {
    localStorage.setItem(editorShortcutStorageKey("first"), value);
    expect(readEditorShortcuts("first").bindings).toEqual(
      defaultEditorShortcuts,
    );
  }
});

test("settings persist by account, survive reload and fail gracefully without browser storage", () => {
  const custom = { ...defaultEditorShortcuts, pan: "g" };
  expect(writeEditorShortcuts("first", custom)).toBeNull();
  expect(readEditorShortcuts("first").bindings).toEqual(custom);
  expect(readEditorShortcuts("second").bindings).toEqual(
    defaultEditorShortcuts,
  );
  expect(
    JSON.parse(localStorage.getItem(editorShortcutStorageKey("first"))!)
      .version,
  ).toBe(1);
  const hook = renderHook(({ accountId }) => useEditorShortcuts(accountId), {
    initialProps: { accountId: "first" },
  });
  expect(hook.result.current.bindings.pan).toBe("g");
  hook.rerender({ accountId: "second" });
  expect(hook.result.current.bindings.pan).toBe("1");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  act(() => {
    expect(hook.result.current.save(custom)).toContain("本次页面内仍然生效");
  });
  expect(hook.result.current.bindings.pan).toBe("g");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(readEditorShortcuts("third").bindings).toEqual(defaultEditorShortcuts);
  expect(readEditorShortcuts("third").notice).toContain("无法读取");
});

test("dialog captures keys, reports conflicts, resets defaults, saves and restores opener focus", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const save = vi.fn(() => null);
  const close = vi.fn();
  const view = render(
    <EditorShortcutDialog
      bindings={defaultEditorShortcuts}
      notice={null}
      onSave={save}
      onClose={close}
    />,
  );
  const pan = screen.getByLabelText("移动画布快捷键");
  expect(document.activeElement).toBe(pan);
  fireEvent.keyDown(pan, { key: "2" });
  expect(screen.getByRole("alert").textContent).toContain("相同");
  expect(
    (screen.getByRole("button", { name: "保存快捷键" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(pan, { key: "r", ctrlKey: true });
  expect(screen.getByRole("alert").textContent).toContain("已保留");
  fireEvent.keyDown(pan, { key: "g" });
  expect((pan as HTMLInputElement).value).toBe("G");
  const tab = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(pan, tab);
  expect(tab.defaultPrevented).toBe(false);
  fireEvent.keyDown(pan, { key: "q", isComposing: true });
  expect((pan as HTMLInputElement).value).toBe("G");
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  expect((pan as HTMLInputElement).value).toBe("1");
  fireEvent.keyDown(pan, { key: "g" });
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  expect(save).toHaveBeenCalledWith({ ...defaultEditorShortcuts, pan: "g" });
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

test("unavailable persistence keeps settings dialog open with a status and Escape cancels", () => {
  const close = vi.fn();
  render(
    <EditorShortcutDialog
      bindings={defaultEditorShortcuts}
      notice={null}
      onSave={() => "浏览器无法保存"}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存快捷键" }));
  expect(screen.getByRole("status").textContent).toContain("无法保存");
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});
