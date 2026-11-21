import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { test } from "node:test";
import { R2ObjectStorage } from "../src/files/r2-object-storage.js";

test("R2 stream GET cancellation reaches the SDK transport while awaiting headers", async () => {
  const server = createServer((request) => {
    request.resume();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
    maxAttempts: 1,
  });
  const storage = new R2ObjectStorage({
    accountId: "synthetic",
    bucket: "synthetic",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic",
  });
  Object.assign(storage, { client });
  const controller = new AbortController();
  const requestArrived = once(server, "request");
  try {
    const opened = storage.readStream("source/test.png", controller.signal);
    const rejected = assert.rejects(opened, { name: "AbortError" });
    const [, response] = await requestArrived;
    const closed = once(response, "close");
    controller.abort();
    await rejected;
    await closed;
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
