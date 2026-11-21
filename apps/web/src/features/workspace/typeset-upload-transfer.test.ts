import { afterEach, expect, test, vi } from "vitest";
import {
  uploadTypesetFiles,
  extractTypesetSession,
} from "./typeset-upload-transfer";
import { client } from "../account/api";

vi.mock("../account/api", () => ({
  client: { POST: vi.fn(), GET: vi.fn() },
  unwrap: async (result: { data: unknown }) => result.data,
  authenticatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
vi.mock("./typeset-upload-plan", async (original) => ({
  ...(await original<object>()),
  uploadFileChecksum: vi.fn(async () => "a".repeat(64)),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const session = (status: string, failed = false) => ({
  id: "session",
  status,
  maxTotalBytes: 512 * 1024 * 1024,
  files: [
    {
      id: "f",
      sourceName: "21-001.png",
      status: failed
        ? "failed"
        : status === "previewed"
          ? "processed"
          : "pending",
      error: failed ? "图片无法解析" : null,
      upload: {
        url: "https://storage.invalid/file",
        method: "PUT",
        headers: {},
      },
      images: [],
    },
  ],
});
test("uploads bytes before queueing extraction and reuses the bounded background poll", async () => {
  vi.mocked(client.POST).mockImplementation(
    async (path) =>
      ({
        data: session(
          String(path).endsWith("extract") ? "extracting" : "pending",
        ),
      }) as never,
  );
  vi.mocked(client.GET).mockResolvedValue({
    data: session("previewed"),
  } as never);
  const direct = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", direct);
  vi.useFakeTimers();
  try {
    const pending = uploadTypesetFiles([new File(["x"], "21-001.png")]);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await pending).status).toBe("previewed");
    expect(direct).toHaveBeenCalledOnce();
    expect(client.GET).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
test("does not extract after a failed object upload and exposes a retryable filename", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("pending"),
  } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("gateway", { status: 502 })),
  );
  await expect(
    uploadTypesetFiles([new File(["x"], "21-001.png")]),
  ).rejects.toThrow("21-001.png");
  expect(client.POST).toHaveBeenCalledOnce();
});
test("does not present a partially processed session as a complete detail import", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("previewed", true),
  } as never);
  await expect(
    extractTypesetSession("session", { requireComplete: true }),
  ).rejects.toThrow("21-001.png：图片无法解析");
});

test("batch extraction retains partial successful files for grouping and recovery", async () => {
  const partial = session("previewed", true);
  vi.mocked(client.POST).mockResolvedValue({ data: partial } as never);
  expect(await extractTypesetSession("session")).toBe(partial);
});
for (const error of [
  new SyntaxError("Unexpected token '<'"),
  new TypeError("Failed to fetch"),
]) {
  test(`turns ${error.name} into a readable upload error`, async () => {
    vi.mocked(client.POST).mockRejectedValueOnce(error);
    await expect(
      uploadTypesetFiles([new File(["x"], "21-001.png")]),
    ).rejects.toThrow(/上传.*重试/);
  });
}
test("keeps business conflicts and cancellation intact", async () => {
  for (const error of [
    new Error("作品已更新，请刷新"),
    new DOMException("Aborted", "AbortError"),
  ]) {
    vi.mocked(client.POST).mockRejectedValueOnce(error);
    await expect(extractTypesetSession("session")).rejects.toBe(error);
  }
});

test("bounds object uploads to three and settles all bodies before extraction", async () => {
  const names = Array.from({ length: 7 }, (_, i) => `21-${i + 1}.png`);
  const makeSession = (processed: boolean) => ({
    ...session(processed ? "previewed" : "pending"),
    files: names.map((sourceName, i) => ({
      ...session(processed ? "previewed" : "pending").files[0],
      id: String(i),
      sourceName,
    })),
  });
  let active = 0,
    peak = 0;
  vi.mocked(client.POST).mockImplementation(async (path) => {
    if (String(path).endsWith("extract")) expect(active).toBe(0);
    return { data: makeSession(String(path).endsWith("extract")) } as never;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response(null, { status: 200 });
    }),
  );
  await uploadTypesetFiles(names.map((name) => new File(["x"], name)));
  expect(peak).toBe(3);
  expect(active).toBe(0);
});

test("restores a fully extracted session without creating another session or retransmitting bytes", async () => {
  vi.mocked(client.GET).mockResolvedValue({
    data: session("previewed"),
  } as never);
  const direct = vi.fn();
  vi.stubGlobal("fetch", direct);
  const restored = await uploadTypesetFiles([new File(["x"], "21-001.png")], {
    sessionId: "session",
  });
  expect(restored.status).toBe("previewed");
  expect(direct).not.toHaveBeenCalled();
  expect(client.POST).not.toHaveBeenCalled();
  expect(client.GET).toHaveBeenCalledTimes(1);
});
