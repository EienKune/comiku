import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { unzipSync } from "fflate";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  archiveEntryPath,
  planArchivePackages,
  validateArchivePath,
  type ArchiveEntry,
} from "../src/archive-exports/archive-format.js";
import { ArchiveRateLimiter } from "../src/archive-exports/archive-rate-limit.js";
import {
  ARCHIVE_PART_SIZE,
  archiveObjectKey,
  createArchiveStorage,
  R2ArchiveStorage,
  type ArchiveStorage,
  type ArchivePart,
  type ArchiveIdentity,
} from "../src/archive-exports/archive-storage.js";
import {
  ArchiveWriter,
  type ArchiveWriteInput,
} from "../src/archive-exports/archive-writer.js";

const identity = { runId: "run", packageId: "package", attemptId: "attempt" };
const key = archiveObjectKey(identity);
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
function textEntry(path: string, content: string): ArchiveEntry {
  return {
    path,
    content,
    size: BigInt(Buffer.byteLength(content)),
    sha256: sha(content),
  };
}
class FakeStorage implements ArchiveStorage {
  sources = new Map<string, () => Readable>();
  uploaded: Buffer[] = [];
  receipts: ArchivePart[] = [];
  completed = false;
  completeError = false;
  reads = 0;
  async openSource(key: string) {
    this.reads++;
    return this.sources.get(key)!();
  }
  async createMultipart() {
    return "upload";
  }
  async uploadPart(input: { body: Buffer; partNumber: number }) {
    this.uploaded.push(Buffer.from(input.body));
    const receipt = {
      partNumber: input.partNumber,
      size: input.body.length,
      etag: `etag-${input.partNumber}`,
    };
    this.receipts.push(receipt);
    return receipt;
  }
  async completeMultipart() {
    this.completed = true;
    if (this.completeError) throw new Error("Lost complete reply");
  }
  async abortMultipart() {
    throw new Error("Writer must leave durable cleanup to its owner");
  }
  async head() {
    return null;
  }
  async listMultipart() {
    return [];
  }
  async listParts() {
    return this.receipts;
  }
  async delete() {
    throw new Error("Writer must not delete");
  }
  async signedDownload() {
    return "synthetic";
  }
}
function input(
  storage: ArchiveStorage,
  entries: ArchiveEntry[],
  overrides: Partial<ArchiveWriteInput> = {},
): ArchiveWriteInput {
  return {
    storage,
    entries,
    key,
    identity,
    signal: new AbortController().signal,
    getRateMiB: () => 0,
    onUploadCreated: async () => {},
    onPartUploaded: async () => {},
    onCompleteIntent: async () => {},
    ...overrides,
  };
}

test("STORE ZIP preserves Chinese names, exact bytes and CRC; intent precedes external complete", async () => {
  const storage = new FakeStorage();
  const entries = [
    textEntry(
      archiveEntryPath(2026, 11, 4321, "raw", "4321_翻译.txt"),
      "测试译文\r\n日本語\r\n",
    ),
    textEntry("2026-11/4321/生肉/空文件.txt", ""),
  ];
  const events: string[] = [];
  const result = await new ArchiveWriter().write(
    input(storage, entries, {
      onUploadCreated: async () => {
        events.push("created");
      },
      onPartUploaded: async () => {
        events.push("part");
      },
      onCompleteIntent: async (result) => {
        assert.equal(storage.completed, false);
        assert.equal(result.parts.length, 1);
        events.push("intent");
      },
    }),
  );
  assert.deepEqual(events, ["created", "part", "intent"]);
  assert.equal(storage.completed, true);
  const zip = Buffer.concat(storage.uploaded);
  assert.equal(result.bytes, BigInt(zip.length));
  assert.equal(result.sha256, sha(zip));
  const files = unzipSync(zip);
  for (const entry of entries)
    assert.deepEqual(
      Buffer.from(files[entry.path]),
      Buffer.from(entry.content!),
    );
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  let cursor = zip.readUInt32LE(eocd + 16);
  for (const entry of entries) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 10), 0); // ZIP STORE
    assert.equal(
      zip.readUInt32LE(cursor + 16),
      crc32(Buffer.from(entry.content!)),
    );
    const nameBytes = zip.readUInt16LE(cursor + 28);
    assert.equal(
      zip.subarray(cursor + 46, cursor + 46 + nameBytes).toString("utf8"),
      entry.path,
    );
    cursor +=
      46 +
      nameBytes +
      zip.readUInt16LE(cursor + 30) +
      zip.readUInt16LE(cursor + 32);
  }
});

test("slow upload backpressures a 40MiB real source and cancellation waits for issued upload settlement", async () => {
  const storage = new FakeStorage();
  const controller = new AbortController();
  const chunk = Buffer.alloc(64 * 1024, 17);
  const count = 640;
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) hash.update(chunk);
  let produced = 0,
    sourceClosed = false;
  storage.sources.set("source", () =>
    Readable.from(
      (async function* () {
        try {
          for (let i = 0; i < count; i++) {
            produced += chunk.length;
            yield chunk;
          }
        } finally {
          sourceClosed = true;
        }
      })(),
    ),
  );
  let entered!: () => void, release!: () => void;
  const uploadEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const uploadGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  storage.uploadPart = async (args) => {
    entered();
    await uploadGate;
    return {
      partNumber: args.partNumber,
      size: args.body.length,
      etag: "synthetic",
    };
  };
  const writing = new ArchiveWriter().write(
    input(
      storage,
      [
        {
          path: "2026-11/1/生肉/a.bin",
          sourceKey: "source",
          size: BigInt(chunk.length * count),
          sha256: hash.digest("hex"),
        },
      ],
      { signal: controller.signal },
    ),
  );
  let settled = false;
  void writing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await uploadEntered;
  await setTimeout(20);
  assert.ok(produced >= ARCHIVE_PART_SIZE);
  assert.ok(
    produced < ARCHIVE_PART_SIZE + 2 * 1024 ** 2,
    `source ran ahead: ${produced}`,
  );
  controller.abort(new Error("cancelled"));
  await setTimeout(20);
  assert.equal(
    settled,
    false,
    "do not call owner settled while a sent upload is unresolved",
  );
  release();
  await assert.rejects(writing, /cancelled|abort/i);
  assert.equal(sourceClosed, true);
  assert.equal(storage.completed, false);
});

test("two uploads stay bounded, full parts are fixed size and exact complete receipts survive", async () => {
  const storage = new FakeStorage();
  const chunk = Buffer.alloc(64 * 1024, 9),
    count = 900;
  const hash = createHash("sha256");
  for (let n = 0; n < count; n++) hash.update(chunk);
  let active = 0,
    maximum = 0,
    outputBytes = 0;
  storage.sources.set("large", () =>
    Readable.from(
      (function* () {
        for (let i = 0; i < count; i++) yield chunk;
      })(),
    ),
  );
  storage.uploadPart = async (args) => {
    active++;
    maximum = Math.max(maximum, active);
    await setTimeout(args.partNumber % 2 ? 5 : 1);
    active--;
    assert.ok(args.body.length <= ARCHIVE_PART_SIZE);
    if (args.partNumber <= 3) assert.equal(args.body.length, ARCHIVE_PART_SIZE);
    outputBytes += args.body.length;
    return {
      partNumber: args.partNumber,
      size: args.body.length,
      etag: `part-${args.partNumber}`,
    };
  };
  const result = await new ArchiveWriter().write(
    input(
      storage,
      [
        {
          path: "2026-11/1/生肉/a.bin",
          sourceKey: "large",
          size: BigInt(chunk.length * count),
          sha256: hash.digest("hex"),
        },
      ],
      { uploadConcurrency: 2 },
    ),
  );
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(result.bytes, BigInt(outputBytes));
  assert.deepEqual(
    result.parts.map((part) => part.partNumber),
    [1, 2, 3, 4],
  );
});

test("source checksum, short/long source and output budget failures never publish a ZIP", async () => {
  for (const entry of [
    { ...textEntry("2026-11/1/生肉/a.txt", "content"), sha256: "0".repeat(64) },
    { ...textEntry("2026-11/1/生肉/a.txt", "content"), size: 3n },
    { ...textEntry("2026-11/1/生肉/a.txt", "content"), size: 30n },
  ]) {
    const storage = new FakeStorage();
    let intent = false;
    await assert.rejects(
      new ArchiveWriter().write(
        input(storage, [entry], {
          onCompleteIntent: async () => {
            intent = true;
          },
        }),
      ),
      /mismatch|unexpected number/,
    );
    assert.equal(intent, false);
    assert.equal(storage.completed, false);
  }
  const storage = new FakeStorage();
  await assert.rejects(
    new ArchiveWriter().write(
      input(storage, [textEntry("a.txt", "content")], { maxBytes: 1n }),
    ),
    /byte budget/,
  );
  assert.equal(storage.completed, false);
});

test("lazy text and object entries open one at a time and retain checksum validation", async () => {
  const storage = new FakeStorage();
  const content = Buffer.alloc(64 * 1024, 0x31);
  let live = 0,
    maximum = 0,
    opened = 0;
  const open = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    opened++;
    live++;
    maximum = Math.max(maximum, live);
    return Readable.from(
      (async function* () {
        try {
          yield content;
          await setTimeout(1);
        } finally {
          live--;
        }
      })(),
    );
  };
  const entries = Array.from({ length: 8 }, (_, n) => ({
    path: `2026-11/1/生肉/${n}.txt`,
    size: BigInt(content.length),
    sha256: sha(content),
    openContent: open,
  }));
  await new ArchiveWriter().write(input(storage, entries));
  assert.equal(opened, 8);
  assert.equal(maximum, 1);
  assert.equal(live, 0);
  await assert.rejects(
    new ArchiveWriter().write(
      input(storage, [{ ...entries[0], sha256: "0".repeat(64) }]),
    ),
    /checksum mismatch/,
  );
  await assert.rejects(
    new ArchiveWriter().write(
      input(storage, [{ ...entries[0], content: "duplicate source" }]),
    ),
    /Invalid archive entry/,
  );
});

test("complete intent is durable first; a lost complete reply retains all recovery evidence", async () => {
  const storage = new FakeStorage();
  await assert.rejects(
    new ArchiveWriter().write(
      input(storage, [textEntry("a.txt", "content")], {
        onCompleteIntent: async () => {
          throw new Error("persist failed");
        },
      }),
    ),
    /persist failed/,
  );
  assert.equal(storage.completed, false);
  storage.completeError = true;
  let recorded = false;
  await assert.rejects(
    new ArchiveWriter().write(
      input(storage, [textEntry("a.txt", "content")], {
        onCompleteIntent: async (receipt) => {
          assert.ok(receipt.bytes > 0n);
          assert.equal(receipt.sha256.length, 64);
          recorded = true;
        },
      }),
    ),
    /Lost complete reply/,
  );
  assert.equal(recorded, true);
  assert.equal(storage.completed, true);
});

test("failed create receipt prevents opening sources; pre-aborted calls do no storage work", async () => {
  const storage = new FakeStorage();
  await assert.rejects(
    new ArchiveWriter().write(
      input(
        storage,
        [{ path: "a.txt", sourceKey: "source", size: 1n, sha256: sha("a") }],
        {
          onUploadCreated: async () => {
            throw new Error("receipt failed");
          },
        },
      ),
    ),
    /receipt failed/,
  );
  assert.equal(storage.reads, 0);
  const signal = AbortSignal.abort(new Error("already cancelled"));
  await assert.rejects(
    new ArchiveWriter().write(
      input(storage, [textEntry("a.txt", "a")], { signal }),
    ),
    /already cancelled/,
  );
});

test("cancellation waits for an already-issued source GET and closes its late response", async () => {
  const storage = new FakeStorage();
  const controller = new AbortController();
  let entered!: () => void, release!: (source: Readable) => void;
  const opening = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<Readable>((resolve) => {
    release = resolve;
  });
  storage.openSource = async () => {
    entered();
    return response;
  };
  const writing = new ArchiveWriter().write(
    input(
      storage,
      [{ path: "a.bin", sourceKey: "late", size: 1n, sha256: sha("a") }],
      { signal: controller.signal },
    ),
  );
  let settled = false;
  void writing.catch(() => {
    settled = true;
  });
  await opening;
  controller.abort(new Error("cancel GET"));
  await setTimeout(10);
  assert.equal(settled, false);
  const lateSource = Readable.from([Buffer.from("a")]);
  release(lateSource);
  await assert.rejects(writing, /cancel GET|abort/i);
  assert.equal(lateSource.destroyed, true);
});

test("cancel during complete keeps the persisted intent and reports cancellation after complete settles", async () => {
  const storage = new FakeStorage();
  const controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const completing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intent = false;
  storage.completeMultipart = async () => {
    entered();
    await gate;
    storage.completed = true;
  };
  const writing = new ArchiveWriter().write(
    input(storage, [textEntry("a.txt", "content")], {
      signal: controller.signal,
      onCompleteIntent: async () => {
        intent = true;
      },
    }),
  );
  await completing;
  controller.abort(new Error("cancel complete"));
  release();
  await assert.rejects(writing, /cancel complete/);
  assert.equal(intent, true);
  assert.equal(storage.completed, true); // Owner must HEAD/reconcile, not assume abort means absent.
});

test("multipart capacity is rejected before GET/create and 20k entry bound plans independent ZIPs", async () => {
  const storage = new FakeStorage();
  let created = false;
  storage.createMultipart = async () => {
    created = true;
    return "unexpected";
  };
  await assert.rejects(
    new ArchiveWriter().write(
      input(storage, [
        {
          path: "too-large.bin",
          sourceKey: "large",
          size: BigInt(ARCHIVE_PART_SIZE) * 10_000n,
          sha256: "0".repeat(64),
        },
      ]),
    ),
    /multipart byte budget/,
  );
  assert.equal(created, false);
  assert.equal(storage.reads, 0);
  const entries = Array.from({ length: 20_001 }, (_, index) =>
    textEntry(`2026-11/1/生肉/${index}.txt`, ""),
  );
  assert.deepEqual(
    planArchivePackages(entries).map((group) => group.length),
    [20_000, 1],
  );
  await assert.rejects(
    new ArchiveWriter().write(input(storage, entries)),
    /Invalid archive write input/,
  );
});

test("smooth rate limiter supports zero unlimited, live changes and abort without DB access", async () => {
  let now = 0,
    calls = 0,
    rate = 1;
  const limiter = new ArchiveRateLimiter(
    () => rate,
    new AbortController().signal,
    () => now,
    async (ms) => {
      calls++;
      assert.ok(ms <= 100);
      now += ms;
    },
  );
  await limiter.consume(1024 * 1024);
  assert.ok(now >= 1000 && now < 1001);
  assert.equal(calls, 10);
  rate = 0;
  await limiter.consume(100 * 1024 ** 3);
  assert.equal(calls, 10);
  rate = 0.01;
  const changing = new ArchiveRateLimiter(
    () => rate,
    new AbortController().signal,
    () => now,
    async (ms) => {
      now += ms;
      rate = 0;
    },
  );
  const before = now;
  await changing.consume(1024 ** 2);
  assert.equal(now - before, 100);
  const controller = new AbortController();
  const pending = new ArchiveRateLimiter(
    () => 0.0001,
    controller.signal,
  ).consume(64 * 1024);
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test("safe archive paths reject traversal, control/bidi characters and ambiguous extraction names", async () => {
  for (const path of [
    "../a",
    "a/../b",
    "/a",
    "a//b",
    "a\\b",
    "C:/a",
    "a\u0000b",
    "a/CON.txt",
    "a/foo.",
    "a/\u202eb",
    "a/e\u0301.txt",
  ])
    assert.throws(() => validateArchivePath(path));
  assert.equal(
    validateArchivePath("2026-11/123/生肉/123_翻译.txt"),
    "2026-11/123/生肉/123_翻译.txt",
  );
  const entries = [
    textEntry("2026-11/1/生肉/a.txt", "a"),
    textEntry("2026-11/1/熟肉/b.txt", "b"),
  ];
  assert.equal(planArchivePackages(entries).length, 1);
  assert.equal(planArchivePackages(entries, 2n ** 31n, 1).length, 2);
  assert.throws(() =>
    planArchivePackages([textEntry("a.txt", "a"), textEntry("A.txt", "b")]),
  );
  await assert.rejects(
    new ArchiveWriter().write(
      input(new FakeStorage(), [
        textEntry("a.txt", "a"),
        textEntry("A.txt", "b"),
      ]),
    ),
    /Invalid archive entry/,
  );
  const oversized = {
    ...textEntry("2026-11/2/生肉/c.bin", ""),
    size: 5n * 1024n ** 3n,
  };
  const planned = planArchivePackages([
    ...entries,
    oversized,
    textEntry("2026-11/3/生肉/d.txt", "d"),
  ]);
  assert.deepEqual(
    planned.map((group) => group.length),
    [2, 1, 1],
  ); // Planning only; not a >4GiB streaming test.
});

test("S3 archive adapter namespaces all requests and rejects cleanup of business objects", async () => {
  const requests: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      requests.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "CreateMultipartUploadCommand")
        return { UploadId: "synthetic" };
      if (command.constructor.name === "HeadObjectCommand")
        return {
          ContentLength: 123,
          Metadata: {
            "archive-run": "run",
            "archive-package": "package",
            "archive-attempt": "attempt",
          },
        };
      if (command.constructor.name === "ListMultipartUploadsCommand")
        return {
          Uploads: [
            { Key: "test/" + key, UploadId: "u" },
            { Key: "test/" + key + "-other", UploadId: "foreign" },
          ],
        };
      return {};
    },
  } as unknown as S3Client;
  const config = {
    accountId: "synthetic",
    bucket: "synthetic",
    accessKeyId: "not-a-credential",
    secretAccessKey: "not-a-credential",
    keyPrefix: "test/",
  };
  assert.equal(
    createArchiveStorage({
      archiveExports: { enabled: false },
      r2: config,
      objectStorageDriver: "r2",
    }),
    null,
  );
  assert.equal(
    createArchiveStorage({
      archiveExports: { enabled: true },
      r2: undefined,
      objectStorageDriver: "r2",
    }),
    null,
  );
  const storage = new R2ArchiveStorage(config, client);
  assert.equal(
    createArchiveStorage({
      archiveExports: { enabled: true },
      r2: config,
      objectStorageDriver: "local",
    }),
    null,
  );
  await storage.createMultipart(
    { key, identity },
    new AbortController().signal,
  );
  assert.deepEqual(requests[0].input.Metadata, {
    "archive-run": "run",
    "archive-package": "package",
    "archive-attempt": "attempt",
  });
  assert.equal(requests[0].input.Key, "test/" + key);
  assert.deepEqual(await storage.head(key), { bytes: 123n, identity });
  assert.deepEqual(await storage.listMultipart(key), [{ key, uploadId: "u" }]);
  const count = requests.length;
  await assert.rejects(
    storage.delete("uploads/original.png"),
    /Invalid archive object key/,
  );
  await assert.rejects(
    storage.abortMultipart("../archive-exports/x", "u"),
    /Invalid archive object key/,
  );
  assert.equal(requests.length, count);
  await assert.rejects(
    storage.createMultipart(
      { key, identity: { ...identity, attemptId: "wrong" } as ArchiveIdentity },
      new AbortController().signal,
    ),
    /identity mismatch/,
  );
});

test("S3 part reconciliation paginates with a hard bound and preserves controlled prefixes", async () => {
  const requests: { name: string; input: Record<string, unknown> }[] = [];
  let destroyed = false;
  const client = {
    destroy() {
      destroyed = true;
    },
    async send(command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) {
      requests.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "ListPartsCommand") {
        if (!command.input.PartNumberMarker)
          return {
            Parts: [{ PartNumber: 1, ETag: "one", Size: ARCHIVE_PART_SIZE }],
            IsTruncated: true,
            NextPartNumberMarker: "1",
          };
        return {
          Parts: [{ PartNumber: 2, ETag: "two", Size: 7 }],
          IsTruncated: false,
        };
      }
      return {};
    },
  } as unknown as S3Client;
  const storage = new R2ArchiveStorage(
    {
      accountId: "synthetic",
      bucket: "bucket",
      accessKeyId: "synthetic",
      secretAccessKey: "synthetic",
      keyPrefix: "isolated/",
    },
    client,
  );
  const parts = await storage.listParts(key, "upload");
  assert.deepEqual(parts, [
    { partNumber: 1, etag: "one", size: ARCHIVE_PART_SIZE },
    { partNumber: 2, etag: "two", size: 7 },
  ]);
  await storage.completeMultipart(
    { key, uploadId: "upload", parts },
    new AbortController().signal,
  );
  await storage.abortMultipart(key, "upload");
  await storage.delete(key);
  assert.ok(
    requests.every((request) => request.input.Key === "isolated/" + key),
  );
  assert.deepEqual(
    requests.find(
      (request) => request.name === "CompleteMultipartUploadCommand",
    )?.input.MultipartUpload,
    {
      Parts: [
        { PartNumber: 1, ETag: "one" },
        { PartNumber: 2, ETag: "two" },
      ],
    },
  );
  storage.close();
  assert.equal(destroyed, true);
  let pages = 0;
  const neverEnding = new R2ArchiveStorage(
    {
      accountId: "synthetic",
      bucket: "bucket",
      accessKeyId: "synthetic",
      secretAccessKey: "synthetic",
    },
    {
      async send() {
        return {
          Parts: [],
          IsTruncated: true,
          NextPartNumberMarker: String(++pages),
        };
      },
    } as unknown as S3Client,
  );
  await assert.rejects(neverEnding.listParts(key, "upload"), /listing budget/);
  assert.equal(pages, 10);
});
