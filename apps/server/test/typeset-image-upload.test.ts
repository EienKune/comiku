import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareTypesetImages } from "../src/typesetting/typeset-image-upload.js";

function png(width: number, height: number) {
  const body = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(body);
  body.writeUInt32BE(width, 16);
  body.writeUInt32BE(height, 20);
  return body;
}

function upload(name: string, body = png(1200, 800)) {
  return {
    originalname: name,
    mimetype: "image/png",
    size: body.byteLength,
    buffer: body,
  };
}

test("typeset images sort a complete numeric suffix set and keep dimensions", () => {
  const prepared = prepareTypesetImages([
    upload("final-10.png"),
    upload("final-02.png"),
  ]);
  assert.equal(prepared.automaticallySorted, true);
  assert.deepEqual(
    prepared.images.map((image) => image.sourceName),
    ["final-02.png", "final-10.png"],
  );
  assert.deepEqual(
    prepared.images.map((image) => image.uploadIndex),
    [1, 0],
  );
  assert.equal(prepared.images[0].width, 1200);
  assert.equal(prepared.images[0].height, 800);
});

test("typeset images preserve manual order without a complete numeric suffix set", () => {
  const prepared = prepareTypesetImages([
    upload("back-cover.png"),
    upload("final-01.png"),
  ]);
  assert.equal(prepared.automaticallySorted, false);
  assert.deepEqual(
    prepared.images.map((image) => image.sourceName),
    ["back-cover.png", "final-01.png"],
  );
});

test("typeset images reject unsupported formats", () => {
  const gif = Buffer.from("47494638396101000100", "hex");
  assert.throws(
    () => prepareTypesetImages([upload("result.gif", gif)]),
    /只支持 PNG、JPEG 或 WebP/,
  );
});
