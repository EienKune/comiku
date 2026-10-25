import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  generateThumbnail,
  shouldKeepThumbnail,
} from "../src/files/image-processor.js";

for (const [width, height, expectedWidth, expectedHeight] of [
  [2400, 1600, 800, 533],
  [1000, 700, 800, 560],
  [640, 480, 640, 480],
  [400, 16000, 20, 800],
]) {
  test(`thumbnail ${width}x${height} preserves the entire image without enlargement`, async () => {
    const source = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 100, g: 130, b: 200, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const result = await generateThumbnail(source);
    const metadata = await sharp(result.body).metadata();
    assert.equal(metadata.width, expectedWidth);
    assert.equal(metadata.height, expectedHeight);
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.hasAlpha, true);
  });
}
test("thumbnail adoption requires 20 percent savings and rejects unsafe decoding", async () => {
  assert.equal(shouldKeepThumbnail(1000, 800), true);
  assert.equal(shouldKeepThumbnail(1000, 801), false);
  assert.equal(shouldKeepThumbnail(1000, 1200), false);
  await assert.rejects(() => generateThumbnail(new Uint8Array([1, 2, 3])));
  const large = await sharp({
    create: { width: 6400, height: 6400, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(() => generateThumbnail(large), /pixel limit/i);
});

test("animated source produces one static preview while the source remains unchanged", async () => {
  const source = await sharp(
    Buffer.concat([
      Buffer.alloc(20 * 20 * 3, 60),
      Buffer.alloc(20 * 20 * 3, 180),
    ]),
    {
      raw: { width: 20, height: 40, pageHeight: 20, channels: 3 },
    },
  )
    .gif({ loop: 0, delay: [100, 100] })
    .toBuffer();
  assert.equal((await sharp(source, { animated: true }).metadata()).pages, 2);
  const thumbnail = await generateThumbnail(source);
  const metadata = await sharp(thumbnail.body).metadata();
  assert.equal(metadata.height, 20);
  assert.equal(metadata.pages ?? 1, 1);
  assert.equal((await sharp(source, { animated: true }).metadata()).pages, 2);
});
