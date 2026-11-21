import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useTypesetDetailUpload } from "./use-typeset-detail-upload";
import { uploadTypesetFiles } from "./typeset-upload-transfer";
import { collaborationRequest } from "./collaboration-request";

vi.mock("./typeset-upload-transfer", () => ({ uploadTypesetFiles: vi.fn() }));
vi.mock("./collaboration-request", () => ({ collaborationRequest: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("retries a lost binding response with the same staged session and requires a complete detail import", async () => {
  const file = new File(["x"], "21-001.png");
  vi.mocked(uploadTypesetFiles).mockImplementation(async (_files, options) => {
    const session = { id: "session", status: "previewed" } as never;
    options?.onSession?.(session);
    return session;
  });
  const preview = { sessionId: "session", expectedRevision: 5, images: [] };
  vi.mocked(collaborationRequest)
    .mockRejectedValueOnce(new Error("连接中断"))
    .mockResolvedValue(preview);
  const receive = vi.fn();
  const hook = renderHook(() => useTypesetDetailUpload("work", 5, "actor"));
  act(() => hook.result.current.choose([file], receive));
  await waitFor(() => expect(hook.result.current.retryable).toBe(true));
  act(() => hook.result.current.retry());
  await waitFor(() => expect(receive).toHaveBeenCalledWith(preview));
  expect(vi.mocked(uploadTypesetFiles).mock.calls[1][1]).toMatchObject({
    sessionId: "session",
    requireComplete: true,
  });
});

test("cancels the previous work scope before late upload completion can bind or replace another work's preview", async () => {
  let finish!: (value: never) => void;
  vi.mocked(uploadTypesetFiles).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const receive = vi.fn();
  const hook = renderHook(
    ({ workId }) => useTypesetDetailUpload(workId, 5, "actor"),
    { initialProps: { workId: "first" } },
  );
  act(() =>
    hook.result.current.choose([new File(["x"], "21-001.png")], receive),
  );
  const signal = vi.mocked(uploadTypesetFiles).mock.calls[0][1]?.signal;
  hook.rerender({ workId: "second" });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish({ id: "session" } as never);
  });
  expect(collaborationRequest).not.toHaveBeenCalled();
  expect(receive).not.toHaveBeenCalled();
  expect(hook.result.current.busy).toBe(false);
});
