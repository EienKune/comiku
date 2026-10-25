import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import {
  inspectImage,
  orderManualImages,
  prepareManualUpload,
} from "../src/candidates/manual-candidate-upload.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

test("manual images use verified content and only sort a complete numeric suffix set", () => {
  const page10 = inspectImage("chapter/page-10.png", png);
  const page2 = inspectImage("chapter/page-02.png", png);
  const ordered = orderManualImages([page10, page2]);
  assert.equal(ordered.automaticallySorted, true);
  assert.deepEqual(
    ordered.images.map((item) => item.sourceName),
    ["chapter/page-02.png", "chapter/page-10.png"],
  );
  assert.equal(page2.width, 1);
  assert.equal(page2.height, 1);

  const preserved = orderManualImages([
    inspectImage("b.png", png),
    inspectImage("a-1.png", png),
  ]);
  assert.equal(preserved.automaticallySorted, false);
  assert.deepEqual(
    preserved.images.map((item) => item.sourceName),
    ["b.png", "a-1.png"],
  );
});

test("reads dimensions from a WebP extended header", () => {
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  const width = 1920 - 1;
  const height = 1080 - 1;
  webp[24] = width & 0xff;
  webp[25] = (width >> 8) & 0xff;
  webp[26] = (width >> 16) & 0xff;
  webp[27] = height & 0xff;
  webp[28] = (height >> 8) & 0xff;
  webp[29] = (height >> 16) & 0xff;
  const image = inspectImage("result.webp", webp);
  assert.equal(image.contentType, "image/webp");
  assert.equal(image.width, 1920);
  assert.equal(image.height, 1080);
});

test("ZIP upload accepts two directory levels and rejects deeper or nested packages", () => {
  const valid = Buffer.from(
    zipSync({
      "folder/inner/page-02.png": png,
      "folder/inner/page-01.png": png,
      "folder/readme.txt": Buffer.from("ignored"),
    }),
  );
  const group = prepareManualUpload({
    originalname: "pages.zip",
    mimetype: "application/zip",
    size: valid.byteLength,
    buffer: valid,
  });
  assert.equal(group.automaticallySorted, true);
  assert.deepEqual(
    group.images.map((item) => item.sourceName),
    ["folder/inner/page-01.png", "folder/inner/page-02.png"],
  );
  assert.match(group.warnings.join(" "), /readme[.]txt/);

  const tooDeep = Buffer.from(zipSync({ "one/two/three/page-01.png": png }));
  assert.throws(
    () =>
      prepareManualUpload({
        originalname: "deep.zip",
        mimetype: "application/zip",
        size: tooDeep.byteLength,
        buffer: tooDeep,
      }),
    /最多深入两层/,
  );

  const nested = Buffer.from(zipSync({ "nested.zip": valid }));
  assert.throws(
    () =>
      prepareManualUpload({
        originalname: "nested.zip",
        mimetype: "application/zip",
        size: nested.byteLength,
        buffer: nested,
      }),
    /不展开 ZIP 内/,
  );
});
