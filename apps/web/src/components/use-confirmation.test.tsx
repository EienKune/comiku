import { StrictMode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useConfirmation } from "./use-confirmation";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

test("an obsolete callback cannot open a confirmation after its owner unmounts", async () => {
  const { result, unmount } = renderHook(() => useConfirmation([1]));
  const confirm = result.current.confirm;
  unmount();
  expect(
    await confirm({
      title: "删除？",
      description: "移除内容",
      confirmLabel: "删除",
    }),
  ).toBe(false);
});
function Fixture({
  revision = 1,
  allowed = true,
  onApproved,
}: {
  revision?: number;
  allowed?: boolean;
  onApproved: () => void;
}) {
  const confirmation = useConfirmation([revision, allowed]);
  async function submit() {
    if (
      allowed &&
      (await confirmation.confirm({
        title: "切回单人模式？",
        description: "每个阶段至多保留一名参与者。",
        confirmLabel: "切回单人模式",
      }))
    )
      onApproved();
  }
  return (
    <>
      <button onClick={() => void submit()}>切换模式</button>
      {confirmation.dialog}
    </>
  );
}
test("approval writes once, rejects duplicate requests, and restores the opener under StrictMode", async () => {
  const write = vi.fn();
  render(
    <StrictMode>
      <Fixture onApproved={write} />
    </StrictMode>,
  );
  const opener = screen.getByRole("button", { name: "切换模式" });
  opener.focus();
  fireEvent.click(opener);
  fireEvent.click(opener);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "取消" }),
  );
  expect(write).not.toHaveBeenCalled();
  fireEvent(screen.getByRole("dialog"), new Event("close"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  const approve = screen.getByRole("button", { name: "切回单人模式" });
  approve.focus();
  fireEvent.keyDown(approve, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "取消" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(approve);
  fireEvent.click(approve);
  fireEvent.click(approve);
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(document.activeElement).toBe(opener);
});
test.each(["button", "escape", "close"])(
  "%s cancels without a write",
  async (method) => {
    const write = vi.fn();
    render(<Fixture onApproved={write} />);
    fireEvent.click(screen.getByRole("button", { name: "切换模式" }));
    if (method === "button")
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    else {
      const dialog = screen.getByRole("dialog");
      if (method === "close") dialog.removeAttribute("open");
      fireEvent(
        dialog,
        new Event(method === "escape" ? "cancel" : "close", {
          cancelable: true,
        }),
      );
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(write).not.toHaveBeenCalled();
  },
);
test.each(["revision", "permission", "unmount"])(
  "invalidates a pending approval after %s changes",
  async (change) => {
    const write = vi.fn();
    const view = render(<Fixture onApproved={write} />);
    fireEvent.click(screen.getByRole("button", { name: "切换模式" }));
    const approve = screen.getByRole("button", { name: "切回单人模式" });
    if (change === "unmount") view.unmount();
    else
      view.rerender(
        <Fixture
          revision={change === "revision" ? 2 : 1}
          allowed={change !== "permission"}
          onApproved={write}
        />,
      );
    fireEvent.click(approve);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(write).not.toHaveBeenCalled();
  },
);
