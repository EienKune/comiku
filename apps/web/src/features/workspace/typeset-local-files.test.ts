import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { File as NodeFile } from "node:buffer";
import { zipSync } from "fflate";
import {
  prepareLocalTypesetImages,
  releaseLocalTypesetImages,
} from "./typeset-local-files";
beforeEach(() => {
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:local-preview");
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
function zip(entries: Record<string, Uint8Array>) {
  return new File([zipSync(entries) as BlobPart], "21_成图.zip");
}

test("expands local images in archive order, preserves only naming hints and never contacts storage", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  const rows = await prepareLocalTypesetImages([
    zip({
      "pages/a.png": new Uint8Array([1]),
      "pages/21-002.png": new Uint8Array([2]),
      "notes.txt": new Uint8Array([3]),
    }),
  ]);
  expect(
    rows.map((row) => ({
      name: row.sourceName,
      target: row.target,
      page: row.pageNumber,
    })),
  ).toEqual([
    { name: "a.png", target: "21", page: null },
    { name: "21-002.png", target: "21", page: 2 },
  ]);
  expect(rows[0].uploadFileId).toBe(rows[1].uploadFileId);
  expect(rows.every((row) => row.localUrl === "blob:local-preview")).toBe(true);
  expect(network).not.toHaveBeenCalled();
  releaseLocalTypesetImages(rows);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});
test.each([
  "../a.png",
  "/a.png",
  "C:/a.png",
  "one/two/three/a.png",
  "nested.zip",
])("rejects unsafe or nested archive entry %s", async (name) => {
  await expect(
    prepareLocalTypesetImages([zip({ [name]: new Uint8Array([1]) })]),
  ).rejects.toThrow(/路径|目录|嵌套/);
});
test("enforces the actual decompressed limit even when the ZIP advertises a tiny image", async () => {
  const bytes = zipSync({ "huge.png": new Uint8Array(26 * 1024 * 1024) });
  new DataView(bytes.buffer).setUint32(22, 1, true);
  await expect(
    prepareLocalTypesetImages([new File([bytes as BlobPart], "21.zip")]),
  ).rejects.toThrow(/解压后/);
});
test("releases prior preview objects when a later input fails, and stops an aborted selection", async () => {
  await expect(
    prepareLocalTypesetImages([
      new File(["x"], "21-001.png"),
      new File(["x"], "bad.exe"),
    ]),
  ).rejects.toThrow("不支持的文件格式");
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareLocalTypesetImages([zip({ "a.png": new Uint8Array([1]) })], {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
