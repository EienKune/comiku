import assert from "node:assert/strict";
import test from "node:test";
import { inspectImage } from "../src/files/image-inspection.js";
test("ordinary lossy WebP avatars have dimensions without an extended VP8X header", () => {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0);
  header.write("WEBP", 8);
  header.write("VP8 ", 12);
  header.set([0x9d, 0x01, 0x2a], 23);
  header.writeUInt16LE(320, 26);
  header.writeUInt16LE(240, 28);
  const image = inspectImage("avatar.webp", header);
  assert.equal(image.contentType, "image/webp");
  assert.equal(image.width, 320);
  assert.equal(image.height, 240);
});
