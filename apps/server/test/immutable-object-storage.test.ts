import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { LocalObjectStorage } from "../src/files/local-object-storage.js";
import { MemoryObjectStorage } from "../src/files/memory-object-storage.js";
import { LocalFilesController } from "../src/files/local-files.controller.js";
import { R2ObjectStorage } from "../src/files/r2-object-storage.js";
import type {
  ObjectStorage,
  SignedWriteInput,
} from "../src/files/object-storage.js";
import { PrefixedObjectStorage } from "../src/files/prefixed-object-storage.js";

const body = Buffer.from("synthetic immutable typeset image");
const input: SignedWriteInput = {
  key: "typeset-uploads/immutable/session/file.png",
  contentType: "image/png",
  size: body.length,
  checksum: createHash("sha256").update(body).digest("hex"),
  immutable: true,
};

for (const kind of ["local", "memory"] as const) {
  test(`${kind} immutable signed PUT requires its condition and accepts exactly one concurrent write`, async () => {
    const root = await mkdtemp(join(tmpdir(), "comiku-immutable-storage-"));
    try {
      const storage =
        kind === "local"
          ? new LocalObjectStorage(root)
          : new MemoryObjectStorage();
      const target = await storage.signedWriteUrl(input, 60);
      const token = target.url.split("/").at(-1)!;
      assert.equal(target.headers["If-None-Match"], "*");
      assert.equal(storage.signedWriteMetadata(token).immutable, true);
      await assert.rejects(storage.writeSigned(token, body), /condition/i);
      await assert.rejects(
        storage.writeSigned(token, body, '"anything"'),
        /condition/i,
      );
      assert.equal(await storage.head(input.key), null);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => storage.writeSigned(token, body, "*")),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        7,
      );
      await assert.rejects(storage.writeSigned(token, body, "*"), /condition/i);
      assert.deepEqual(Buffer.from(await storage.read(input.key)), body);
      const changed = Buffer.from("x".repeat(body.length));
      const otherTarget = await storage.signedWriteUrl(
        {
          ...input,
          checksum: createHash("sha256").update(changed).digest("hex"),
        },
        60,
      );
      await assert.rejects(
        storage.writeSigned(otherTarget.url.split("/").at(-1)!, changed, "*"),
        /condition/i,
      );
      assert.deepEqual(Buffer.from(await storage.read(input.key)), body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("local ingress enforces immutable condition before reading body and reports 412 on replay", async () => {
  const storage = new MemoryObjectStorage();
  const controller = new LocalFilesController(storage);
  const target = await storage.signedWriteUrl(input, 60);
  const token = target.url.split("/").at(-1)!;
  const missing = Readable.from([body]);
  Object.assign(missing, { headers: {} });
  await assert.rejects(
    controller.write(token, missing as never),
    (error: unknown) => (error as { getStatus(): number }).getStatus() === 412,
  );
  assert.equal(missing.readableDidRead, false);
  const request = () =>
    Object.assign(Readable.from([body]), { headers: { "if-none-match": "*" } });
  assert.deepEqual(await controller.write(token, request() as never), {
    ok: true,
  });
  await assert.rejects(
    controller.write(token, request() as never),
    (error: unknown) => (error as { getStatus(): number }).getStatus() === 412,
  );
});

test("R2 immutable grants cryptographically bind If-None-Match while ordinary grants stay compatible", async () => {
  const storage = new R2ObjectStorage({
    accountId: "synthetic",
    bucket: "synthetic",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic",
  });
  const target = await storage.signedWriteUrl(input, 60);
  const signedHeaders = new URL(target.url).searchParams
    .get("X-Amz-SignedHeaders")!
    .split(";");
  assert.equal(target.headers["If-None-Match"], "*");
  assert.ok(signedHeaders.includes("if-none-match"));
  assert.ok(signedHeaders.includes("content-type"));
  assert.ok(signedHeaders.includes("x-amz-meta-sha256"));
  assert.equal(new URL(target.url).searchParams.has("if-none-match"), false);
  const ordinary = await storage.signedWriteUrl(
    { ...input, immutable: undefined },
    60,
  );
  assert.equal(ordinary.headers["If-None-Match"], undefined);
  assert.equal(
    new URL(ordinary.url).searchParams
      .get("X-Amz-SignedHeaders")!
      .split(";")
      .includes("if-none-match"),
    false,
  );
});

test("prefix preserves immutable upload requirement", async () => {
  let seen: SignedWriteInput | undefined;
  const storage = new PrefixedObjectStorage(
    {
      signedWriteUrl: async (value: SignedWriteInput) => {
        seen = value;
        return { url: "synthetic", headers: {}, expiresInSeconds: 60 };
      },
    } as unknown as ObjectStorage,
    "trial/",
  );
  await storage.signedWriteUrl(input, 60);
  assert.equal(seen?.immutable, true);
  assert.equal(seen?.key, "trial/" + input.key);
});
