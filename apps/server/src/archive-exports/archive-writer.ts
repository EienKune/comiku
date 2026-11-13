import { createHash } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import { finished } from "node:stream/promises";
import { ZipFile } from "yazl";
import {
  type ArchiveEntry,
  ARCHIVE_MAX_ENTRIES,
  validateArchivePath,
} from "./archive-format.js";
import { ArchiveRateLimiter } from "./archive-rate-limit.js";
import {
  ARCHIVE_PART_SIZE,
  archiveObjectKey,
  type ArchiveIdentity,
  type ArchivePart,
  type ArchiveStorage,
} from "./archive-storage.js";

export interface ArchiveResult {
  bytes: bigint;
  sha256: string;
  uploadId: string;
  parts: ArchivePart[];
}
export interface ArchiveWriteInput {
  entries: readonly ArchiveEntry[];
  storage: ArchiveStorage;
  key: string;
  identity: ArchiveIdentity;
  signal: AbortSignal;
  getRateMiB: () => number;
  uploadConcurrency?: number;
  partSizeBytes?: number;
  maxBytes?: bigint;
  onUploadCreated: (uploadId: string) => Promise<void>;
  onPartUploaded: (part: ArchivePart) => Promise<void>;
  onCompleteIntent: (result: ArchiveResult) => Promise<void>;
}

/** No durable decisions here: the owner persists receipts and reconciles ambiguous S3 replies. */
export class ArchiveWriter {
  async write(input: ArchiveWriteInput): Promise<ArchiveResult> {
    const concurrency = input.uploadConcurrency ?? 1;
    const partSize = input.partSizeBytes ?? ARCHIVE_PART_SIZE;
    if (
      ![1, 2].includes(concurrency) ||
      !input.entries.length ||
      input.entries.length > ARCHIVE_MAX_ENTRIES ||
      !Number.isInteger(partSize) ||
      partSize < 5 * 1024 ** 2 ||
      partSize > 32 * 1024 ** 2 ||
      archiveObjectKey(input.identity) !== input.key
    )
      throw new Error("Invalid archive write input");
    const paths = new Set<string>();
    let estimatedBytes = 1024n;
    for (const entry of input.entries) {
      validateArchivePath(entry.path);
      const canonical = entry.path.toLowerCase();
      if (
        paths.has(canonical) ||
        entry.size < 0n ||
        entry.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
        Number(entry.sourceKey !== undefined) +
          Number(entry.content !== undefined) +
          Number(entry.openContent !== undefined) !==
          1
      ) {
        throw new Error("Invalid archive entry");
      }
      paths.add(canonical);
      estimatedBytes +=
        entry.size + BigInt(256 + 2 * Buffer.byteLength(entry.path));
    }
    if (estimatedBytes > BigInt(partSize) * 10_000n)
      throw new Error("Archive multipart byte budget exceeded");
    input.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const zip = new ZipFile();
    const output = zip.outputStream as Readable;
    // Error listeners are attached before registering lazy entries (which may open immediately).
    output.on("error", () => {});
    let active: Readable | undefined;
    const streams = new Set<Readable>();
    const opening = new Set<Promise<void>>();
    const settlements = new Set<Promise<void>>();
    const track = (stream: Readable) => {
      streams.add(stream);
      const settled: Promise<void> = finished(stream, { cleanup: true })
        .catch(() => {})
        .finally(() => {
          streams.delete(stream);
          settlements.delete(settled);
        });
      settlements.add(settled);
    };
    const pending = new Set<Promise<void>>();
    let firstError: Error | undefined;
    const fail = (error: unknown) => {
      const reason =
        error instanceof Error ? error : new Error("Archive stream failed");
      firstError ??= reason;
      controller.abort(reason);
      active?.destroy(reason);
      for (const stream of streams) stream.destroy(reason);
      output.destroy(reason);
    };
    zip.on("error", fail);
    const aborted = () => fail(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    const parts: ArchivePart[] = [];
    try {
      const uploadId = await input.storage.createMultipart(
        { key: input.key, identity: input.identity },
        signal,
      );
      await input.onUploadCreated(uploadId);
      signal.throwIfAborted();
      for (const entry of input.entries) {
        zip.addReadStreamLazy(
          entry.path,
          {
            compress: false,
            size: Number(entry.size),
            mtime: new Date("2000-01-01T00:00:00.000Z"),
            mode: 0o100644,
          },
          (callback) => {
            const open = async () => {
              signal.throwIfAborted();
              const source =
                entry.sourceKey !== undefined
                  ? await input.storage.openSource(entry.sourceKey, signal)
                  : entry.openContent !== undefined
                    ? await entry.openContent(signal)
                    : Readable.from([
                        typeof entry.content === "string"
                          ? Buffer.from(entry.content, "utf8")
                          : entry.content!,
                      ]);
              track(source);
              active = addAbortSignal(signal, source);
              source.on("error", fail);
              signal.throwIfAborted();
              async function* checked() {
                let size = 0n;
                const hash = createHash("sha256");
                try {
                  for await (const chunk of source) {
                    signal.throwIfAborted();
                    const data = Buffer.isBuffer(chunk)
                      ? chunk
                      : Buffer.from(chunk as Uint8Array);
                    size += BigInt(data.length);
                    if (size > entry.size) {
                      const error = new Error("Archive source length mismatch");
                      fail(error);
                      throw error;
                    }
                    hash.update(data);
                    // Bound the generated/output stream's chunk size even for a coarse source.
                    for (
                      let offset = 0;
                      offset < data.length;
                      offset += 64 * 1024
                    )
                      yield data.subarray(offset, offset + 64 * 1024);
                  }
                  if (size !== entry.size)
                    throw new Error("Archive source length mismatch");
                  if (hash.digest("hex") !== entry.sha256.toLowerCase())
                    throw new Error("Archive source checksum mismatch");
                } finally {
                  source.destroy();
                  if (active === source) active = undefined;
                }
              }
              const checkedStream = addAbortSignal(
                signal,
                Readable.from(checked(), {
                  objectMode: false,
                  highWaterMark: 64 * 1024,
                }),
              );
              checkedStream.on("error", fail);
              track(checkedStream);
              callback(null, checkedStream);
            };
            const operation: Promise<void> = open()
              .catch((error) => {
                fail(error);
                callback(error, Readable.from([]));
              })
              .finally(() => opening.delete(operation));
            opening.add(operation);
          },
        );
      }
      zip.end();
      const limiter = new ArchiveRateLimiter(input.getRateMiB, signal);
      const hash = createHash("sha256");
      let bytes = 0n;
      let buffer = Buffer.allocUnsafe(partSize);
      let used = 0;
      let partNumber = 0;
      const enqueue = async (body: Buffer) => {
        signal.throwIfAborted();
        if (++partNumber > 10_000)
          throw new Error("Archive multipart part limit exceeded");
        const number = partNumber;
        const operation = input.storage
          .uploadPart(
            { key: input.key, uploadId, partNumber: number, body },
            signal,
          )
          .then(async (part) => {
            if (
              part.partNumber !== number ||
              part.size !== body.length ||
              !part.etag
            )
              throw new Error("Invalid archive part receipt");
            await input.onPartUploaded(part);
            parts.push(part);
          });
        const tracked: Promise<void> = operation
          .catch((error) => {
            fail(error);
            throw error;
          })
          .finally(() => pending.delete(tracked));
        pending.add(tracked);
        // Attach a handler immediately, even when concurrency has not filled yet.
        void tracked.catch(() => {});
        if (pending.size >= concurrency) await Promise.race(pending);
      };
      for await (const chunk of output) {
        signal.throwIfAborted();
        const data = chunk as Buffer;
        for (let offset = 0; offset < data.length;) {
          const count = Math.min(
            64 * 1024,
            data.length - offset,
            partSize - used,
          );
          await limiter.consume(count);
          signal.throwIfAborted();
          const slice = data.subarray(offset, offset + count);
          hash.update(slice);
          bytes += BigInt(count);
          if (input.maxBytes !== undefined && bytes > input.maxBytes)
            throw new Error("Archive output byte budget exceeded");
          slice.copy(buffer, used);
          used += count;
          offset += count;
          if (used === partSize) {
            await enqueue(buffer);
            buffer = Buffer.allocUnsafe(partSize);
            used = 0;
          }
        }
      }
      if (used) await enqueue(buffer.subarray(0, used));
      await Promise.all(pending);
      signal.throwIfAborted();
      const result: ArchiveResult = {
        bytes,
        sha256: hash.digest("hex"),
        uploadId,
        parts: parts.sort((a, b) => a.partNumber - b.partNumber),
      };
      await input.onCompleteIntent(result);
      signal.throwIfAborted();
      await input.storage.completeMultipart(
        { key: input.key, uploadId, parts: result.parts },
        signal,
      );
      signal.throwIfAborted();
      return result;
    } catch (error) {
      fail(error);
      // Settlement means every issued upload has actually completed/rejected.
      await Promise.allSettled(pending);
      await Promise.allSettled(opening);
      await Promise.allSettled(settlements);
      throw firstError ?? error;
    } finally {
      active?.destroy();
      for (const stream of streams) stream.destroy();
      output.destroy();
      signal.removeEventListener("abort", aborted);
    }
  }
}
