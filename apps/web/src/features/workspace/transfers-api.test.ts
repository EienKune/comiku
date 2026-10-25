import { afterEach, expect, test, vi } from "vitest";
import { client } from "../account/api";
import { downloadPrepared, pollTransfer } from "./transfers-api";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("polling waits for background completion and surfaces terminal errors", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ status: "running" })
    .mockResolvedValueOnce({ status: "succeeded" });
  const pending = pollTransfer({ status: "queued" }, read, [
    "queued",
    "running",
  ]);
  await vi.advanceTimersByTimeAsync(4_000);
  expect((await pending).status).toBe("succeeded");
  expect(read).toHaveBeenCalledTimes(2);
  await expect(
    pollTransfer({ status: "failed", error: "作品已变化" }, read, ["queued"]),
  ).rejects.toThrow("作品已变化");
});

test("polling can be interrupted without issuing additional requests", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const read = vi.fn();
  const promise = pollTransfer(
    { status: "queued" },
    read,
    ["queued"],
    controller.signal,
  );
  const assertion = expect(promise).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await assertion;
  expect(read).not.toHaveBeenCalled();
});

test("download waits for the worker then explicitly delivers a signed URL without fetching a Blob", async () => {
  vi.useFakeTimers();
  const clicks: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.href);
  });
  const post = vi.spyOn(client, "POST").mockImplementation(
    async (path: string) =>
      ({
        data: path.endsWith("/deliver")
          ? {
              url: "https://storage.invalid/signed.zip",
              fileName: "8_嵌字交接.zip",
              expiresInSeconds: 300,
            }
          : { id: "job", status: "queued", fileName: null, error: null },
        response: new Response(),
      }) as never,
  );
  vi.spyOn(client, "GET").mockResolvedValue({
    data: {
      id: "job",
      status: "succeeded",
      fileName: "8_嵌字交接.zip",
      error: null,
    },
    response: new Response(),
  } as never);
  const promise = downloadPrepared({
    purpose: "handoff",
    workId: "work",
    expectedRevision: 4,
    expectedEditorEpoch: 2,
    idempotencyKey: "id",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(post).toHaveBeenCalledTimes(1);
  expect(clicks).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2_000);
  await promise;
  expect(post.mock.calls[1][0]).toBe("/api/transfers/downloads/{id}/deliver");
  expect(clicks).toEqual(["https://storage.invalid/signed.zip"]);
});
