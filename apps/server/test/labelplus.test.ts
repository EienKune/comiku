import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  defaultLabelPlusHeader,
  encodeLabelPlus,
  LabelPlusParseError,
  parseLabelPlus,
  serializeLabelPlus,
  type LabelPlusDocument,
} from "../src/labelplus/labelplus-codec.js";

const fixtureUrl = new URL("./fixtures/labelplus/minimal.txt", import.meta.url);

test("parses the sanitized multi-image LabelPlus fixture", async () => {
  const source = await readFile(fixtureUrl);
  assert.deepEqual([...source.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(source.toString("utf8"), /\r\n/);

  const result = parseLabelPlus(source);
  assert.equal(result.document.formatVersion, "1,0");
  assert.equal(result.document.images.length, 3);
  assert.equal(result.document.images[0].markers.length, 2);
  assert.equal(result.document.images[1].markers.length, 0);
  assert.equal(
    result.document.images[0].markers[0].translation,
    "第一条译文\n保留第二行",
  );
  assert.equal(
    result.document.images[0].markers[1].translation,
    "包含空行的译文\n\n下一段",
  );
  assert.deepEqual(result.warnings, []);
});

test("exports UTF-8 BOM and CRLF with semantic round-trip stability", async () => {
  const parsed = parseLabelPlus(await readFile(fixtureUrl)).document;
  const output = serializeLabelPlus(parsed);
  assert.equal(output.charCodeAt(0), 0xfeff);
  assert.match(output, /\r\n/);
  assert.match(output, /\[0\.250,0\.375,1]/);
  assert.doesNotMatch(output.replaceAll("\r\n", ""), /\n|\r/);
  assert.deepEqual(parseLabelPlus(encodeLabelPlus(parsed)).document, parsed);
});

test("derives marker numbers from order and reports imported numbering gaps", () => {
  const input = `\uFEFF${defaultLabelPlusHeader.join("\r\n")}\r\n\r\n>>>>>>>>[page.png]<<<<<<<<\r\n\r\n----------------[7]----------------[0.2,0.3,1]\r\n示例\r\n`;
  const parsed = parseLabelPlus(input);
  assert.equal(parsed.warnings[0]?.code, "non_sequential_marker_number");
  assert.match(serializeLabelPlus(parsed.document), /----------------\[1]/);
});

test("rejects invalid coordinates, invalid UTF-8 and structural translation lines", () => {
  const invalidCoordinate = `\uFEFF${defaultLabelPlusHeader.join("\n")}\n>>>>>>>>[page.png]<<<<<<<<\n----------------[1]----------------[1.1,0.3,1]\n示例`;
  assert.throws(
    () => parseLabelPlus(invalidCoordinate),
    (error: unknown) =>
      error instanceof LabelPlusParseError && /x 坐标/.test(error.message),
  );
  assert.throws(() => parseLabelPlus(Uint8Array.from([0xff, 0xfe])), /UTF-8/);

  const document: LabelPlusDocument = {
    formatVersion: "1,0",
    headerLines: [...defaultLabelPlusHeader],
    images: [
      {
        fileName: "page.png",
        markers: [
          {
            x: 0.2,
            y: 0.3,
            positionType: 1,
            translation: ">>>>>>>>[another.png]<<<<<<<<",
          },
        ],
      },
    ],
  };
  assert.throws(() => serializeLabelPlus(document), /结构标记行/);
});
