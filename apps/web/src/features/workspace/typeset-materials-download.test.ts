import { expect, test, vi } from "vitest";
import { unzipSync } from "fflate";
import { afterEach } from "vitest";
import {
  browserArchiveLimit,
  buildMaterialArchive,
  downloadBrowserMaterials,
  type MaterialManifest,
} from "./typeset-materials-download";
afterEach(() => vi.unstubAllGlobals());

const bytes = new Uint8Array([1, 2, 3]);
const checksum =
  "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
test("browser archive preserves exact page bytes and LabelPlus encoding", async () => {
  const fetcher = vi.fn(async () => new Response(bytes));
  const archive = await buildMaterialArchive(
    {
      translationFileName: "翻译.txt",
      translationBase64: "//4=",
      images: [
        {
          fileName: "1-001.png",
          size: 3,
          checksum,
          url: "https://files.invalid/page",
        },
      ],
    },
    fetcher,
  );
  expect(unzipSync(archive)).toEqual({
    "1-001.png": bytes,
    "翻译.txt": new Uint8Array([255, 254]),
  });
});
test("corrupt or truncated images never produce an archive", async () => {
  await expect(
    buildMaterialArchive(
      {
        translationFileName: "text.txt",
        translationBase64: "",
        images: [{ fileName: "page.png", size: 3, checksum, url: "page" }],
      },
      async () => new Response(new Uint8Array([1, 2])),
    ),
  ).rejects.toThrow("校验失败");
});
test("downloads have a shared six-request concurrency bound and stop on cancellation", async () => {
  let active = 0,
    maximum = 0;
  const fetcher = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return new Response(bytes);
  };
  await buildMaterialArchive(
    {
      translationFileName: "text.txt",
      translationBase64: "",
      images: Array.from({ length: 20 }, (_, i) => ({
        fileName: `${i}.png`,
        size: 3,
        checksum,
        url: `${i}`,
      })),
    },
    fetcher,
  );
  expect(maximum).toBe(6);
  const controller = new AbortController();
  controller.abort();
  await expect(
    buildMaterialArchive(
      { translationFileName: "text.txt", translationBase64: "", images: [] },
      fetcher,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("large materials select the supported fallback before signing or freezing", async () => {
  const fetcher = vi.fn<(url: string) => Promise<Response>>(async () =>
    Response.json({ id: "material", totalBytes: browserArchiveLimit + 1 }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await downloadBrowserMaterials({
      workId: "work",
      expectedRevision: 4,
      expectedEditorEpoch: 2,
      idempotencyKey: "intent",
    }),
  ).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/works/work/typeset/materials");
});

test("expired signatures renew the same manifest once without mixing changed files", async () => {
  const image = { fileName: "page.png", size: 3, checksum, url: "old" };
  const renew = vi.fn(
    async () =>
      ({ images: [{ ...image, url: "renewed" }] }) as MaterialManifest,
  );
  const fetcher = vi.fn(async (url: string) =>
    url === "old" ? new Response(null, { status: 403 }) : new Response(bytes),
  );
  await buildMaterialArchive(
    { translationFileName: "text.txt", translationBase64: "", images: [image] },
    fetcher,
    undefined,
    renew,
  );
  expect(renew).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["old", "renewed"]);
  await expect(
    buildMaterialArchive(
      {
        translationFileName: "text.txt",
        translationBase64: "",
        images: [image],
      },
      fetcher,
      undefined,
      async () =>
        ({
          images: [{ ...image, url: "renewed", checksum: "changed" }],
        }) as MaterialManifest,
    ),
  ).rejects.toThrow("材料已更新");
});
