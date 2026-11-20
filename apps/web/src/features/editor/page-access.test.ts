import { afterEach, expect, test, vi } from "vitest";
import type { components } from "@comiku/api-client";
import { acquireImportPageLeases, requestPageLease } from "./page-access";

type Image = components["schemas"]["TranslationImageDraftDto"];
const images = [0, 1].map((orderIndex) => ({
  id: `page-${orderIndex + 1}`,
  orderIndex,
  translationRevision: 2,
  entries: [],
})) as unknown as Image[];
const options = {
  workId: "work",
  editorInstanceId: "instance",
  editorEpoch: 3,
  images,
  targetIds: images.map((image) => image.id),
};
const fresh = (image: Image) => ({
  leaseToken: `token-${image.id}`,
  editorEpoch: 3,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  image,
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("pins every import page while reusing the current lease and releases only temporary locks", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (_url, input) =>
      input.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(fresh(images[1])),
    );
  vi.stubGlobal("fetch", fetcher);
  const result = await acquireImportPageLeases({
    ...options,
    held: {
      leaseToken: "token-page-1",
      editorEpoch: 3,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      imageId: images[0].id,
    },
  });
  expect(result.access).toEqual(
    images.map((image) => ({
      imageId: image.id,
      editorInstanceId: "instance",
      leaseToken: `token-${image.id}`,
    })),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    editorInstanceId: "instance",
    expectedEditorEpoch: 3,
  });
  expect(fetcher.mock.calls[0][1].headers["X-Comiku-Request"]).toBe("1");
  await result.release();
  expect(fetcher.mock.calls[1][0]).toContain("page-2/lease");
  expect(fetcher.mock.calls[1][1].method).toBe("DELETE");
});

test("refuses an acquisition without its current page and releases the granted lease", async () => {
  const fetcher = vi.fn().mockImplementation(async (_url, input) =>
    input.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          leaseToken: "token",
          editorEpoch: 3,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    requestPageLease("work", "page-1", {
      editorInstanceId: "instance",
      expectedEditorEpoch: 3,
    }),
  ).rejects.toThrow("未取得本页最新内容");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1].method).toBe("DELETE");
});

test("refuses an occupied target and releases previously acquired pages without stealing the lock", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (url, input) =>
      input.method === "DELETE"
        ? new Response(null, { status: 204 })
        : String(url).includes("page-1")
          ? Response.json(fresh(images[0]))
          : Response.json(
              { message: "另一名校对正在编辑本页" },
              { status: 409 },
            ),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(acquireImportPageLeases(options)).rejects.toThrow(
    "第 2 页无法取得校对编辑锁",
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2][0]).toContain("page-1/lease");
  expect(fetcher.mock.calls[2][1].method).toBe("DELETE");
});

test("requires a new preview when freshly leased cloud contents have changed", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (_url, input) =>
      input.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(fresh({ ...images[0], translationRevision: 3 })),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    acquireImportPageLeases({ ...options, targetIds: [images[0].id] }),
  ).rejects.toThrow("第 1 页云端内容已变化");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1].method).toBe("DELETE");
});
