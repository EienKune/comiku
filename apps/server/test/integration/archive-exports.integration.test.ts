import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { unzipSync } from "fflate";
import type { Actor } from "../../src/common/access.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import type { ObjectStorage } from "../../src/files/object-storage.js";
import { ArchiveExportsService } from "../../src/archive-exports/archive-exports.service.js";
import { ArchiveRuntimeService } from "../../src/archive-exports/archive-runtime.service.js";
import { ARCHIVE_SCOPE } from "../../src/archive-exports/archive-common.js";
import type { DeleteArchiveExportFilesDto } from "../../src/archive-exports/archive-exports.dto.js";
import type {
  ArchiveIdentity,
  ArchiveStorage,
  ArchivePart,
} from "../../src/archive-exports/archive-storage.js";

const sha = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");
class SyntheticArchiveStorage implements ArchiveStorage {
  sources = new Map<string, Buffer>();
  objects = new Map<string, { body: Buffer; identity: ArchiveIdentity }>();
  uploads = new Map<
    string,
    { key: string; identity: ArchiveIdentity; parts: Buffer[] }
  >();
  deleted: string[] = [];
  failDelete = false;
  loseCompletionReply = false;
  async openSource(key: string) {
    const body = this.sources.get(key);
    if (!body) throw Error("source_unavailable");
    return Readable.from([body]);
  }
  async createMultipart(input: { key: string; identity: ArchiveIdentity }) {
    const id = randomUUID();
    this.uploads.set(id, { ...input, parts: [] });
    return id;
  }
  async uploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: Buffer;
  }): Promise<ArchivePart> {
    const upload = this.uploads.get(input.uploadId)!;
    assert.equal(upload.key, input.key);
    upload.parts[input.partNumber - 1] = Buffer.from(input.body);
    return {
      partNumber: input.partNumber,
      etag: sha(input.body),
      size: input.body.length,
    };
  }
  async completeMultipart(input: { key: string; uploadId: string }) {
    const upload = this.uploads.get(input.uploadId)!;
    this.objects.set(input.key, {
      body: Buffer.concat(upload.parts),
      identity: upload.identity,
    });
    this.uploads.delete(input.uploadId);
    if (this.loseCompletionReply) {
      this.loseCompletionReply = false;
      throw Error("synthetic lost completion reply");
    }
  }
  async abortMultipart(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async head(key: string) {
    const value = this.objects.get(key);
    return value
      ? { bytes: BigInt(value.body.length), identity: value.identity }
      : null;
  }
  async listMultipart(key: string) {
    return [...this.uploads]
      .filter(([, value]) => value.key === key)
      .map(([uploadId]) => ({ key, uploadId }));
  }
  async listParts() {
    return [];
  }
  async delete(key: string) {
    assert.ok(
      key.startsWith("archive-exports/"),
      "delete must never target a business source",
    );
    if (this.failDelete) throw Error("synthetic denied delete");
    this.objects.delete(key);
    this.deleted.push(key);
  }
  async signedDownload(key: string) {
    return `https://archive.invalid/${key}`;
  }
}

test("archive month snapshots, ZIP integrity and confirmed deletion preserve all business files and text", async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw Error("Disposable _test database required");
  const env = parseEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: url,
    ARCHIVE_EXPORT_ENABLED: "true",
  });
  const db = new PrismaService(env);
  await db.$connect();
  const jobs = new JobsService(db),
    storage = new SyntheticArchiveStorage();
  const service = new ArchiveExportsService(db, jobs, env, storage);
  const runtime = new ArchiveRuntimeService(db, jobs, env, storage);
  runtime.onModuleInit();
  const users: string[] = [],
    authors: string[] = [],
    fileIds: string[] = [];
  async function actor(role: "admin" | "source"): Promise<Actor> {
    const user = await db.user.create({
      data: {
        username: `archive_${randomUUID()}`,
        displayName: "Synthetic archive actor",
        passwordHash: "disabled",
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    users.push(user.id);
    const session = await db.authSession.create({
      data: {
        userId: user.id,
        tokenHash: sha(Buffer.from(randomUUID())),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { userId: user.id, sessionId: session.id };
  }
  async function work(
    authorId: string,
    actorId: string,
    createdAt: string,
    archived = false,
  ) {
    const post = await db.candidatePost.create({
      data: {
        authorId,
        platform: "archive-fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: { synthetic: true },
        status: "imported",
      },
    });
    return db.work.create({
      data: {
        authorId,
        importedById: actorId,
        sourceCandidatePostId: post.id,
        title: "Synthetic exported work",
        createdAt: new Date(createdAt),
        ...(archived ? { workflowStatus: "archived" } : {}),
      },
    });
  }
  async function file(actorId: string, text: string) {
    const body = Buffer.from(text),
      key = `synthetic-archive/${randomUUID()}`;
    const value = await db.fileObject.create({
      data: {
        objectKey: key,
        bucketScope: "source",
        kind: "source",
        contentType: "image/png",
        size: BigInt(body.length),
        checksum: sha(body),
        createdById: actorId,
      },
    });
    fileIds.push(value.id);
    storage.sources.set(key, body);
    return value;
  }
  async function drain() {
    for (let i = 0; i < 20; i++) {
      if (!(await jobs.runNext("heavy", undefined, ARCHIVE_SCOPE))) return;
    }
    throw Error("Archive queue did not settle in bounded synthetic drain");
  }
  try {
    const admin = await actor("admin"),
      source = await actor("source");
    const author = await db.author.create({
      data: {
        displayName: "Synthetic archive author",
        authorizationStatus: "authorized",
      },
    });
    authors.push(author.id);
    // November starts at October 31 16:00 UTC in Shanghai.
    const kept = await work(author.id, admin.userId, "2025-10-31T16:00:00Z");
    const out = await work(author.id, admin.userId, "2025-11-30T16:00:00Z");
    const archived = await work(
      author.id,
      admin.userId,
      "2025-11-10T00:00:00Z",
      true,
    );
    const raw = await file(admin.userId, "synthetic original bytes"),
      rendered = await file(admin.userId, "synthetic finished bytes"),
      spare = await file(admin.userId, "snapshot-only source pin");
    const image = await db.workImage.create({
      data: { workId: kept.id, originalFileObjectId: raw.id, orderIndex: 0 },
    });
    await db.workImage.create({
      data: {
        workId: archived.id,
        originalFileObjectId: raw.id,
        orderIndex: 0,
      },
    });
    await db.workImage.create({
      data: { workId: out.id, originalFileObjectId: raw.id, orderIndex: 0 },
    });
    await db.translationEntry.create({
      data: {
        workImageId: image.id,
        orderIndex: 0,
        markerX: 0.1,
        markerY: 0.2,
        markerPositionType: "inside",
        translatedText: "newer mutable draft",
        creationIdempotencyKey: randomUUID(),
        createdById: admin.userId,
        updatedById: admin.userId,
      },
    });
    const text = await db.translationVersion.create({
      data: {
        workId: kept.id,
        versionNumber: 1,
        kind: "proofread_submission",
        stage: "proofread",
        workRevision: 0,
        editorEpoch: 1,
        createdById: admin.userId,
        entries: {
          create: {
            workImageId: image.id,
            orderIndex: 0,
            markerX: 0.1,
            markerY: 0.2,
            markerPositionType: "inside",
            translatedText: "  reviewed line\nsecond line  ",
          },
        },
      },
    });
    const version = await db.typesetImageVersion.create({
      data: {
        workId: kept.id,
        versionNumber: 1,
        uploadedById: admin.userId,
        idempotencyKey: randomUUID(),
        sourceTranslationVersionId: text.id,
        images: {
          create: {
            workImageId: image.id,
            fileObjectId: rendered.id,
            orderIndex: 0,
            sourceName: "finished.png",
            width: 1,
            height: 1,
          },
        },
      },
    });
    await db.work.update({
      where: { id: kept.id },
      data: { currentTypesetVersionId: version.id },
    });
    const before = await db.work.findUniqueOrThrow({ where: { id: kept.id } });
    const scope = { year: 2025, month: 11, content: "both" as const };
    const initialSettings = await service.settings(admin);
    assert.equal(initialSettings.bandwidthLimitMiB, 0);
    const limited = await service.updateSettings(admin, {
      expectedRevision: initialSettings.revision,
      bandwidthLimitMiB: 3,
    });
    await assert.rejects(
      service.updateSettings(admin, {
        expectedRevision: initialSettings.revision,
        bandwidthLimitMiB: 1,
      }),
      /变化/,
    );
    await service.updateSettings(admin, {
      expectedRevision: limited.revision,
      bandwidthLimitMiB: 0,
    });
    await assert.rejects(service.settings(source), /管理权限/);
    const preview = await service.preview(admin, scope);
    assert.equal(preview.workCount, 1);
    assert.equal(preview.imageCount, 2);
    assert.equal(preview.textCount, 1);
    assert.equal(
      (await service.preview(admin, { ...scope, includeArchived: true }))
        .workCount,
      2,
    );
    const input = { ...scope, idempotencyKey: randomUUID() };
    const run = await service.create(admin, input);
    assert.equal((await service.create(admin, input)).id, run.id);
    await assert.rejects(
      service.create(admin, { ...input, month: 12 }),
      /幂等键/,
    );
    await assert.rejects(
      service.create(admin, { ...input, idempotencyKey: randomUUID() }),
      /活动/,
    );
    assert.equal(await jobs.runNext("heavy", undefined, ARCHIVE_SCOPE), true);
    const snapshot = await db.archiveExportWorkSnapshot.findFirstOrThrow({
      where: { runId: run.id },
    });
    assert.equal(snapshot.translationVersionId, text.id);
    assert.equal(snapshot.typesetVersionId, version.id);
    const sample = await db.archiveExportEntry.findFirstOrThrow({
      where: { runId: run.id, kind: "raw" },
    });
    // A source referenced only by an export remains pinned against the ordinary purge path.
    const pin = await db.archiveExportEntry.create({
      data: {
        runId: run.id,
        snapshotId: snapshot.id,
        ordinal: 10000,
        kind: "raw",
        path: "synthetic/pin.png",
        fileObjectId: spare.id,
        sourceFileObjectId: spare.id,
        sourceKey: spare.objectKey,
        size: spare.size,
        checksum: spare.checksum,
      },
    });
    const purged: string[] = [];
    const files = new FileObjectsService(
      db,
      {
        delete: async (key: string) => {
          purged.push(key);
        },
      } as ObjectStorage,
      jobs,
    );
    await files.purgeUnreferenced(spare.id);
    assert.equal(purged.length, 0);
    assert.ok(await db.fileObject.findUnique({ where: { id: spare.id } }));
    await db.archiveExportEntry.delete({ where: { id: pin.id } });
    assert.equal(sample.fileObjectId, raw.id);
    storage.loseCompletionReply = true;
    await drain();
    const done = await service.get(admin, run.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.completedPackageCount, 1);
    const packages = await service.packages(admin, run.id, { limit: 20 });
    const pkg = packages.items[0];
    assert.equal(pkg.downloadable, true);
    const object = [...storage.objects.values()][0];
    const zip = unzipSync(object.body),
      paths = Object.keys(zip);
    assert.equal(paths.length, 4);
    assert.ok(
      paths.every((path) => path.startsWith(`2025-11/${kept.workNumber}/`)),
    );
    assert.ok(
      paths.some((path) =>
        Buffer.from(zip[path]).equals(storage.sources.get(raw.objectKey)!),
      ),
    );
    assert.ok(
      paths.some((path) =>
        Buffer.from(zip[path]).equals(storage.sources.get(rendered.objectKey)!),
      ),
    );
    const exportedText = Buffer.from(
      zip[paths.find((path) => path.endsWith(".txt"))!],
    ).toString("utf8");
    assert.ok(
      exportedText
        .replaceAll("\r\n", "\n")
        .includes("  reviewed line\nsecond line  "),
    );
    assert.ok(!exportedText.includes("mutable draft"));
    const manifest = JSON.parse(
      Buffer.from(zip[paths.find((path) => path.endsWith(".json"))!]).toString(
        "utf8",
      ),
    );
    assert.equal(manifest.author, author.displayName);
    assert.equal(manifest.translationVersionId, text.id);
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: kept.id } })).revision,
      before.revision,
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: kept.id } })).editorEpoch,
      before.editorEpoch,
    );
    assert.match(
      (await service.download(admin, run.id, pkg.id)).url,
      /^https:\/\/archive.invalid\//,
    );
    const confirmation = {
      expectedRevision: done.revision,
      idempotencyKey: randomUUID(),
      confirmedDownloaded: true as const,
    };
    const unconfirmed = {
      ...confirmation,
      confirmedDownloaded: false,
    } as unknown as DeleteArchiveExportFilesDto;
    await assert.rejects(
      service.mutate(admin, run.id, "delete-files", unconfirmed),
      /确认/,
    );
    await assert.rejects(
      service.mutate(admin, run.id, "delete-files", {
        ...confirmation,
        expectedRevision: done.revision - 1,
      }),
      /变化/,
    );
    storage.failDelete = true;
    await service.mutate(admin, run.id, "delete-files", confirmation);
    await drain();
    let failed = await service.get(admin, run.id);
    assert.equal(failed.filesStatus, "delete_failed");
    assert.equal(failed.deletionError, "archive_cleanup_failed");
    await assert.rejects(service.download(admin, run.id, pkg.id), /不可下载/);
    storage.failDelete = false;
    failed = await service.get(admin, run.id);
    await service.mutate(admin, run.id, "delete-files", {
      expectedRevision: failed.revision,
      idempotencyKey: randomUUID(),
      confirmedDownloaded: true,
    });
    await drain();
    const deleted = await service.get(admin, run.id);
    assert.equal(deleted.filesStatus, "deleted");
    assert.ok(deleted.filesDeletedAt);
    assert.equal(storage.objects.size, 0);
    assert.ok(storage.deleted.length);
    assert.equal(
      (await db.fileObject.findUniqueOrThrow({ where: { id: raw.id } }))
        .lifecycleStatus,
      "active",
    );
    assert.equal(
      (await db.fileObject.findUniqueOrThrow({ where: { id: rendered.id } }))
        .lifecycleStatus,
      "active",
    );
    assert.equal(
      await db.translationEntry.count({ where: { workImageId: image.id } }),
      1,
    );
    assert.equal(
      await db.translationVersionEntry.count({ where: { versionId: text.id } }),
      1,
    );
    assert.ok(
      (await service.list(admin, { limit: 10 })).items.some(
        (item) => item.id === run.id,
      ),
    );
    // Cancellation before a worker claim leaves a retryable history entry.
    const cancelled = await service.create(admin, {
      ...scope,
      idempotencyKey: randomUUID(),
    });
    await service.mutate(admin, cancelled.id, "cancel", {
      expectedRevision: cancelled.revision,
      idempotencyKey: randomUUID(),
    });
    await runtime.maintain();
    let cancelledState = await service.get(admin, cancelled.id);
    assert.equal(cancelledState.status, "cancelled");
    await service.mutate(admin, cancelled.id, "retry", {
      expectedRevision: cancelledState.revision,
      idempotencyKey: randomUUID(),
    });
    storage.sources.delete(raw.objectKey);
    await drain();
    // Move only this synthetic job's persisted retry clock, without waiting wall time.
    for (let attempt = 0; attempt < 4; attempt++) {
      await db.backgroundJob.updateMany({
        where: {
          executionScope: ARCHIVE_SCOPE,
          status: "queued",
          actorId: admin.userId,
        },
        data: { availableAt: new Date(0) },
      });
      await drain();
    }
    cancelledState = await service.get(admin, cancelled.id);
    assert.ok(["failed", "partial"].includes(cancelledState.status));
    const successor = await actor("admin");
    await db.userRole.deleteMany({
      where: { userId: admin.userId, role: "admin" },
    });
    await assert.rejects(
      service.mutate(admin, cancelled.id, "retry", {
        expectedRevision: cancelledState.revision,
        idempotencyKey: randomUUID(),
      }),
      /管理权限/,
    );
    storage.sources.set(raw.objectKey, Buffer.from("synthetic original bytes"));
    await service.mutate(successor, cancelled.id, "retry", {
      expectedRevision: cancelledState.revision,
      idempotencyKey: randomUUID(),
    });
    await drain();
    const recovered = await service.get(successor, cancelled.id);
    assert.equal(recovered.status, "succeeded");
    assert.equal(
      (
        await db.archiveExportRun.findUniqueOrThrow({
          where: { id: cancelled.id },
        })
      ).actorId,
      admin.userId,
    );
    // A different current administrator can remove the archive after its creator loses permission.
    await service.mutate(successor, cancelled.id, "delete-files", {
      expectedRevision: recovered.revision,
      idempotencyKey: randomUUID(),
      confirmedDownloaded: true,
    });
    await drain();
    assert.equal(
      (await service.get(successor, cancelled.id)).filesStatus,
      "deleted",
    );
    await db.userRole.create({ data: { userId: admin.userId, role: "admin" } });
    await db.authSession.update({
      where: { id: admin.sessionId },
      data: { revokedAt: new Date() },
    });
    await assert.rejects(service.get(admin, run.id), /登录已失效/);
  } finally {
    await db.backgroundJob.deleteMany({
      where: { actorId: { in: users }, executionScope: ARCHIVE_SCOPE },
    });
    const exported = await db.archiveExportPackage.findMany({
      where: { run: { actorId: { in: users } } },
      select: { fileObjectId: true },
    });
    const exportRun = { actorId: { in: users } };
    await db.archiveExportMutation.deleteMany({ where: { run: exportRun } });
    await db.archiveExportAttempt.deleteMany({
      where: { package: { run: exportRun } },
    });
    await db.archiveExportEntry.deleteMany({ where: { run: exportRun } });
    await db.archiveExportPackage.deleteMany({ where: { run: exportRun } });
    await db.archiveExportWorkSnapshot.deleteMany({
      where: { run: exportRun },
    });
    await db.archiveExportMonth.deleteMany({ where: { run: exportRun } });
    await db.archiveExportRun.deleteMany({ where: { actorId: { in: users } } });
    await db.work.updateMany({
      where: { authorId: { in: authors } },
      data: { currentTypesetVersionId: null },
    });
    await db.typesetImageVersionImage.deleteMany({
      where: { version: { work: { authorId: { in: authors } } } },
    });
    await db.typesetImageVersion.deleteMany({
      where: { work: { authorId: { in: authors } } },
    });
    await db.translationVersionEntry.deleteMany({
      where: { version: { work: { authorId: { in: authors } } } },
    });
    await db.translationVersion.deleteMany({
      where: { work: { authorId: { in: authors } } },
    });
    await db.work.deleteMany({ where: { authorId: { in: authors } } });
    await db.candidatePost.deleteMany({ where: { authorId: { in: authors } } });
    await db.fileObject.deleteMany({
      where: {
        OR: [
          {
            id: {
              in: [
                ...fileIds,
                ...exported.flatMap((value) =>
                  value.fileObjectId ? [value.fileObjectId] : [],
                ),
              ],
            },
          },
          { createdById: { in: users } },
        ],
      },
    });
    await db.author.deleteMany({ where: { id: { in: authors } } });
    await db.accountAudit.deleteMany({ where: { actorId: { in: users } } });
    await db.authSession.deleteMany({ where: { userId: { in: users } } });
    await db.userRole.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});
