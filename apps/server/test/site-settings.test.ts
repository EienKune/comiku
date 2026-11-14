import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  normalizeSiteName,
  siteThemePresetIds,
} from "../src/site/site-theme-presets.js";
import { processSiteIcon } from "../src/site/site-icon-processor.js";
import { runSiteMaintenance } from "../src/site/site-worker.js";

test("site names are plain bounded Unicode and existing themes remain available", () => {
  assert.equal(normalizeSiteName("  夏莱烤肉屋  "), "夏莱烤肉屋");
  assert.equal(normalizeSiteName("😀".repeat(64)), "😀".repeat(64));
  for (const value of ["", " ", "a".repeat(65), "a\nb", "a\u202eb"])
    assert.throws(() => normalizeSiteName(value));
  assert.equal(
    normalizeSiteName("<script>plain text</script>"),
    "<script>plain text</script>",
  );
  assert.deepEqual(siteThemePresetIds, [
    "teal",
    "sky",
    "lavender",
    "pink",
    "amber",
    "minimal",
    "schale",
    "archive",
    "shittim",
    "arona",
    "plana",
    "shittim-duo",
    "ba-cyan",
    "ba-azure",
  ]);
});

test("site maintenance failure retains its own minute cadence and stops on abort", async () => {
  const stopping = new AbortController(),
    waits: number[] = [];
  let runs = 0;
  await runSiteMaintenance(
    {
      async cleanup() {
        if (++runs === 1) throw new Error("synthetic");
        stopping.abort();
      },
    },
    stopping.signal,
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(runs, 2);
  assert.deepEqual(waits, [60_000, 60_000]);
});

test("site icons decode bounded static rasters and produce padded PNG derivatives", async () => {
  const png = await sharp({
    create: { width: 80, height: 40, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const result = await processSiteIcon(png, "image/png");
  for (const size of [32, 256] as const) {
    const info = await sharp(result[size]).metadata();
    assert.equal(info.width, size);
    assert.equal(info.height, size);
    assert.equal(info.format, "png");
  }
  await assert.rejects(processSiteIcon(png, "image/jpeg"));
  await assert.rejects(
    processSiteIcon(Buffer.from("not an image"), "image/png"),
  );
  await assert.rejects(
    processSiteIcon(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"),
  );
  const large = await sharp({
    create: { width: 2001, height: 2000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(processSiteIcon(large, "image/png"));
});
