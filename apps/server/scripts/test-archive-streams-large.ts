/**
 * Opt-in actual-byte stress test; no credentials, disk archive or network.
 * COMIKU_ARCHIVE_STREAM_GIB=101 pnpm --filter @comiku/server exec tsx --test scripts/test-archive-streams-large.ts
 * Ordinary tests do not run this expensive check. The sink extracts STORE data while receiving
 * multipart bodies and validates SHA, CRC and the real ZIP64 directory/descriptor.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { ArchiveWriter } from "../src/archive-exports/archive-writer.js";
import {
  ARCHIVE_PART_SIZE,
  archiveObjectKey,
  type ArchiveStorage,
} from "../src/archive-exports/archive-storage.js";

const requested = Number(process.env.COMIKU_ARCHIVE_STREAM_GIB ?? 0);
test(
  "opt-in real generated stream: ZIP64, full extraction CRC/SHA and bounded memory",
  { skip: !requested },
  async () => {
    assert.ok(
      Number.isInteger(requested) && requested >= 5 && requested <= 150,
      "Choose 5..150 actual GiB",
    );
    const size = BigInt(requested) * 1024n ** 3n;
    const chunk = Buffer.alloc(64 * 1024, 0x69);
    const chunkCount = Number(size / BigInt(chunk.length));
    const expectedHash = createHash("sha256");
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    // This is a genuine full-byte SHA prepass, not a made-up digest or metadata-only fixture.
    for (let n = 0; n < chunkCount; n++) {
      expectedHash.update(chunk);
      if (n % 4096 === 0) await setImmediate();
    }
    const sourceSha = expectedHash.digest("hex");
    const streamStart = performance.now();
    console.log(
      JSON.stringify({
        phase: "prepass",
        actualGiB: requested,
        seconds: (performance.now() - start) / 1000,
      }),
    );
    const identity = {
      runId: "synthetic",
      packageId: "zip64",
      attemptId: "actual-bytes",
    };
    const path = "2026-11/123/生肉/123-001.bin";
    const zipHash = createHash("sha256"),
      extractedHash = createHash("sha256");
    let position = 0n,
      extracted = 0n,
      extractedCrc = 0,
      headerLength = 0;
    let tail = Buffer.alloc(0),
      partCount = 0,
      lastProgress = 0;
    let peakRss = process.memoryUsage().rss,
      peakExternal = process.memoryUsage().external,
      peakHeap = process.memoryUsage().heapUsed;
    const sample = () => {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakExternal = Math.max(peakExternal, memory.external);
      peakHeap = Math.max(peakHeap, memory.heapUsed);
    };
    const timer = setInterval(sample, 100);
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    eventLoop.enable();
    const storage: ArchiveStorage = {
      async openSource() {
        return Readable.from(
          (async function* () {
            for (let n = 0; n < chunkCount; n++) {
              yield chunk;
              if (n % 64 === 0) await setImmediate();
            }
          })(),
          { objectMode: false, highWaterMark: 64 * 1024 },
        );
      },
      async createMultipart() {
        return "synthetic-upload";
      },
      async uploadPart(input) {
        assert.equal(input.partNumber, ++partCount);
        assert.ok(input.body.length <= ARCHIVE_PART_SIZE);
        zipHash.update(input.body);
        if (position === 0n) {
          assert.equal(input.body.readUInt32LE(0), 0x04034b50);
          assert.equal(input.body.readUInt16LE(8), 0);
          headerLength =
            30 + input.body.readUInt16LE(26) + input.body.readUInt16LE(28);
          assert.equal(
            input.body
              .subarray(30, 30 + input.body.readUInt16LE(26))
              .toString("utf8"),
            path,
          );
        }
        const from = Number(
          position < BigInt(headerLength)
            ? BigInt(headerLength) - position
            : 0n,
        );
        const endPosition = position + BigInt(input.body.length);
        const payloadEnd = BigInt(headerLength) + size;
        const to = Number(
          endPosition > payloadEnd
            ? payloadEnd - position
            : BigInt(input.body.length),
        );
        if (to > from) {
          const payload = input.body.subarray(from, to);
          extractedHash.update(payload);
          extractedCrc = crc32(payload, extractedCrc);
          extracted += BigInt(payload.length);
        }
        position = endPosition;
        tail = Buffer.concat([
          tail.subarray(Math.max(0, tail.length - 4096)),
          input.body.subarray(Math.max(0, input.body.length - 4096)),
        ]);
        sample();
        const giB = Number(position / 1024n ** 3n);
        if (giB >= lastProgress + 10) {
          lastProgress = giB;
          console.log(
            JSON.stringify({
              phase: "stream",
              actualGiB: giB,
              peakRssMiB: peakRss / 1024 ** 2,
            }),
          );
        }
        // Introduce an async destination boundary, exercising backpressure across every real part.
        await setImmediate();
        return {
          partNumber: input.partNumber,
          etag: `synthetic-${input.partNumber}`,
          size: input.body.length,
        };
      },
      async completeMultipart() {},
      async abortMultipart() {},
      async head() {
        return null;
      },
      async listMultipart() {
        return [];
      },
      async listParts() {
        return [];
      },
      async delete() {},
      async signedDownload() {
        return "synthetic";
      },
    };
    try {
      const result = await new ArchiveWriter().write({
        storage,
        identity,
        key: archiveObjectKey(identity),
        entries: [
          { path, size, sha256: sourceSha, sourceKey: "synthetic-source" },
        ],
        signal: new AbortController().signal,
        getRateMiB: () => 0,
        onUploadCreated: async () => {},
        onPartUploaded: async () => {},
        onCompleteIntent: async () => {},
      });
      assert.equal(extracted, size);
      assert.equal(extractedHash.digest("hex"), sourceSha);
      assert.equal(result.sha256, zipHash.digest("hex"));
      assert.equal(result.bytes, position);
      const tailStart = position - BigInt(tail.length);
      const descriptor = Number(BigInt(headerLength) + size - tailStart);
      assert.ok(descriptor >= 0);
      assert.equal(tail.readUInt32LE(descriptor), 0x08074b50);
      assert.equal(tail.readUInt32LE(descriptor + 4), extractedCrc);
      assert.equal(tail.readBigUInt64LE(descriptor + 8), size);
      assert.equal(tail.readBigUInt64LE(descriptor + 16), size);
      const central = descriptor + 24;
      assert.equal(tail.readUInt32LE(central), 0x02014b50);
      assert.equal(tail.readUInt16LE(central + 6), 45);
      assert.equal(tail.readUInt32LE(central + 16), extractedCrc);
      assert.equal(tail.readUInt32LE(central + 20), 0xffffffff);
      assert.equal(tail.readUInt32LE(central + 24), 0xffffffff);
      let extra = central + 46 + tail.readUInt16LE(central + 28);
      const extraEnd = extra + tail.readUInt16LE(central + 30);
      let foundZip64 = false;
      while (extra < extraEnd) {
        if (tail.readUInt16LE(extra) === 1) {
          assert.equal(tail.readBigUInt64LE(extra + 4), size);
          assert.equal(tail.readBigUInt64LE(extra + 12), size);
          assert.equal(tail.readBigUInt64LE(extra + 20), 0n);
          foundZip64 = true;
        }
        extra += 4 + tail.readUInt16LE(extra + 2);
      }
      assert.equal(foundZip64, true);
      const zip64End = tail.indexOf(
        Buffer.from([0x50, 0x4b, 0x06, 0x06]),
        extraEnd,
      );
      assert.ok(zip64End >= 0);
      assert.equal(tail.readBigUInt64LE(zip64End + 32), 1n);
      assert.equal(
        tail.readBigUInt64LE(zip64End + 48),
        BigInt(headerLength) + size + 24n,
      );
      assert.equal(tail.readUInt32LE(tail.length - 22), 0x06054b50);
      assert.ok(
        peakRss < 512 * 1024 ** 2,
        `RSS exceeded the synthetic 512MiB budget: ${peakRss}`,
      );
      console.log(
        JSON.stringify({
          phase: "verified",
          actualGiB: requested,
          actualBytes: size.toString(),
          zipBytes: result.bytes.toString(),
          parts: partCount,
          seconds: (performance.now() - start) / 1000,
          streamSeconds: (performance.now() - streamStart) / 1000,
          streamMiBPerSecond:
            Number(size) /
            1024 ** 2 /
            ((performance.now() - streamStart) / 1000),
          cpuUserSeconds: process.cpuUsage(cpuStart).user / 1e6,
          cpuSystemSeconds: process.cpuUsage(cpuStart).system / 1e6,
          peakRssMiB: peakRss / 1024 ** 2,
          peakExternalMiB: peakExternal / 1024 ** 2,
          peakHeapMiB: peakHeap / 1024 ** 2,
          temporaryArchiveBytesWritten: 0,
          eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
          eventLoopMaxMs: eventLoop.max / 1e6,
          zipSha256: result.sha256,
        }),
      );
    } finally {
      clearInterval(timer);
      eventLoop.disable();
    }
  },
);
