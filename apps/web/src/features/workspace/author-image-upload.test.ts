import { afterEach, expect, test, vi } from "vitest";
import { client } from "../account/api";
import { AuthorImageUpload } from "./author-image-upload";

const ok = (data: unknown) => ({ data, response: new Response() }) as never;
const input = {
  purpose: "author_evidence" as const,
  resourceId: "author",
  expectedRevision: 1,
};
const file = (name: string) => {
  const result = new File([name], name, { type: "image/png" });
  Object.defineProperty(result, "arrayBuffer", {
    value: async () => new ArrayBuffer(4),
  });
  return result;
};
const session = (
  id: string,
  status = "pending",
  expiresAt = "2099-01-01T00:00:00Z",
) => ({
  id,
  status,
  expiresAt,
  error: null,
  files: [0, 1].map((index) => ({
    sourceName: `${index}.png`,
    upload:
      status === "pending"
        ? { url: `https://storage.invalid/${id}/${index}`, headers: {} }
        : null,
  })),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a missing receipt stops automatic uploads until explicit reset and file reselection", async () => {
  vi.stubGlobal("crypto", {
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 500 })),
  );
  const post = vi.spyOn(client, "POST").mockResolvedValue(ok(session("known")));
  vi.spyOn(client, "GET").mockResolvedValue({
    error: { message: "上传会话不存在" },
    response: new Response(null, { status: 404 }),
  } as never);
  const upload = new AuthorImageUpload();
  await expect(upload.upload(input, [file("one.png")])).rejects.toThrow(
    "上传失败",
  );
  expect(upload.resetUnknown()).toBe(false);
  await expect(upload.upload(input, [file("one.png")])).rejects.toThrow(/核对/);
  expect(upload.resultUnknown).toBe(true);
  expect(upload.locked).toBe(true);
  await expect(upload.upload(input, [file("one.png")])).rejects.toThrow(/核对/);
  expect(post).toHaveBeenCalledOnce();
  expect(upload.resetUnknown()).toBe(true);
  expect(upload.locked).toBe(false);
  expect(upload.resultUnknown).toBe(false);
  expect(post).toHaveBeenCalledOnce();
});

test.each(["permission", "network"])(
  "%s failure preserves recovery instead of permitting replacement",
  async (kind) => {
    vi.stubGlobal("crypto", {
      subtle: { digest: async () => new ArrayBuffer(32) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const post = vi
      .spyOn(client, "POST")
      .mockResolvedValue(ok(session("known")));
    const get = vi.spyOn(client, "GET");
    if (kind === "permission")
      get.mockResolvedValue({
        error: { message: "权限已变化" },
        response: new Response(null, { status: 403 }),
      } as never);
    else get.mockRejectedValue(new Error("网络中断"));
    const upload = new AuthorImageUpload();
    await expect(upload.upload(input, [file("one.png")])).rejects.toThrow();
    await expect(upload.upload(input, [file("one.png")])).rejects.toThrow();
    expect(upload.resultUnknown).toBe(false);
    expect(upload.locked).toBe(true);
    expect(upload.resetUnknown()).toBe(false);
    expect(post).toHaveBeenCalledOnce();
  },
);

test("a partial transfer retries only unfinished PUTs in the same attachment session", async () => {
  vi.stubGlobal("crypto", {
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response())
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValue(new Response());
  vi.stubGlobal("fetch", fetch);
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path) =>
      ok(
        session(
          "same",
          path === "/api/transfers/uploads" ? "pending" : "completed",
        ),
      ),
    );
  vi.spyOn(client, "GET").mockResolvedValue(ok(session("same")));
  const upload = new AuthorImageUpload();
  const files = [file("one.png"), file("two.png")];
  await expect(upload.upload(input, files)).rejects.toThrow("two.png");
  expect(upload.locked).toBe(true);
  await upload.upload(input, files);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://storage.invalid/same/0",
    "https://storage.invalid/same/1",
    "https://storage.invalid/same/1",
  ]);
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/transfers/uploads",
    ),
  ).toHaveLength(1);
  expect(upload.locked).toBe(false);
});

test("an expired pending session is replaced even before server cleanup changes its status", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubGlobal("crypto", {
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValue(new Response());
  vi.stubGlobal("fetch", fetch);
  let creates = 0;
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path) =>
      ok(
        path === "/api/transfers/uploads"
          ? session(
              `session-${++creates}`,
              "pending",
              creates === 1 ? "2026-01-01T01:00:00Z" : "2099-01-01T00:00:00Z",
            )
          : session("session-2", "completed"),
      ),
    );
  vi.spyOn(client, "GET").mockResolvedValue(
    ok({
      ...session("session-1", "pending", "2026-01-01T01:00:00Z"),
      files: [{ upload: null }],
    }),
  );
  const upload = new AuthorImageUpload();
  const files = [file("one.png")];
  await expect(upload.upload(input, files)).rejects.toThrow("上传失败");
  vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
  await upload.upload({ ...input, expectedRevision: 3 }, files);
  const createsCalls = (
    post.mock.calls as unknown as [
      string,
      { body: { expectedRevision: number } },
    ][]
  ).filter(([path]) => path === "/api/transfers/uploads");
  expect(createsCalls).toHaveLength(2);
  expect(createsCalls[1][1].body.expectedRevision).toBe(3);
});

test.each(["failed", "expired"])(
  "a terminal %s session releases the file selection and a new intent may upload",
  async (status) => {
    vi.stubGlobal("crypto", {
      subtle: { digest: async () => new ArrayBuffer(32) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response()),
    );
    let terminal = true;
    vi.spyOn(client, "POST").mockImplementation(async (path) =>
      ok(
        session(
          "upload",
          path === "/api/transfers/uploads"
            ? "pending"
            : terminal
              ? status
              : "completed",
        ),
      ),
    );
    const upload = new AuthorImageUpload();
    await expect(upload.upload(input, [file("first.png")])).rejects.toThrow();
    expect(upload.locked).toBe(false);
    terminal = false;
    const nextIntent = new AuthorImageUpload();
    await nextIntent.upload(input, [file("second.png")]);
  },
);

test("queued sessions remain the same session past expiry when completion has not yet been observed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubGlobal("crypto", {
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response()),
  );
  const post = vi
    .spyOn(client, "POST")
    .mockImplementation(async (path) =>
      ok(
        session(
          "same",
          path === "/api/transfers/uploads" ? "pending" : "queued",
          "2026-01-01T00:00:01Z",
        ),
      ),
    );
  const get = vi
    .spyOn(client, "GET")
    .mockRejectedValueOnce(new Error("网络中断"))
    .mockResolvedValue(ok(session("same", "completed")));
  const upload = new AuthorImageUpload();
  const files = [file("one.png")];
  const first = upload.upload(input, files);
  const rejected = expect(first).rejects.toThrow("网络中断");
  await vi.advanceTimersByTimeAsync(2_000);
  await rejected;
  expect(upload.locked).toBe(true);
  await upload.upload(input, files);
  expect(get).toHaveBeenCalledTimes(2);
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/transfers/uploads",
    ),
  ).toHaveLength(1);
});

test("a lost finalize response keeps the selection locked past local expiry until the server is inspected", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubGlobal("crypto", {
    subtle: { digest: async () => new ArrayBuffer(32) },
  });
  const fetch = vi.fn(async () => new Response());
  vi.stubGlobal("fetch", fetch);
  const post = vi.spyOn(client, "POST").mockImplementation(async (path) => {
    if (path === "/api/transfers/uploads/{id}/finalize")
      throw new Error("响应丢失");
    return ok(session("same", "pending", "2026-01-01T00:00:01Z"));
  });
  vi.spyOn(client, "GET").mockResolvedValue(ok(session("same", "completed")));
  const upload = new AuthorImageUpload();
  const files = [file("one.png")];
  await expect(upload.upload(input, files)).rejects.toThrow("响应丢失");
  vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
  expect(upload.locked).toBe(true);
  await upload.upload(input, files);
  expect(upload.locked).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (post.mock.calls as unknown as [string, unknown][]).filter(
      ([path]) => path === "/api/transfers/uploads",
    ),
  ).toHaveLength(1);
});
