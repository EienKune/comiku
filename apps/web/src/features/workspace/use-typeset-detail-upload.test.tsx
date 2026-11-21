import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useTypesetDetailUpload } from "./use-typeset-detail-upload";
import { uploadTypesetFiles } from "./typeset-upload-transfer";
import { collaborationRequest } from "./collaboration-request";
import { prepareLocalTypesetImages } from "./typeset-local-files";
vi.mock("./typeset-upload-transfer", () => ({ uploadTypesetFiles: vi.fn() }));
vi.mock("./collaboration-request", () => ({ collaborationRequest: vi.fn() }));
vi.mock("./typeset-local-files", () => ({
  prepareLocalTypesetImages: vi.fn(),
  releaseLocalTypesetImages: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("local preview sends no bytes, saves only selected pages and reuses verified files after a lost binding response", async () => {
  const files = [new File(["x"], "21-001.png"), new File(["y"], "21-002.png")];
  vi.mocked(prepareLocalTypesetImages).mockResolvedValue(
    files.map((file, index) => ({
      id: `local${index}`,
      file,
      sourceName: file.name,
      pageNumber: index + 1,
      localUrl: "blob:fixture",
    })) as never,
  );
  vi.mocked(uploadTypesetFiles).mockImplementation(async (_files, options) => {
    const session = {
      id: "session",
      status: "previewed",
      files: [{ images: [{ id: "remote" }] }],
    } as never;
    options?.onSession?.(session);
    return session;
  });
  vi.mocked(collaborationRequest)
    .mockRejectedValueOnce(new Error("连接中断"))
    .mockResolvedValue({
      sessionId: "session",
      expectedRevision: 5,
      images: [],
    });
  const receive = vi.fn();
  const hook = renderHook(() => useTypesetDetailUpload("work", 5, "actor"));
  act(() => hook.result.current.choose(files, receive));
  await waitFor(() => expect(receive).toHaveBeenCalledOnce());
  expect(uploadTypesetFiles).not.toHaveBeenCalled();
  await act(async () => {
    await expect(hook.result.current.prepare(["local1"])).rejects.toThrow(
      "连接中断",
    );
  });
  await act(async () => {
    expect(await hook.result.current.prepare(["local1"])).toMatchObject({
      imageIds: { local1: "remote" },
    });
  });
  expect(vi.mocked(uploadTypesetFiles).mock.calls[0][0]).toEqual([files[1]]);
  expect(vi.mocked(uploadTypesetFiles).mock.calls[1][1]).toMatchObject({
    sessionId: "session",
    requireComplete: true,
  });
});

test("cancels a previous work's local expansion and discards its late preview", async () => {
  let finish!: (value: never) => void;
  vi.mocked(prepareLocalTypesetImages).mockImplementation(
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
  const signal = vi.mocked(prepareLocalTypesetImages).mock.calls[0][1]?.signal;
  hook.rerender({ workId: "second" });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish([] as never);
  });
  expect(uploadTypesetFiles).not.toHaveBeenCalled();
  expect(receive).not.toHaveBeenCalled();
  expect(hook.result.current.busy).toBe(false);
});

test("keeps the original bound revision for receipt replay until the user explicitly rebinds", async () => {
  const file = new File(["x"], "21-001.png");
  vi.mocked(prepareLocalTypesetImages).mockResolvedValue([
    { id: "local", file, sourceName: file.name, localUrl: "blob:fixture" },
  ] as never);
  vi.mocked(uploadTypesetFiles).mockImplementation(async (_files, options) => {
    const session = {
      id: "session",
      files: [{ images: [{ id: "remote" }] }],
    } as never;
    options?.onSession?.(session);
    return session;
  });
  vi.mocked(collaborationRequest).mockImplementation(async (_url, init) => ({
    sessionId: "session",
    expectedRevision: JSON.parse(String(init?.body)).expectedRevision,
    images: [],
  }));
  const receive = vi.fn();
  const hook = renderHook(
    ({ revision }) => useTypesetDetailUpload("work", revision, "actor"),
    { initialProps: { revision: 5 } },
  );
  act(() => hook.result.current.choose([file], receive));
  await waitFor(() => expect(receive).toHaveBeenCalledOnce());
  await act(async () => {
    expect(
      (await hook.result.current.prepare(["local"])).expectedRevision,
    ).toBe(5);
  });
  hook.rerender({ revision: 6 });
  await act(async () => {
    expect(
      (await hook.result.current.prepare(["local"])).expectedRevision,
    ).toBe(5);
  });
  expect(uploadTypesetFiles).toHaveBeenCalledOnce();
  expect(collaborationRequest).toHaveBeenCalledOnce();
  await act(async () => {
    expect(
      (await hook.result.current.prepare(["local"], { rebind: true }))
        .expectedRevision,
    ).toBe(6);
  });
  expect(vi.mocked(uploadTypesetFiles).mock.calls[1][1]?.sessionId).toBe(
    "session",
  );
  expect(
    JSON.parse(String(vi.mocked(collaborationRequest).mock.calls[1][1]?.body))
      .rebind,
  ).toBe(true);
});
