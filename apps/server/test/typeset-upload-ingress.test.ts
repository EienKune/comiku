import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import { MemoryObjectStorage } from "../src/files/memory-object-storage.js";
import { LocalFilesController } from "../src/files/local-files.controller.js";

test("local signed ingress allows larger typeset ZIPs while bounding purpose and signed length before buffering", async () => {
  const storage = new MemoryObjectStorage();
  const controller = new LocalFilesController(storage);
  const body = Buffer.alloc(26 * 1024 * 1024, 1);
  const checksum = createHash("sha256").update(body).digest("hex");
  const signed = await storage.signedWriteUrl(
    {
      key: "staging/typeset-upload/session/file",
      contentType: "application/zip",
      size: body.length,
      checksum,
    },
    60,
  );
  const token = signed.url.split("/").at(-1)!;
  assert.deepEqual(
    await controller.write(token, Readable.from([body]) as never),
    { ok: true },
  );
  assert.equal(
    (await storage.head("staging/typeset-upload/session/file"))?.size,
    body.length,
  );
  const ordinary = await storage.signedWriteUrl(
    {
      key: "staging/candidate-upload/session/file",
      contentType: "application/zip",
      size: body.length,
      checksum,
    },
    60,
  );
  await assert.rejects(
    controller.write(
      ordinary.url.split("/").at(-1)!,
      Readable.from([body]) as never,
    ),
    PayloadTooLargeException,
  );
  await assert.rejects(
    controller.write(token + "tampered", Readable.from([body]) as never),
    BadRequestException,
  );
  const small = await storage.signedWriteUrl(
    {
      key: "staging/typeset-upload/session/small",
      contentType: "application/zip",
      size: 1,
      checksum,
    },
    60,
  );
  await assert.rejects(
    controller.write(
      small.url.split("/").at(-1)!,
      Readable.from([Buffer.alloc(2)]) as never,
    ),
    PayloadTooLargeException,
  );
});
