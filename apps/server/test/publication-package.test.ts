import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync } from "fflate";
import {
  createPublicationImageArchive,
  publicationImagePackageFileName,
} from "../src/publishing/publication-package.js";

test("publication package keeps selected version order and stable names", () => {
  const archive = unzipSync(
    createPublicationImageArchive(
      [
        { contentType: "image/png", body: new Uint8Array([1]) },
        { contentType: "image/webp", body: new Uint8Array([2]) },
      ],
      12,
    ),
  );
  assert.deepEqual(Object.keys(archive), ["12-001成图.png", "12-002成图.webp"]);
  assert.deepEqual([...archive["12-001成图.png"]], [1]);
  assert.equal(publicationImagePackageFileName(12), "12_成图.zip");
});
