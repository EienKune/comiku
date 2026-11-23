import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
beforeEach(() => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({
      width: 1200,
      height: 1800,
      close: vi.fn(),
    })),
  );
});
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
      contentType: "image/png",
      size: 1,
      checksum: "a".repeat(64),
      archive: false,
      uploadMissing: false,
      status: failed
        ? "failed"
        : status === "previewed"
          ? "processed"
          : "pending",
      error: failed ? "图片无法解析" : null,
      upload: {
        url: "https://storage.invalid/file",
        method: "PUT",
        headers: { "If-None-Match": "*" },
      },
      images: [],
    },
  ],
});
test("verifies a page immediately after its PUT and fetches the complete session once", async () => {
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
  const direct = vi.fn(async (url: string) =>
    url.endsWith("/verify")
      ? Response.json(session("previewed").files[0])
      : new Response(null, { status: 200 }),
  );
  vi.stubGlobal("fetch", direct);
  vi.useFakeTimers();
  try {
    const pending = uploadTypesetFiles([new File(["x"], "21-001.png")]);
    await vi.advanceTimersByTimeAsync(2100);
    expect((await pending).status).toBe("previewed");
    expect(direct).toHaveBeenCalledTimes(2);
    expect(direct.mock.calls[1][0]).toContain("/files/f/verify");
    expect(
      JSON.parse(
        String(
          (direct.mock.calls[1] as unknown as [string, RequestInit])[1].body,
        ),
      ),
    ).toEqual({ width: 1200, height: 1800 });
    expect(client.POST).toHaveBeenCalledOnce();
    expect(client.GET).toHaveBeenCalledOnce();
    expect(createImageBitmap).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("confirms an immutable 412 through the owned session instead of overwriting it", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("pending"),
  } as never);
  vi.mocked(client.GET).mockResolvedValue({
    data: session("previewed"),
  } as never);
  const direct = vi.fn(async (url: string) =>
    url.endsWith("/verify")
      ? Response.json(session("previewed").files[0])
      : new Response(null, { status: 412 }),
  );
  vi.stubGlobal("fetch", direct);
  await expect(
    uploadTypesetFiles([new File(["x"], "21-001.png")]),
  ).resolves.toMatchObject({ status: "previewed" });
  expect(direct).toHaveBeenCalledTimes(2);
});

test("rejects a same-named different file before adopting an existing session", async () => {
  const existing = session("previewed");
  existing.files[0].checksum = "b".repeat(64);
  vi.mocked(client.GET).mockResolvedValue({ data: existing } as never);
  const direct = vi.fn();
  vi.stubGlobal("fetch", direct);
  await expect(
    uploadTypesetFiles([new File(["x"], "21-001.png")], {
      sessionId: "session",
    }),
  ).rejects.toThrow("重试文件与上传会话不匹配");
  expect(direct).not.toHaveBeenCalled();
});

test("retries a lost verification reply against the same session without another PUT", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("pending"),
  } as never);
  vi.mocked(client.GET).mockResolvedValue({
    data: session("pending"),
  } as never);
  let checks = 0;
  const direct = vi.fn(async (url: string) => {
    if (!url.endsWith("/verify")) return new Response(null, { status: 200 });
    if (++checks === 1) throw new TypeError("Lost confirmation reply");
    return Response.json(session("previewed").files[0]);
  });
  vi.stubGlobal("fetch", direct);
  const file = new File(["x"], "21-001.png");
  await expect(uploadTypesetFiles([file])).rejects.toThrow("重试");
  vi.mocked(client.GET)
    .mockResolvedValueOnce({ data: session("pending") } as never)
    .mockResolvedValue({ data: session("previewed") } as never);
  await uploadTypesetFiles([file], { sessionId: "session" });
  expect(
    direct.mock.calls.filter(([url]) => !url.endsWith("/verify")),
  ).toHaveLength(1);
  expect(checks).toBe(2);
});

test("confirms an uncertain PUT before sending bytes again and only retries after explicit missing HEAD", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("pending"),
  } as never);
  vi.mocked(client.GET).mockResolvedValue({
    data: session("pending"),
  } as never);
  let puts = 0,
    checks = 0;
  const missing = {
    ...session("pending").files[0],
    status: "failed",
    uploadMissing: true,
    error: "文件尚未上传，请重试上传",
  };
  const direct = vi.fn(async (url: string) => {
    if (!url.endsWith("/verify")) {
      if (++puts === 1) throw new TypeError("PUT reply lost");
      return new Response(null, { status: 200 });
    }
    return Response.json(
      ++checks === 1 ? missing : session("previewed").files[0],
    );
  });
  vi.stubGlobal("fetch", direct);
  const file = new File(["x"], "21-001.png");
  await expect(uploadTypesetFiles([file])).rejects.toThrow("重试");
  await expect(
    uploadTypesetFiles([file], { sessionId: "session" }),
  ).rejects.toThrow("文件尚未上传");
  expect(puts).toBe(1);
  vi.mocked(client.GET)
    .mockResolvedValueOnce({
      data: { ...session("pending"), files: [missing] },
    } as never)
    .mockResolvedValue({ data: session("previewed") } as never);
  await uploadTypesetFiles([file], { sessionId: "session" });
  expect(puts).toBe(2);
  expect(checks).toBe(2);
});

test("does not accept an immutable 412 without successful authenticated verification", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("pending"),
  } as never);
  const direct = vi.fn(async (url: string) =>
    url.endsWith("/verify")
      ? Response.json({ message: "上传会话不存在" }, { status: 404 })
      : new Response(null, { status: 412 }),
  );
  vi.stubGlobal("fetch", direct);
  await expect(
    uploadTypesetFiles([new File(["x"], "21-001.png")]),
  ).rejects.toThrow("上传会话不存在");
  expect(client.GET).not.toHaveBeenCalled();
  expect(direct).toHaveBeenCalledTimes(2);
});

test("retains backend ZIP extraction without browser dimensions or per-image confirmation", async () => {
  const pending = {
    ...session("pending"),
    files: [
      {
        ...session("pending").files[0],
        sourceName: "21.zip",
        archive: true,
        contentType: "application/zip",
      },
    ],
  };
  const ready = {
    ...pending,
    status: "previewed",
    files: pending.files.map((file) => ({ ...file, status: "processed" })),
  };
  vi.mocked(client.POST)
    .mockResolvedValueOnce({ data: pending } as never)
    .mockResolvedValue({ data: ready } as never);
  const direct = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", direct);
  await expect(
    uploadTypesetFiles([new File(["x"], "21.zip")]),
  ).resolves.toMatchObject({ status: "previewed" });
  expect(createImageBitmap).not.toHaveBeenCalled();
  expect(direct).toHaveBeenCalledOnce();
  expect(vi.mocked(client.POST).mock.calls[1][0]).toBe(
    "/api/typeset/upload-sessions/{id}/extract",
  );
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

test("bounds independent object uploads to three and verification requests to two", async () => {
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
  vi.mocked(client.GET).mockResolvedValue({ data: makeSession(true) } as never);
  let verifying = 0,
    peakVerification = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/verify")) {
        verifying++;
        peakVerification = Math.max(peakVerification, verifying);
        await new Promise((resolve) => setTimeout(resolve, 1));
        verifying--;
        const id = url.split("/").at(-2)!;
        return Response.json(makeSession(true).files[Number(id)]);
      }
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
  expect(peakVerification).toBe(2);
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

test("resumes verification without retransmitting its active object and skips already verified neighbours", async () => {
  const ready = session("previewed");
  ready.files.push({
    ...ready.files[0],
    id: "second",
    sourceName: "21-002.png",
  });
  const pending = {
    ...ready,
    files: ready.files.map((file, index) =>
      index === 0 ? { ...file, status: "verifying", upload: null } : file,
    ),
  };
  vi.mocked(client.GET)
    .mockResolvedValueOnce({ data: pending } as never)
    .mockResolvedValue({ data: ready } as never);
  const direct = vi.fn(async () => Response.json(ready.files[0]));
  vi.stubGlobal("fetch", direct);
  await uploadTypesetFiles(
    [new File(["x"], "21-001.png"), new File(["x"], "21-002.png")],
    { sessionId: "session", requireComplete: true },
  );
  expect(direct).toHaveBeenCalledOnce();
  expect(direct.mock.calls[0]).toBeDefined();
  expect(client.POST).not.toHaveBeenCalled();
});

test("a blocked verification pool does not hold any of the three upload slots", async () => {
  const names = Array.from({ length: 7 }, (_, index) => `21-${index + 1}.png`);
  const files = names.map((sourceName, index) => ({
    ...session("pending").files[0],
    id: String(index),
    sourceName,
  }));
  vi.mocked(client.POST).mockResolvedValue({
    data: { ...session("pending"), files },
  } as never);
  vi.mocked(client.GET).mockResolvedValue({
    data: {
      ...session("previewed"),
      files: files.map((file) => ({ ...file, status: "processed" })),
    },
  } as never);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let puts = 0,
    verifications = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/verify")) {
        verifications++;
        await barrier;
        const index = Number(url.split("/").at(-2));
        return Response.json({ ...files[index], status: "processed" });
      }
      puts++;
      return new Response(null, { status: 200 });
    }),
  );
  const pending = uploadTypesetFiles(
    names.map((name) => new File(["x"], name)),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(puts).toBe(7);
    expect(verifications).toBe(2);
  } finally {
    release();
    await pending;
  }
});

test("only retransmits a failed file when its neighbouring page is already verified", async () => {
  const ready = session("previewed");
  ready.files.push({
    ...ready.files[0],
    id: "second",
    sourceName: "21-002.png",
  });
  vi.mocked(client.GET)
    .mockResolvedValueOnce({
      data: {
        ...ready,
        files: ready.files.map((file, index) =>
          index ? { ...file, status: "failed" } : file,
        ),
      },
    } as never)
    .mockResolvedValue({ data: ready } as never);
  const direct = vi.fn(async (url: string) =>
    url.endsWith("/verify")
      ? Response.json(ready.files[1])
      : new Response(null, { status: 200 }),
  );
  vi.stubGlobal("fetch", direct);
  await uploadTypesetFiles(
    [new File(["x"], "21-001.png"), new File(["x"], "21-002.png")],
    { sessionId: "session", requireComplete: true },
  );
  expect(direct).toHaveBeenCalledTimes(2);
  expect(direct.mock.calls[1][0]).toContain("/files/second/verify");
});

test("retries a busy verification slot without repeating its successful PUT", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("pending"),
  } as never);
  vi.mocked(client.GET).mockResolvedValue({
    data: session("previewed"),
  } as never);
  let puts = 0,
    checks = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.endsWith("/verify")) {
        puts++;
        return new Response(null, { status: 200 });
      }
      checks++;
      return checks === 1
        ? Response.json(
            { message: "当前图片验证繁忙，请稍后重试" },
            { status: 409 },
          )
        : Response.json(session("previewed").files[0]);
    }),
  );
  vi.useFakeTimers();
  try {
    const pending = uploadTypesetFiles([new File(["x"], "21-001.png")]);
    await vi.advanceTimersByTimeAsync(1100);
    await pending;
    expect(puts).toBe(1);
    expect(checks).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("cancellation aborts active validation and settles the queue without requesting a save-ready session", async () => {
  vi.mocked(client.POST).mockResolvedValue({
    data: session("pending"),
  } as never);
  const controller = new AbortController();
  let active = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/verify")) return new Response(null, { status: 200 });
      active++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            active--;
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    }),
  );
  const pending = uploadTypesetFiles([new File(["x"], "21-001.png")], {
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(active).toBe(1);
  controller.abort();
  await rejected;
  expect(active).toBe(0);
  expect(client.GET).not.toHaveBeenCalled();
});
