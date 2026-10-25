import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { unzipSync } from "fflate";
import {
  createTypesetHandoffArchive,
  targetImageFileName,
  typesetHandoffPackageFileName,
  typesetTranslationFileName,
} from "../src/typesetting/handoff-package.js";

test("unified handoff package contains stable source names and LabelPlus text", async () => {
  assert.equal(targetImageFileName(12, 0, "image/png"), "12-001.png");
  assert.equal(targetImageFileName(12, 1, "image/jpeg"), "12-002.jpg");
  assert.equal(targetImageFileName(12, 9, "image/webp"), "12-010.webp");

  const temporary = await createTypesetHandoffArchive(
    (async function* () {
      yield { contentType: "image/png", body: new Uint8Array([1, 2]) };
      yield { contentType: "image/jpeg", body: new Uint8Array([3]) };
    })(),
    12,
    new TextEncoder().encode("labelplus"),
  );
  try {
    const archive = unzipSync(new Uint8Array(await readFile(temporary.path)));
    assert.deepEqual(Object.keys(archive), [
      "12-001.png",
      "12-002.jpg",
      "12_翻译.txt",
    ]);
    assert.deepEqual([...archive["12-001.png"]], [1, 2]);
    assert.deepEqual([...archive["12-002.jpg"]], [3]);
    assert.equal(new TextDecoder().decode(archive["12_翻译.txt"]), "labelplus");
  } finally {
    await temporary.cleanup();
  }
});

test("handoff file names are stable", () => {
  assert.equal(typesetHandoffPackageFileName(12), "12_嵌字交接.zip");
  assert.equal(typesetTranslationFileName(12), "12_翻译.txt");
});

test("large image streams are consumed incrementally with backpressure and clean up temporary files", async () => {
  const chunk = Buffer.alloc(64 * 1024, 17);
  let produced = 0;
  const initialExternal = process.memoryUsage().external;
  let peakExternal = initialExternal;
  const archive = await createTypesetHandoffArchive(
    (async function* () {
      for (let image = 0; image < 13; image++) {
        yield {
          contentType: "image/png",
          body: (async function* () {
            for (let index = 0; index < 256; index++) {
              produced++;
              peakExternal = Math.max(
                peakExternal,
                process.memoryUsage().external,
              );
              yield chunk;
            }
          })(),
        };
      }
    })(),
    99,
    undefined,
    true,
  );
  try {
    assert.equal(produced, 13 * 256);
    const size = (await stat(archive.path)).size;
    assert.ok(size > 208 * 1024 * 1024 && size < 209 * 1024 * 1024);
    assert.ok(
      peakExternal - initialExternal < 80 * 1024 * 1024,
      `Unexpected external memory growth: ${peakExternal - initialExternal}`,
    );
  } finally {
    await archive.cleanup();
  }
  await assert.rejects(stat(archive.path), { code: "ENOENT" });
});
