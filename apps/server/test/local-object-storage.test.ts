import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalObjectStorage } from "../src/files/local-object-storage.js";

test("local object storage persists metadata and serves expiring signed paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "comiku-local-storage-"));
  try {
    const storage = new LocalObjectStorage(root);
    const body = Buffer.from("fixture");
    await storage.put({
      key: "source/candidate-media/example.png",
      body,
      size: body.byteLength,
      contentType: "image/png",
      checksum: "fixture-checksum",
    });
    assert.deepEqual(await storage.head("source/candidate-media/example.png"), {
      contentType: "image/png",
      size: body.byteLength,
      checksum: "fixture-checksum",
    });
    const url = await storage.signedReadUrl(
      "source/candidate-media/example.png",
      60,
    );
    assert.match(url, /^\/api\/local-files\//);
    const token = url.slice("/api/local-files/".length);
    const read = await storage.readSigned(token);
    assert.equal(Buffer.from(read.body).toString(), "fixture");
    assert.equal(read.contentType, "image/png");
    const download = await storage.signedReadUrl(
      "source/candidate-media/example.png",
      60,
      "1_成图.zip",
    );
    const streamed = await storage.readSignedStream(
      download.slice("/api/local-files/".length),
    );
    assert.equal(streamed.fileName, "1_成图.zip");
    const chunks: Buffer[] = [];
    for await (const chunk of streamed.body) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), body);
    await assert.rejects(storage.readSigned(token + "broken"), /file token/);

    const uploadBody = Buffer.from("signed upload fixture");
    const uploadChecksum = createHash("sha256")
      .update(uploadBody)
      .digest("hex");
    const target = await storage.signedWriteUrl(
      {
        key: "staging/candidate-upload/session/item",
        contentType: "application/zip",
        size: uploadBody.byteLength,
        checksum: uploadChecksum,
      },
      60,
    );
    assert.match(target.url, /^\/api\/local-files\/uploads\//);
    assert.equal(target.headers["Content-Type"], "application/octet-stream");
    const uploadToken = target.url.slice("/api/local-files/uploads/".length);
    await storage.writeSigned(uploadToken, uploadBody);
    assert.deepEqual(
      await storage.head("staging/candidate-upload/session/item"),
      {
        contentType: "application/zip",
        size: uploadBody.byteLength,
        checksum: uploadChecksum,
      },
    );
    await assert.rejects(
      storage.writeSigned(uploadToken, Buffer.from("wrong")),
      /signed metadata/,
    );
    await storage.delete("source/candidate-media/example.png");
    assert.equal(
      await storage.head("source/candidate-media/example.png"),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
