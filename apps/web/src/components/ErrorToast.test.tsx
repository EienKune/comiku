import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorToast } from "./ErrorToast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("errors expire after five seconds without moving focus", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  render(
    <>
      <input aria-label="草稿" />
      <ErrorToast message="同步失败" onDismiss={onDismiss} />
    </>,
  );
  const input = screen.getByRole("textbox");
  input.focus();
  act(() => vi.advanceTimersByTime(4999));
  expect(onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(input);
});

test("hover pauses expiry and a new error gets its own timeout", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  const view = render(
    <ErrorToast message="第一条错误" onDismiss={onDismiss} />,
  );
  const notice = screen.getByRole("alert");
  act(() => vi.advanceTimersByTime(4000));
  fireEvent.pointerEnter(notice);
  view.rerender(
    <ErrorToast message="悬停期间的新错误" onDismiss={onDismiss} />,
  );
  act(() => vi.advanceTimersByTime(6000));
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.pointerLeave(notice);
  act(() => vi.advanceTimersByTime(4000));
  view.rerender(<ErrorToast message="第二条错误" onDismiss={onDismiss} />);
  act(() => vi.advanceTimersByTime(4999));
  expect(onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  view.unmount();
  act(() => vi.runAllTimers());
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("unmount cancels an outstanding expiry", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  const view = render(<ErrorToast message="请求失败" onDismiss={onDismiss} />);
  act(() => vi.advanceTimersByTime(1000));
  view.unmount();
  act(() => vi.runAllTimers());
  expect(onDismiss).not.toHaveBeenCalled();
});
