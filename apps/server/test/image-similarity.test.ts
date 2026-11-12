import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import {
  FingerprintInputError,
  fingerprintImage,
  phash64,
  readFingerprintInput,
} from "../src/image-similarity/fingerprint.js";
import {
  similarityCoverageQuery,
  similarityMatchesQuery,
} from "../src/image-similarity/image-similarity-query.js";
import { ImageSimilarityService } from "../src/image-similarity/image-similarity.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { BackgroundJob } from "../src/generated/prisma/client.js";
import { parseEnvironment } from "../src/config/environment.js";
const testEnvironment = parseEnvironment({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1/discovery_test",
});
import { FINGERPRINT_RECIPE } from "../src/image-similarity/fingerprint.js";

test("DCT64 DC is excluded; uniform values and exact bit representation are stable", () => {
  assert.equal(phash64(new Uint8Array(1024)), "0000000000000000");
  assert.equal(phash64(new Uint8Array(1024).fill(255)), "0000000000000000");
  const fixture = Uint8Array.from(
    { length: 1024 },
    (_, i) => (i * 71 + Math.floor(i / 32) * 29) % 256,
  );
  const value = phash64(fixture);
  assert.equal(value, "5f8abb5158f0841b");
  assert.match(value, /^[0-9a-f]{16}$/);
  assert.equal(BigInt(`0x${value}`) >> 63n, 0n);
  assert.equal(value, phash64(fixture));
  assert.throws(() => phash64(new Uint8Array(100)));
});

test("synthetic normalization composites transparency onto white and records original SHA", async () => {
  const transparent = await sharp({
    create: {
      width: 60,
      height: 40,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const white = await sharp({
    create: { width: 60, height: 40, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const a = await fingerprintImage(transparent);
  const b = await fingerprintImage(white);
  assert.equal(a.phashHex, b.phashHex);
  assert.notEqual(a.sourceSha256, b.sourceSha256);
  assert.equal(
    a.sourceSha256,
    createHash("sha256").update(transparent).digest("hex"),
  );
  assert.equal(a.width, 60);
  assert.equal(a.height, 40);
});

test("EXIF orientation and first animation frame are explicitly normalized", async () => {
  const pixels = Buffer.from(
    Uint8Array.from({ length: 48 * 32 * 3 }, (_, i) => i % 251),
  );
  const oriented = await sharp(pixels, {
    raw: { width: 48, height: 32, channels: 3 },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const canonical = await sharp(oriented).rotate().png().toBuffer();
  assert.equal(
    (await fingerprintImage(oriented)).phashHex,
    (await fingerprintImage(canonical)).phashHex,
  );
  const result = await fingerprintImage(oriented);
  assert.equal(result.width, 32);
  assert.equal(result.height, 48);
  const gif = await sharp(
    Buffer.concat([
      Buffer.alloc(20 * 20 * 3, 0),
      Buffer.alloc(20 * 20 * 3, 255),
    ]),
    { raw: { width: 20, height: 40, pageHeight: 20, channels: 3 } },
  )
    .gif({ delay: [100, 100] })
    .toBuffer();
  assert.equal((await fingerprintImage(gif)).height, 20);
});

test("malformed, unsupported and over-pixel-limit images have safe errors", async () => {
  await assert.rejects(
    () => fingerprintImage(new Uint8Array([0, 1, 2])),
    (e: unknown) =>
      e instanceof FingerprintInputError && e.code === "invalid_image",
  );
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
  );
  await assert.rejects(
    () => fingerprintImage(svg),
    (e: unknown) =>
      e instanceof FingerprintInputError && e.code === "unsupported_format",
  );
  const large = await sharp({
    create: { width: 6400, height: 6400, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    () => fingerprintImage(large),
    (e: unknown) =>
      e instanceof FingerprintInputError && e.code === "invalid_image",
  );
});

test("actual streamed byte limits and cancellation destroy the original stream", async () => {
  const stream = Readable.from([Buffer.alloc(5), Buffer.alloc(6)]);
  await assert.rejects(
    () => readFingerprintInput(stream, new AbortController().signal, 10),
    (e: unknown) =>
      e instanceof FingerprintInputError && e.code === "byte_limit",
  );
  assert.equal(stream.destroyed, true);
  const controller = new AbortController();
  controller.abort();
  const aborted = Readable.from([Buffer.alloc(1)]);
  await assert.rejects(() => readFingerprintInput(aborted, controller.signal));
  assert.equal(aborted.destroyed, true);
  const stalled = new Readable({ read() {} });
  const active = new AbortController();
  const pending = readFingerprintInput(stalled, active.signal);
  active.abort();
  await assert.rejects(pending);
  assert.equal(stalled.destroyed, true);
});

test("global SQL computes bounded TopK before metadata hydration and does not scope author/history", () => {
  const query = similarityMatchesQuery("a".repeat(64), "1".repeat(16));
  assert.match(query.sql, /bit_count/);
  assert.match(query.sql, /# \('x'/);
  assert.match(query.sql, /LIMIT/);
  assert.ok(query.values.includes(12));
  assert.ok(query.values.includes(10));
  assert.doesNotMatch(query.sql, /w\.workflow_status\s*(?:<>|!=|IN)/i);
  assert.match(
    similarityCoverageQuery().sql,
    /SELECT DISTINCT original_file_object_id/,
  );
  assert.throws(() => similarityMatchesQuery("injection", "1".repeat(16)));
  assert.doesNotMatch(
    similarityMatchesQuery("a".repeat(64), null).sql,
    /bit_count/,
  );
});

function handlerFixture(
  body: Buffer,
  options: {
    attempts?: number;
    unavailable?: boolean;
    checksum?: string;
    lostLease?: boolean;
  } = {},
) {
  const checksum =
    options.checksum ?? createHash("sha256").update(body).digest("hex");
  const row = {
    id: "fingerprint",
    fileObjectId: "file",
    sourceSha256: checksum,
    recipeVersion: FINGERPRINT_RECIPE,
    jobId: "job",
    status: "queued",
    fileObject: {
      id: "file",
      checksum,
      lifecycleStatus: "active",
      deletedAt: null,
      size: BigInt(body.length),
    },
  };
  const writes: Record<string, unknown>[] = [];
  let reads = 0;
  let leases = 0;
  const tx = {
    $queryRaw: async () => [],
    imageFingerprint: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const db = {
    imageFingerprint: { findUnique: async () => row },
    $transaction: async (action: (tx: unknown) => unknown) => action(tx),
  };
  let handler!: (job: BackgroundJob, signal: AbortSignal) => Promise<void>;
  const jobs = {
    register: (_kind: string, value: typeof handler) => {
      handler = value;
    },
    registerClaimGate: () => {},
    assertLease: async () => {
      leases++;
      if (options.lostLease) throw new Error("lease changed");
    },
  };
  const files = {
    readStream: async () => {
      reads++;
      if (options.unavailable)
        throw new Error("private upstream diagnostics must not escape");
      return { body: Readable.from([body]) };
    },
  };
  const service = new ImageSimilarityService(
    db as unknown as PrismaService,
    files as unknown as FileObjectsService,
    jobs as unknown as JobsService,
    testEnvironment,
  );
  service.onModuleInit();
  const job = {
    id: "job",
    resourceId: "fingerprint",
    leaseId: "lease",
    attempts: options.attempts ?? 1,
    payload: { sourceSha256: checksum },
  } as unknown as BackgroundJob;
  return {
    run: (signal = new AbortController().signal) => handler(job, signal),
    row,
    writes,
    reads: () => reads,
    leases: () => leases,
  };
}

test("fingerprint handler fences all writes, persists once and reuses ready results", async () => {
  const body = await sharp({
    create: { width: 20, height: 30, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const fixture = handlerFixture(body);
  await fixture.run();
  assert.equal(fixture.row.status, "ready");
  assert.equal(fixture.reads(), 1);
  assert.equal(fixture.leases(), fixture.writes.length);
  assert.equal(fixture.writes.at(-1)?.phashHex, "0000000000000000");
  await fixture.run();
  assert.equal(fixture.reads(), 1);
  const stale = handlerFixture(body, { lostLease: true });
  await assert.rejects(() => stale.run(), /lease changed/);
  assert.equal(stale.reads(), 0);
  assert.equal(stale.writes.length, 0);
});

test("deterministic bad input terminates safely; transient reads retry then fail without raw diagnostics", async () => {
  const malformed = handlerFixture(Buffer.from("invalid image"));
  await malformed.run();
  assert.equal(malformed.row.status, "failed");
  assert.equal(malformed.writes.at(-1)?.lastError, "invalid_image");
  const retry = handlerFixture(Buffer.from("read"), { unavailable: true });
  await assert.rejects(
    () => retry.run(),
    /^Error: Fingerprint original read failed$/,
  );
  assert.equal(retry.row.status, "queued");
  assert.equal(retry.writes.at(-1)?.lastError, "fingerprint_read_failed");
  const terminal = handlerFixture(Buffer.from("read"), {
    unavailable: true,
    attempts: 3,
  });
  await assert.rejects(() => terminal.run());
  assert.equal(terminal.row.status, "failed");
});

test("shutdown retains resumable running state; a new lease execution finishes the same fingerprint", async () => {
  const body = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const interrupted = handlerFixture(body);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => interrupted.run(controller.signal));
  assert.equal(interrupted.row.status, "running");
  assert.equal(interrupted.reads(), 0);
  await interrupted.run();
  assert.equal(interrupted.row.status, "ready");
  assert.equal(interrupted.reads(), 1);
});

function searchFixture(
  options: {
    ready?: boolean;
    terminal?: boolean;
    partial?: boolean;
    roles?: string[];
    current?: boolean;
  } = {},
) {
  let writes = 0;
  let reads = 0;
  const tx = {
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: (options.roles ?? ["source"]).map((role) => ({ role })),
      }),
    },
    candidateMedia: {
      findFirst: async () =>
        options.current === false
          ? null
          : {
              fileObjectId: "file",
              fileObject: { id: "file", checksum: "a".repeat(64) },
            },
    },
    imageFingerprint: {
      findUnique: async () => ({
        status: options.ready === false ? "running" : "ready",
        sourceSha256: "a".repeat(64),
        phashHex: "1".repeat(16),
        jobId: "job",
      }),
      createMany: async () => {
        writes++;
      },
    },
    backgroundJob: {
      findUnique: async () => ({
        status: options.terminal ? "failed" : "running",
      }),
    },
    $queryRaw: async () => {
      reads++;
      return reads === 1
        ? [
            {
              total: 4,
              ready: options.partial ? 2 : 4,
              pending: options.partial ? 1 : 0,
              failed: options.partial ? 1 : 0,
            },
          ]
        : [{ workId: "target", matchKind: "perceptual", distance: 3 }];
    },
  };
  const db = {
    $transaction: async (action: (client: unknown) => unknown) => action(tx),
  };
  const service = new ImageSimilarityService(
    db as unknown as PrismaService,
    {} as FileObjectsService,
    {} as JobsService,
    testEnvironment,
  );
  return { service, writes: () => writes, reads: () => reads };
}

test("GET is read-only; incomplete coverage cannot certify no matches", async () => {
  const ready = searchFixture();
  assert.equal(
    (await ready.service.search("actor", "candidate", "media")).state,
    "ready",
  );
  assert.equal(ready.writes(), 0);
  const partial = searchFixture({ partial: true });
  const response = await partial.service.search("actor", "candidate", "media");
  assert.equal(response.state, "partial");
  assert.equal(response.coverage.pending, 1);
  assert.equal(response.coverage.failed, 1);
  const interrupted = searchFixture({ ready: false, terminal: true });
  assert.equal(
    (await interrupted.service.search("actor", "candidate", "media")).state,
    "failed",
  );
  assert.equal(interrupted.writes(), 0);
});

test("service checks both source-read and work-read authorization plus candidate media membership", async () => {
  const unauthorized = searchFixture({ roles: ["translator"] });
  await assert.rejects(
    () => unauthorized.service.search("actor", "candidate", "media"),
    /当前职务/,
  );
  assert.equal(unauthorized.reads(), 0);
  const absent = searchFixture({ current: false });
  await assert.rejects(
    () => absent.service.search("actor", "candidate", "other-media"),
    /候选图片不存在/,
  );
  assert.equal(absent.reads(), 0);
});

test("covered history discovery is throttled while outstanding admission stays globally bounded", async () => {
  let scans = 0;
  let outstanding = 0;
  const db = {
    $transaction: async (action: (tx: unknown) => unknown) =>
      action({
        $executeRaw: async () => 0,
        backgroundJob: {
          count: async (args: unknown) => {
            assert.deepEqual(args, {
              where: {
                kind: "image_fingerprint",
                lane: "heavy",
                executionScope: "global",
                status: { in: ["queued", "running"] },
              },
            });
            return outstanding;
          },
        },
        fileObject: {
          findMany: async () => {
            scans++;
            return [];
          },
        },
      }),
  };
  const service = new ImageSimilarityService(
    db as unknown as PrismaService,
    {} as FileObjectsService,
    {} as JobsService,
    testEnvironment,
  );
  outstanding = 2;
  assert.equal(await service.schedulePending(), 0);
  assert.equal(scans, 0);
  outstanding = 0;
  assert.equal(await service.schedulePending(), 0);
  assert.equal(scans, 1);
  await service.schedulePending();
  assert.equal(
    scans,
    1,
    "a covered library is not scanned again every maintenance tick",
  );
});
