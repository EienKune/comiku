import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useBirthdayQuery } from "./use-birthday-query";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const today = () =>
  new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

function Panel({
  name,
  read,
  enabled = true,
}: {
  name: string;
  read: (signal: AbortSignal) => Promise<string>;
  enabled?: boolean;
}) {
  const result = useBirthdayQuery(name, enabled, read);
  return <output aria-label={name}>{result.data ?? "loading"}</output>;
}
function mount(children: ReactNode) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return {
    ...render(
      <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
    ),
    cache,
  };
}
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
function visibility(hidden: boolean) {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
function clock(time = "2026-11-11T15:59:50Z") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(time));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
}

test("short background crossing Shanghai midnight refreshes summary and calendar once despite fresh cache", async () => {
  clock();
  const summary = vi.fn(async () => today());
  const calendar = vi.fn(async () => today());
  mount(
    <>
      <Panel name="summary" read={summary} />
      <Panel name="calendar" read={calendar} />
    </>,
  );
  await advance(0);
  expect(summary).toHaveBeenCalledTimes(1);
  expect(calendar).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("summary").textContent).toBe("2026-11-11");
  await advance(5_000);
  visibility(true);
  await advance(15_000);
  expect(summary).toHaveBeenCalledTimes(1);
  expect(calendar).toHaveBeenCalledTimes(1);
  visibility(false);
  await advance(0);
  expect(summary).toHaveBeenCalledTimes(2);
  expect(calendar).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("summary").textContent).toBe("2026-11-12");
  expect(screen.getByLabelText("calendar").textContent).toBe("2026-11-12");
  await advance(120_000);
  expect(summary).toHaveBeenCalledTimes(2);
  expect(calendar).toHaveBeenCalledTimes(2);
});

test("same-day visibility changes preserve fresh data without extra requests", async () => {
  clock("2026-11-11T03:00:00Z");
  const read = vi.fn(async () => today());
  mount(<Panel name="summary" read={read} />);
  await advance(0);
  await advance(5_000);
  visibility(true);
  await advance(15_000);
  visibility(false);
  await advance(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("summary").textContent).toBe("2026-11-11");
});

test("foreground midnight refreshes once and a same-day resume does not repeat it", async () => {
  clock("2026-11-11T15:59:59Z");
  const read = vi.fn(async () => today());
  mount(<Panel name="summary" read={read} />);
  await advance(0);
  await advance(900);
  expect(read).toHaveBeenCalledTimes(1);
  await advance(300);
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("summary").textContent).toBe("2026-11-12");
  visibility(true);
  await advance(1_000);
  visibility(false);
  await advance(0);
  expect(read).toHaveBeenCalledTimes(2);
});

test.each([false, true])(
  "a disabled calendar stays lazy across midnight and fetches once on reopening (cached: %s)",
  async (cached) => {
    clock();
    const summary = vi.fn(async () => today());
    const calendar = vi.fn(async () => today());
    const panels = (enabled: boolean) => (
      <>
        <Panel name="summary" read={summary} />
        <Panel name="calendar" enabled={enabled} read={calendar} />
      </>
    );
    const view = mount(panels(cached));
    await advance(0);
    const calendarReads = cached ? 1 : 0;
    expect(calendar).toHaveBeenCalledTimes(calendarReads);
    view.rerender(
      <QueryClientProvider client={view.cache}>
        {panels(false)}
      </QueryClientProvider>,
    );
    visibility(true);
    await advance(20_000);
    visibility(false);
    await advance(0);
    expect(summary).toHaveBeenCalledTimes(2);
    expect(calendar).toHaveBeenCalledTimes(calendarReads);
    view.rerender(
      <QueryClientProvider client={view.cache}>
        {panels(true)}
      </QueryClientProvider>,
    );
    await advance(0);
    expect(calendar).toHaveBeenCalledTimes(calendarReads + 1);
    expect(summary).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("calendar").textContent).toBe("2026-11-12");
  },
);

test("hidden queries abort in-flight reads and unmount clears midnight work", async () => {
  clock();
  let signal: AbortSignal | undefined;
  const read = vi.fn((nextSignal: AbortSignal) => {
    signal = nextSignal;
    return new Promise<string>(() => {});
  });
  const view = mount(<Panel name="summary" read={read} />);
  await advance(0);
  expect(signal?.aborted).toBe(false);
  visibility(true);
  expect(signal?.aborted).toBe(true);
  view.unmount();
  await advance(20_000);
  expect(read).toHaveBeenCalledTimes(1);
});

test("an inactive settings observer does not cancel the visible editor's shared read", async () => {
  clock();
  let signal: AbortSignal | undefined;
  const read = vi.fn((nextSignal: AbortSignal) => {
    signal = nextSignal;
    return new Promise<string>(() => {});
  });
  const panels = (secondEnabled: boolean) => (
    <>
      <Panel name="settings" read={read} />
      <Panel name="settings" read={read} enabled={secondEnabled} />
    </>
  );
  const view = mount(panels(true));
  await advance(0);
  view.rerender(
    <QueryClientProvider client={view.cache}>
      {panels(false)}
    </QueryClientProvider>,
  );
  expect(signal?.aborted).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  visibility(true);
  expect(signal?.aborted).toBe(true);
});
