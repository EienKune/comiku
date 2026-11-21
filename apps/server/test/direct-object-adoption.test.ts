import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FileObjectsService } from "../src/files/file-objects.service.js";

test("staging grants cannot issue mutable writes for keys eligible for direct adoption", async () => {
  const calls: unknown[] = [];
  const service = new FileObjectsService(
    {} as never,
    {
      signedWriteUrl: async (input: unknown) => {
        calls.push(input);
        return { url: "synthetic", headers: {}, expiresInSeconds: 60 };
      },
    } as never,
    {} as never,
  );
  const input = {
    key: "typeset-uploads/immutable/session/file.png",
    contentType: "image/png",
    size: 1,
    checksum: "a".repeat(64),
  };
  assert.throws(() => service.signedStagingWriteUrl(input, 60), /immutable/i);
  assert.throws(
    () =>
      service.signedStagingWriteUrl(
        {
          ...input,
          key: "staging/candidate-upload/session/file.png",
          immutable: true,
        },
        60,
      ),
    /immutable/i,
  );
  assert.deepEqual(calls, []);
  await service.signedStagingWriteUrl({ ...input, immutable: true }, 60);
  await service.signedStagingWriteUrl(
    { ...input, key: "staging/typeset-upload/session/file.zip" },
    60,
  );
  assert.equal(calls.length, 2);
});

test("direct adoption registers only a verified immutable key without copying or reading object bytes", async () => {
  const calls: string[] = [];
  const service = new FileObjectsService(
    {} as never,
    new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("Adoption must not touch storage");
        },
      },
    ) as never,
    {
      enqueue: async () => {
        calls.push("thumbnail-job");
      },
    } as never,
  );
  const tx = {
    fileObject: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("file");
        return { id: "file", ...data };
      },
    },
    imageDerivative: {
      createMany: async () => {
        calls.push("thumbnail");
      },
      findUniqueOrThrow: async () => ({ id: "derivative" }),
    },
  };
  const input = {
    objectKey: "typeset-uploads/immutable/session/unique-file.png",
    contentType: "image/png",
    size: 123,
    checksum: "a".repeat(64),
    createdById: "user",
  };
  const file = await service.adoptDirectObjectTx(tx as never, input);
  assert.equal(file.objectKey, input.objectKey);
  assert.equal(file.bucketScope, "works");
  assert.equal(file.kind, "typeset-upload-preview");
  assert.equal(file.size, 123n);
  assert.deepEqual(calls, ["file", "thumbnail", "thumbnail-job"]);
  for (const objectKey of [
    "staging/typeset-upload/session/file.png",
    "works/any.png",
    "typeset-uploads/immutable/../file.png",
    "typeset-uploads/immutable/",
  ]) {
    await assert.rejects(
      service.adoptDirectObjectTx(tx as never, { ...input, objectKey }),
      /immutable|object key/i,
    );
  }
  assert.deepEqual(calls, ["file", "thumbnail", "thumbnail-job"]);
});
