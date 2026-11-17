import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ReferenceDictionaryDialog } from "./ReferenceDictionaryDialog";
import { searchReferenceDictionary } from "./reference-dictionary-api";

vi.mock("./reference-dictionary-api", () => ({
  searchReferenceDictionary: vi.fn(),
}));
const search = vi.mocked(searchReferenceDictionary);
const entry = {
  id: "synthetic-1",
  original: "カチッ",
  explanationZh: "合成中文词义",
  explanationJa: "日本語の説明",
  translationZh: null,
  notes: "合成备注",
  sourceRef: "Sheet1:B2",
  source: {
    key: "synthetic",
    name: "合成参考",
    version: "1",
    sourceUrl: null,
    attribution: "测试署名",
    license: "测试许可",
  },
};
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>拟声词</button>
      {open && <ReferenceDictionaryDialog onClose={() => setOpen(false)} />}
    </>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  search.mockReset();
  search.mockResolvedValue({ entries: [], nextOffset: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function tick(ms = 200) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function open() {
  const button = screen.getByRole("button", { name: "拟声词" });
  button.focus();
  fireEvent.click(button);
  return button;
}

test("opens a native dialog with search focus, does not read an empty query, restores opener on Escape under StrictMode", async () => {
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  const opener = open();
  expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  await tick(1000);
  expect(search).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("debounces input, aborts on query change and close, ignores a stale resolved response", async () => {
  let resolveOld!: (value: {
    entries: (typeof entry)[];
    nextOffset: null;
  }) => void;
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  render(<Fixture />);
  open();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "旧" } });
  await tick(199);
  expect(search).not.toHaveBeenCalled();
  await tick(1);
  const signal = search.mock.calls[0][2];
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "新" } });
  expect(signal.aborted).toBe(true);
  await tick();
  await act(async () => {
    resolveOld({ entries: [entry], nextOffset: null });
  });
  expect(screen.queryByText("カチッ")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(search.mock.calls[1][2].aborted).toBe(true);
});

test("keeps independent senses and sources, distinguishes meanings from nullable suggestions and appends the next 20-record page", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  search.mockResolvedValueOnce({
    entries: [
      entry,
      {
        ...entry,
        id: "synthetic-2",
        translationZh: "咔哒",
        sourceRef: "line:4",
      },
    ],
    nextOffset: 20,
  });
  search.mockResolvedValueOnce({
    entries: [{ ...entry, id: "synthetic-3", original: "コツコツ" }],
    nextOffset: null,
  });
  render(<Fixture />);
  open();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "カチッ" },
  });
  await tick();
  expect(screen.getAllByText("カチッ")).toHaveLength(2);
  expect(screen.getAllByText("合成中文词义")).toHaveLength(2);
  expect(screen.getAllByText("日本語の説明")).toHaveLength(2);
  expect(screen.getByText(/Sheet1:B2/)).toBeTruthy();
  expect(screen.getByText(/line:4/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "复制汉化" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "复制汉化" }));
  await tick(0);
  expect(copy).toHaveBeenCalledWith("咔哒");
  fireEvent.click(screen.getByRole("button", { name: "继续加载" }));
  await tick(0);
  expect(search.mock.calls[1].slice(0, 2)).toEqual(["カチッ", 20]);
  expect(screen.getAllByText("カチッ")).toHaveLength(2);
  expect(screen.getByText("コツコツ")).toBeTruthy();
});

test("shows an explicit retry after failure and clears old results as soon as query changes", async () => {
  search.mockRejectedValueOnce(new Error("合成读取失败"));
  search.mockResolvedValueOnce({ entries: [entry], nextOffset: null });
  render(<Fixture />);
  open();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "音" } });
  await tick();
  expect(screen.getByRole("alert").textContent).toContain("合成读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await tick();
  expect(screen.getByText("カチッ")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: " " } });
  expect(screen.queryByText("カチッ")).toBeNull();
  await tick();
  expect(search).toHaveBeenCalledTimes(2);
});
