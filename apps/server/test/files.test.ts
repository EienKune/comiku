import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type SignedWriteInput,
  validateObjectKey,
  validateReadExpiry,
  validateSignedWriteInput,
} from "../src/files/object-storage.js";
import {
  ObjectStorageUnavailableError,
  R2ObjectStorage,
  UnavailableObjectStorage,
} from "../src/files/r2-object-storage.js";
import { MemoryObjectStorage } from "../src/files/memory-object-storage.js";

test("object storage rejects ambiguous keys and excessive signed URL lifetimes", () => {
  assert.equal(
    validateObjectKey("authors/fixture/avatar.webp"),
    "authors/fixture/avatar.webp",
  );
  for (const key of ["", "/root", "a/../b", "a//b", "a\\b", "tail/"]) {
    assert.throws(() => validateObjectKey(key), /Invalid object key/);
  }
  assert.equal(validateReadExpiry(300), 300);
  for (const seconds of [0, 3601, 1.5, Number.NaN]) {
    assert.throws(() => validateReadExpiry(seconds), /expiry/);
  }
  const valid: SignedWriteInput = {
    key: "staging/candidate-upload/session/item",
    contentType: "image/png",
    size: 3,
    checksum: "a".repeat(64),
  };
  assert.equal(validateSignedWriteInput(valid, 300), valid);
  assert.throws(
    () => validateSignedWriteInput({ ...valid, checksum: "invalid" }, 300),
    /metadata/,
  );
});

test("unconfigured storage fails explicitly without touching an external service", async () => {
  const storage = new UnavailableObjectStorage();
  await assert.rejects(
    storage.head("fixture/file"),
    ObjectStorageUnavailableError,
  );
  await assert.rejects(
    storage.signedReadUrl("fixture/file", 60),
    ObjectStorageUnavailableError,
  );
  await assert.rejects(
    storage.signedWriteUrl(
      {
        key: "staging/fixture",
        contentType: "image/png",
        size: 1,
        checksum: "a".repeat(64),
      },
      60,
    ),
    ObjectStorageUnavailableError,
  );
});

test("memory storage is a deterministic test replacement", async () => {
  const storage = new MemoryObjectStorage();
  await storage.put({
    key: "fixture/image.jpg",
    body: new Uint8Array([1, 2, 3]),
    size: 3,
    contentType: "image/jpeg",
    checksum: "fixture",
  });
  assert.deepEqual(
    await storage.read("fixture/image.jpg"),
    new Uint8Array([1, 2, 3]),
  );
  assert.deepEqual(await storage.head("fixture/image.jpg"), {
    contentType: "image/jpeg",
    size: 3,
    checksum: "fixture",
  });
  assert.match(
    await storage.signedReadUrl("fixture/image.jpg", 60),
    /^memory:/,
  );
  await storage.delete("fixture/image.jpg");
  assert.equal(await storage.head("fixture/image.jpg"), null);
});

test("R2 signed writes bind the staging key, content type and checksum", async () => {
  const storage = new R2ObjectStorage({
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "fixture-access-key",
    secretAccessKey: "fixture-secret-key",
    bucket: "comiku-private",
  });
  const checksum = "b".repeat(64);
  const target = await storage.signedWriteUrl(
    {
      key: "staging/candidate-upload/session/item.png",
      contentType: "image/png",
      size: 123,
      checksum,
    },
    300,
  );
  assert.equal(target.expiresInSeconds, 300);
  assert.equal(target.headers["Content-Type"], "image/png");
  assert.equal(target.headers["x-amz-meta-sha256"], checksum);
  const url = new URL(target.url);
  assert.equal(
    url.hostname,
    "comiku-private.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  );
  assert.match(url.pathname, /^\/staging\/candidate-upload/);
});
