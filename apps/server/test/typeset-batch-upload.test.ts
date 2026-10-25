import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import {
  prepareTypesetBatchFile,
  typesetName,
  validateTypesetSelection,
} from "../src/typesetting/typeset-batch-upload.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

test("typeset batch naming accepts only explicit work numbers and optional rendered suffix", () => {
  assert.deepEqual(typesetName("139-001成图.png"), {
    workNumber: 139,
    pageNumber: 1,
  });
  assert.deepEqual(typesetName("139-02.webp"), {
    workNumber: 139,
    pageNumber: 2,
  });
  assert.deepEqual(typesetName("139_成图.zip", true), {
    workNumber: 139,
    pageNumber: null,
  });
  assert.deepEqual(typesetName("139.zip", true), {
    workNumber: 139,
    pageNumber: null,
  });
  assert.equal(typesetName("title139-1.png").workNumber, null);
  assert.equal(typesetName("folder/page-02成图.png").pageNumber, 2);
  assert.equal(typesetName("139_foo.zip", true).workNumber, null);
  assert.equal(typesetName("0-1.png").workNumber, null);
  assert.equal(typesetName("999999999999999999-1.png").workNumber, null);
});

test("typeset batch selection requires explicit container merges and rejects duplicate pages", () => {
  const image = (sourceName: string, uploadFileId: string, archive = true) => ({
    sourceName,
    uploadFileId,
    archive,
    size: 100,
  });
  assert.throws(
    () =>
      validateTypesetSelection(
        [image("1-1.png", "a"), image("1-2.png", "b")],
        false,
      ),
    /合并/,
  );
  assert.throws(
    () =>
      validateTypesetSelection(
        [image("1-1.png", "a"), image("1-2.png", "b", false)],
        false,
      ),
    /合并/,
  );
  validateTypesetSelection(
    [image("1-1.png", "a"), image("说明.png", "b", false)],
    true,
  );
  assert.throws(
    () =>
      validateTypesetSelection(
        [image("1-1.png", "a"), image("1-01成图.png", "a")],
        true,
      ),
    /重复数字页码/,
  );
  assert.throws(
    () =>
      validateTypesetSelection(
        [image("first/explain.png", "a"), image("second/explain.png", "b")],
        true,
      ),
    /同名/,
  );
  assert.throws(
    () =>
      validateTypesetSelection(
        Array.from({ length: 101 }, (_, i) => image(`1-${i}.png`, "a")),
        true,
      ),
    /100/,
  );
  assert.throws(
    () =>
      validateTypesetSelection(
        [{ ...image("1-1.png", "a"), size: 251 * 1024 * 1024 }],
        true,
      ),
    /250/,
  );
});

test("typeset archives preserve additional explanations and apply bounded source extraction", () => {
  const archive = Buffer.from(
    zipSync({
      "first/second/139-2成图.png": png,
      "first/second/解释.png": png,
      "139_翻译.txt": Buffer.from("not an image"),
    }),
  );
  const input = {
    originalname: "139_成图.zip",
    mimetype: "application/zip",
    size: archive.length,
    buffer: archive,
  };
  const group = prepareTypesetBatchFile(input);
  assert.equal(group.images.length, 2);
  assert.equal(group.images[1].sourceName, "first/second/解释.png");
  const invalidEntries: Record<string, Uint8Array>[] = [
    { "one/two/three/139-1.png": png },
    { "one/nested.zip": archive },
    { "one/nested.7z": png },
    { "folder/139-1.png": png, "folder\\139-1.png": png },
  ];
  for (const entries of invalidEntries) {
    const buffer = Buffer.from(zipSync(entries));
    assert.throws(
      () => prepareTypesetBatchFile({ ...input, buffer, size: buffer.length }),
      /两层|嵌套|重复/,
    );
  }
});
