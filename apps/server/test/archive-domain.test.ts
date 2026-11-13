import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  archiveBounds,
  decodeArchiveCursor,
  encodeArchiveCursor,
} from "../src/archive-exports/archive-common.js";
import {
  archiveTextCandidates,
  encodeArchiveText,
  type ArchiveTextEvidence,
} from "../src/archive-exports/archive-selection.js";
import {
  ArchiveExportScopeDto,
  DeleteArchiveExportFilesDto,
} from "../src/archive-exports/archive-exports.dto.js";
import { ArchiveRuntimeService } from "../src/archive-exports/archive-runtime.service.js";
import { ArchiveExportsService } from "../src/archive-exports/archive-exports.service.js";
import { parseEnvironment } from "../src/config/environment.js";
import { parseLabelPlus } from "../src/labelplus/labelplus-codec.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import {
  JobDeferred,
  type JobClaimGate,
  type JobsService,
} from "../src/jobs/jobs.service.js";
import type { ArchiveStorage } from "../src/archive-exports/archive-storage.js";
import type { BackgroundJob, Prisma } from "../src/generated/prisma/client.js";
import type {
  ArchiveExportAttempt,
  ArchiveExportRun,
} from "../src/generated/prisma/client.js";
import { archiveHash } from "../src/archive-exports/archive-common.js";
import type {
  ArchiveWriteInput,
  ArchiveResult,
} from "../src/archive-exports/archive-writer.js";

const environment = parseEnvironment({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/archive_fixture",
  ARCHIVE_EXPORT_ENABLED: "true",
});
const images = [
  { id: "page-a", originalFileObject: { contentType: "image/png" } },
  { id: "page-b", originalFileObject: { contentType: "image/jpeg" } },
];
const marker = {
  workImageId: "page-b",
  orderIndex: 1,
  markerX: 0.25,
  markerY: 0.8,
  markerPositionType: "outside",
  translatedText: "  保留首尾空格  ",
};

test("archive month and year use Shanghai createdAt boundaries, including December", () => {
  assert.deepEqual(archiveBounds(2026, 1), {
    gte: new Date("2025-12-31T16:00:00Z"),
    lt: new Date("2026-01-31T16:00:00Z"),
  });
  assert.deepEqual(archiveBounds(2026, 12), {
    gte: new Date("2026-11-30T16:00:00Z"),
    lt: new Date("2026-12-31T16:00:00Z"),
  });
  assert.deepEqual(archiveBounds(2026), {
    gte: new Date("2025-12-31T16:00:00Z"),
    lt: new Date("2026-12-31T16:00:00Z"),
  });
});
test("LabelPlus export retains all image sections, blank markers and original body whitespace", () => {
  const encoded = encodeArchiveText(23, images, [
    marker,
    { ...marker, orderIndex: 0, translatedText: "" },
  ]);
  assert.ok(encoded);
  const result = parseLabelPlus(encoded).document;
  assert.deepEqual(
    result.images.map((i) => i.fileName),
    ["23-001.png", "23-002.jpg"],
  );
  assert.equal(result.images[0].markers.length, 0);
  assert.deepEqual(
    result.images[1].markers.map((m) => m.translation),
    ["", marker.translatedText],
  );
  assert.equal(result.images[1].markers[1].positionType, 2);
});
test("whitespace-only text produces no TXT; image IDs never fall back to array positions", () => {
  assert.equal(
    encodeArchiveText(23, images, [{ ...marker, translatedText: "　\n\t " }]),
    null,
  );
  assert.throws(
    () =>
      encodeArchiveText(23, images, [
        { ...marker, workImageId: "other-work-page" },
      ]),
    /text_image_mismatch/,
  );
});
test("codec failures stay explicit and never become empty text", () => {
  assert.throws(
    () =>
      encodeArchiveText(23, images, [
        { ...marker, translatedText: "a".repeat(100001) },
      ]),
    /100,000/,
  );
  assert.throws(
    () => encodeArchiveText(23, images, [{ ...marker, markerX: 2 }]),
    /坐标/,
  );
  assert.throws(
    () =>
      encodeArchiveText(23, images, [
        { ...marker, translatedText: ">>>>>>>>[fake.png]<<<<<<<<" },
      ]),
    /结构标记/,
  );
});
test("adopted reviewed then source pointers outrank an effective handoff", () => {
  const evidence: ArchiveTextEvidence = {
    workId: "work",
    typesetHandoffStartedAt: new Date(),
    requiredHandoffVersionId: "required",
    currentTypesetVersion: {
      workId: "work",
      deletedAt: null,
      reviewedTranslationVersionId: "reviewed",
      sourceTranslationVersionId: "source",
    },
    handoff: { proofreadVersionId: "delivered" },
  };
  assert.deepEqual(
    archiveTextCandidates(evidence).map((c) => c.id),
    ["reviewed", "source", "required", "delivered"],
  );
  assert.deepEqual(
    archiveTextCandidates({ ...evidence, typesetHandoffStartedAt: null }).map(
      (c) => c.id,
    ),
    ["reviewed", "source"],
  );
  assert.deepEqual(
    archiveTextCandidates({
      ...evidence,
      currentTypesetVersion: {
        ...evidence.currentTypesetVersion!,
        workId: "other",
      },
    }).map((c) => c.id),
    ["required", "delivered"],
  );
  assert.deepEqual(
    archiveTextCandidates({
      ...evidence,
      currentTypesetVersion: {
        ...evidence.currentTypesetVersion!,
        deletedAt: new Date(),
      },
    }).map((c) => c.id),
    ["required", "delivered"],
  );
});
test("delete-files requires an actual true confirmation and a revision/idempotency key", async () => {
  const base = {
    expectedRevision: 0,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  };
  for (const confirmedDownloaded of [undefined, false, "true", 1])
    assert.ok(
      (
        await validate(
          plainToInstance(DeleteArchiveExportFilesDto, {
            ...base,
            confirmedDownloaded,
          }),
        )
      ).length,
    );
  assert.equal(
    (
      await validate(
        plainToInstance(DeleteArchiveExportFilesDto, {
          ...base,
          confirmedDownloaded: true,
        }),
      )
    ).length,
    0,
  );
});
test("scope validation rejects loose numeric/string booleans and accepts explicit nullable month", async () => {
  const base = { year: 2026, content: "both", month: null };
  assert.equal(
    (await validate(plainToInstance(ArchiveExportScopeDto, base))).length,
    0,
  );
  for (const invalid of [
    { month: 0 },
    { month: 13 },
    { year: "2026" },
    { content: "all" },
    { includeArchived: "false" },
  ])
    assert.ok(
      (
        await validate(
          plainToInstance(ArchiveExportScopeDto, { ...base, ...invalid }),
        )
      ).length,
    );
});
test("cursor decoding is bounded and verifies its route-specific shape", () => {
  const valid = (v: unknown): v is number =>
    Number.isInteger(v) && Number(v) > 0;
  assert.equal(decodeArchiveCursor(encodeArchiveCursor(3), valid), 3);
  assert.equal(decodeArchiveCursor(undefined, valid), null);
  for (const value of [
    "!",
    "a".repeat(201),
    encodeArchiveCursor({ offset: 3 }),
    encodeArchiveCursor(-1),
  ])
    assert.throws(() => decodeArchiveCursor(value, valid));
});
test("disabled storage does not register handlers or perform maintenance reads", async () => {
  const runtime = new ArchiveRuntimeService(
    {} as PrismaService,
    {
      register: () => assert.fail("must not register"),
    } as unknown as JobsService,
    environment,
    null,
  );
  assert.equal(runtime.enabled, false);
  runtime.onModuleInit();
  await runtime.maintain();
  const service = new ArchiveExportsService(
    {} as PrismaService,
    {} as JobsService,
    environment,
    null,
  );
  await assert.rejects(
    service.preview(
      { userId: "x", sessionId: "y" },
      { year: 2026, content: "raw" },
    ),
    /尚未启用/,
  );
});
test("an expired lease cannot prove a physical archive owner settled or admit another attempt", async () => {
  let gate: JobClaimGate | undefined;
  let calls = 0;
  const jobs = {
    register: () => {},
    registerExecutionLifecycle: () => {},
    registerClaimGate: (_kind: string, value: JobClaimGate) => {
      gate = value;
    },
  } as unknown as JobsService;
  const runtime = new ArchiveRuntimeService(
    {} as PrismaService,
    jobs,
    environment,
    {} as ArchiveStorage,
  );
  runtime.onModuleInit();
  const tx = {
    archiveExportRun: {
      findUnique: async () => ({
        id: "run",
        generation: 1,
        status: "generating",
      }),
      update: async () => {
        calls++;
      },
    },
    archiveExportPackage: {
      findUnique: async () => ({
        id: "package",
        runId: "run",
        status: "queued",
      }),
    },
    archiveExportAttempt: {
      count: async () => 1,
      create: async () => assert.fail("unknown owner cannot be replaced"),
    },
  } as unknown as Prisma.TransactionClient;
  assert.ok(gate);
  const deferred = await gate(
    {
      id: "job",
      resourceId: "package",
      payload: { runId: "run", generation: 1 },
    } as unknown as BackgroundJob,
    tx,
    new Date(),
    { leaseId: "new-lease", ownerId: "new-owner", budgetAttempt: 1 },
  );
  assert.ok(deferred instanceof JobDeferred);
  assert.equal(calls, 1);
});
test("lost adoption reply followed by revoked execution authority preserves the adopted ZIP", async () => {
  let adopted = false,
    revoked = false,
    deletes = 0;
  const entry = {
    id: "entry",
    path: "2026-01/1/生肉/1-001.png",
    size: 3n,
    checksum: archiveHash("abc"),
    sourceKey: "source.png",
    fileObjectId: "source-file",
  };
  const attempt = {
    id: "attempt",
    packageId: "package",
    jobId: "job",
    leaseId: "lease",
    manifestHash: archiveHash(
      JSON.stringify([[entry.path, "3", entry.checksum]]),
    ),
    objectKey: "archive-exports/run/package/attempt.zip",
    completeIntent: false,
    status: "running",
    cleanupStatus: "pending",
  } as unknown as ArchiveExportAttempt;
  const tx = {
    $queryRaw: async () => [],
    archiveExportSettings: {
      findUnique: async () => ({ bandwidthLimitMiB: 0 }),
    },
    archiveExportPackage: {
      findUnique: async () => ({
        adoptedAttemptId: adopted ? attempt.id : null,
        fileObjectId: adopted ? "archive-file" : null,
      }),
      update: async () => {},
    },
    archiveExportAttempt: {
      update: async (input: { data: object }) =>
        Object.assign(attempt, input.data),
    },
  } as unknown as Prisma.TransactionClient;
  const db = {
    $transaction: async (body: (value: Prisma.TransactionClient) => unknown) =>
      body(tx),
    archiveExportAttempt: {
      findUnique: async () => attempt,
      findUniqueOrThrow: async () => attempt,
      findMany: async () => [],
    },
    archiveExportEntry: { findMany: async () => [entry] },
  } as unknown as PrismaService;
  const runtime = new ArchiveRuntimeService(
    db,
    {} as JobsService,
    environment,
    {
      delete: async () => {
        deletes++;
      },
      listMultipart: async () => [],
    } as unknown as ArchiveStorage,
  );
  const harness = runtime as unknown as {
    generate(job: BackgroundJob, signal: AbortSignal): Promise<void>;
    owned(
      job: BackgroundJob,
      action: (
        tx: Prisma.TransactionClient,
        run: ArchiveExportRun,
      ) => Promise<unknown>,
    ): Promise<unknown>;
    adopt(
      job: BackgroundJob,
      attempt: ArchiveExportAttempt,
      result: ArchiveResult,
    ): Promise<void>;
    writer: { write(input: ArchiveWriteInput): Promise<ArchiveResult> };
  };
  harness.owned = async (_job, action) => {
    if (revoked) throw new Error("revoked");
    return action(tx, { status: "generating" } as ArchiveExportRun);
  };
  harness.writer.write = async (input) => {
    const result = {
      bytes: 100n,
      sha256: archiveHash("zip"),
      uploadId: "upload",
      parts: [],
    };
    await input.onCompleteIntent(result);
    return result;
  };
  harness.adopt = async () => {
    adopted = true;
    attempt.status = "succeeded";
    attempt.cleanupStatus = "retained";
    revoked = true;
    throw new Error("database reply lost after commit");
  };
  await harness.generate(
    {
      id: "job",
      resourceId: "package",
      leaseId: "lease",
      payload: { runId: "run", generation: 1 },
    } as unknown as BackgroundJob,
    new AbortController().signal,
  );
  assert.equal(adopted, true);
  assert.equal(revoked, true);
  assert.equal(deletes, 0);
  assert.equal(attempt.status, "succeeded");
  assert.equal(attempt.cleanupStatus, "retained");
});
