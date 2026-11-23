import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalObjectStorage } from "../src/files/local-object-storage.js";
import { PrefixedObjectStorage } from "../src/files/prefixed-object-storage.js";

test("prefix forwards stream cancellation to its backing storage", async () => {
  const controller = new AbortController();
  const raw = new LocalObjectStorage("unused");
  const expected = new Error("aborted backing GET");
  raw.readStream = async (key: string, signal?: AbortSignal) => {
    assert.equal(key, "trial/source/example.png");
    assert.equal(signal, controller.signal);
    throw expected;
  };
  const storage = new PrefixedObjectStorage(raw, "trial/");
  await assert.rejects(
    storage.readStream("source/example.png", controller.signal),
    (error) => error === expected,
  );
});

test("prefix isolates put/read/stream/head/delete and both signed URL operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "comiku-prefix-"));
  try {
    const raw = new LocalObjectStorage(root),
      storage = new PrefixedObjectStorage(raw, "trial/");
    const body = Buffer.from("synthetic"),
      checksum = createHash("sha256").update(body).digest("hex");
    const input = {
      key: "source/example.png",
      body,
      size: body.length,
      contentType: "image/png",
      checksum,
    };
    await raw.put({ ...input, body: Buffer.from("old"), size: 3 });
    await storage.put(input);
    assert.equal(
      Buffer.from(await raw.read("trial/source/example.png")).toString(),
      "synthetic",
    );
    assert.deepEqual(Buffer.from(await storage.read(input.key)), body);
    assert.equal((await storage.head(input.key))?.size, body.length);
    const chunks = [];
    for await (const chunk of await storage.readStream(input.key))
      chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), body);
    const signed = await storage.signedReadUrl(input.key, 60, "fixture.png");
    assert.deepEqual(
      Buffer.from(
        (await raw.readSigned(signed.split("/api/local-files/")[1])).body,
      ),
      body,
    );
    const target = await storage.signedWriteUrl(
      { ...input, key: "staging/upload" },
      60,
    );
    await raw.writeSigned(
      target.url.split("/api/local-files/uploads/")[1],
      body,
    );
    assert.deepEqual(Buffer.from(await raw.read("trial/staging/upload")), body);
    await storage.copy(input.key, "works/sealed.png");
    assert.deepEqual(
      Buffer.from(await raw.read("trial/works/sealed.png")),
      body,
    );
    assert.equal(await raw.head("works/sealed.png"), null);
    await storage.delete(input.key);
    assert.equal(await storage.head(input.key), null);
    assert.equal(Buffer.from(await raw.read(input.key)).toString(), "old");
    assert.deepEqual(Buffer.from(await storage.read("works/sealed.png")), body);
    assert.throws(() => new PrefixedObjectStorage(raw, "../"));
    await assert.rejects(storage.read("../source/example.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
