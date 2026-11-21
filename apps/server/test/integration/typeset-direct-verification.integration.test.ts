import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { test, mock } from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { configureApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../src/files/object-storage.js";
import { TypesetUploadsService } from "../../src/typesetting/typeset-uploads.service.js";
import { TypesetCollaborationService } from "../../src/typesetting/typeset-collaboration.service.js";
import { tokenHash } from "../../src/users/password.js";
import type { TypesetUploadFileDto } from "../../src/typesetting/typeset-upload.dto.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable _test database required");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const checksum = createHash("sha256").update(png).digest("hex");

test("direct image verification isolates snapshots, admits bounded parallel files, rebinds without reupload and preserves adopted drafts", async () => {
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
      ),
    ],
  }).compile();
  const app = module.createNestApplication();
  configureApplication(app);
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl(),
    db = app.get(PrismaService),
    files = app.get(FileObjectsService),
    uploads = app.get(TypesetUploadsService),
    collaboration = app.get(TypesetCollaborationService),
    storage = app.get<ObjectStorage>(OBJECT_STORAGE);
  let actorId = "",
    authorId = "",
    workId = "";
  const stagedKeys: string[] = [];
  let release: () => void = () => {};
  try {
    const user = await db.user.create({
      data: {
        username: `direct_${randomUUID()}`,
        displayName: "Direct fixture",
        passwordHash: "non-login",
        mustChangePassword: false,
        roles: { create: { role: "typesetter" } },
      },
    });
    actorId = user.id;
    const token = randomBytes(32).toString("base64url");
    await db.authSession.create({
      data: {
        userId: actorId,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const session = await uploads.create(actorId, {
      files: [0, 1, 2].map((i) => ({
        sourceName: `same-${i === 2 ? 2 : 1}.png`,
        contentType: "image/png",
        size: png.length,
        checksum,
      })),
    });
    const rows = await db.typesetUploadFile.findMany({
      where: { sessionId: session.id },
      orderBy: { orderIndex: "asc" },
    });
    for (const row of rows) {
      stagedKeys.push(row.objectKey);
      await storage.put({
        key: row.objectKey,
        body: png,
        size: png.length,
        contentType: "image/png",
        checksum,
      });
    }
    let opened = 0,
      notifyOpened: () => void = () => {};
    const openedBoth = new Promise<void>((r) => {
      notifyOpened = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const copyStorage = storage as ObjectStorage &
      Required<Pick<ObjectStorage, "copy">>;
    const originalCopy = copyStorage.copy.bind(storage);
    const copying = mock.method(
      copyStorage,
      "copy",
      async (source: string, key: string, signal?: AbortSignal) => {
        await originalCopy(source, key, signal);
        opened++;
        if (opened === 2) notifyOpened();
        await gate;
      },
    );
    const first = uploads.verifyFile(actorId, session.id, rows[0].id),
      second = uploads.verifyFile(actorId, session.id, rows[1].id);
    await openedBoth;
    assert.equal(
      (await uploads.verifyFile(actorId, session.id, rows[0].id)).status,
      "verifying",
    );
    await assert.rejects(
      uploads.verifyFile(actorId, session.id, rows[2].id),
      /繁忙/,
    );
    // Both snapshots exist while source is overwritten using an old write capability.
    await storage.delete(rows[0].objectKey);
    await storage.put({
      key: rows[0].objectKey,
      body: Buffer.alloc(png.length),
      size: png.length,
      contentType: "image/png",
      checksum,
    });
    // A short unrelated transaction is admitted while storage remains paused.
    await db.user.update({
      where: { id: actorId },
      data: { displayName: "Direct fixture active" },
    });
    release();
    const [one, two] = await Promise.all([first, second]);
    copying.mock.restore();
    assert.equal(one.status, "processed");
    assert.equal(two.status, "processed");
    assert.equal(opened, 2);
    const adopted = await db.typesetUploadImage.findFirstOrThrow({
      where: { id: one.images[0].id },
      include: { fileObject: true },
    });
    assert.deepEqual(
      Buffer.from(await storage.read(adopted.fileObject.objectKey)),
      png,
    );
    assert.ok(!adopted.fileObject.objectKey.startsWith("staging/"));
    const before = await db.fileObject.count({
      where: { createdById: actorId },
    });
    const response = await fetch(
      `${base}/api/typeset/upload-sessions/${session.id}/files/${rows[0].id}/verify`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "X-Comiku-Request": "1",
          "Content-Type": "application/json",
          Cookie: `comiku_session=${token}`,
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 200);
    const receipt = (await response.json()) as TypesetUploadFileDto;
    assert.equal(receipt.id, rows[0].id);
    assert.equal(receipt.upload, null);
    assert.equal(
      await db.fileObject.count({ where: { createdById: actorId } }),
      before,
    );
    const denied = await fetch(
      `${base}/api/typeset/upload-sessions/${session.id}/files/${rows[0].id}/verify`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
          Cookie: `comiku_session=${token}`,
        },
        body: "{}",
      },
    );
    assert.equal(denied.status, 403);
    await storage.delete(rows[2].objectKey);
    await storage.put({
      key: rows[2].objectKey,
      body: Buffer.alloc(png.length),
      size: png.length,
      contentType: "image/png",
      checksum,
    });
    const invalid = await uploads.verifyFile(actorId, session.id, rows[2].id);
    assert.equal(invalid.status, "failed");
    assert.match(invalid.error!, /校验/);
    await storage.delete(rows[2].objectKey);
    await storage.put({
      key: rows[2].objectKey,
      body: png,
      size: png.length,
      contentType: "image/png",
      checksum,
    });
    assert.equal(
      (await uploads.verifyFile(actorId, session.id, rows[2].id)).status,
      "processed",
    );
    const author = await db.author.create({
      data: { displayName: "Direct fixture author" },
    });
    authorId = author.id;
    const candidate = await db.candidatePost.create({
      data: {
        authorId,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    const work = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: candidate.id,
        importedById: actorId,
        collaborationMode: "multi",
        workflowStatus: "typesetting",
        typesetHandoffStartedAt: new Date(),
        images: {
          create: { originalFileObjectId: adopted.fileObjectId, orderIndex: 0 },
        },
        stageParticipants: {
          create: {
            stage: "typeset",
            userId: actorId,
            participationMode: "owner",
          },
        },
      },
      include: { images: true, stageParticipants: true },
    });
    workId = work.id;
    await db.workPageAssignment.create({
      data: {
        workId,
        workImageId: work.images[0].id,
        stage: "typeset",
        participantId: work.stageParticipants[0].id,
      },
    });
    const input = {
      sessionId: session.id,
      expectedRevision: work.revision,
      idempotencyKey: randomUUID(),
    };
    await collaboration.previewSession(actorId, workId, input);
    await db.work.update({
      where: { id: workId },
      data: { revision: { increment: 1 } },
    });
    const next = {
      ...input,
      expectedRevision: work.revision + 1,
      idempotencyKey: randomUUID(),
    };
    await assert.rejects(
      collaboration.previewSession(actorId, workId, next),
      /更新/,
    );
    const rebound = await collaboration.previewSession(actorId, workId, {
      ...next,
      rebind: true,
    });
    assert.equal(rebound.images[0].id, one.images[0].id);
    await collaboration.apply(actorId, workId, {
      sessionId: session.id,
      expectedRevision: next.expectedRevision,
      idempotencyKey: randomUUID(),
      mappings: [
        {
          imageId: one.images[0].id,
          workImageId: work.images[0].id,
          position: "page",
        },
      ],
    });
    const preview = await db.typesetUploadPreview.findUniqueOrThrow({
      where: { sessionId_workId: { sessionId: session.id, workId } },
    });
    assert.ok(preview.appliedAt);
    await assert.rejects(
      collaboration.previewSession(actorId, workId, {
        ...next,
        expectedRevision: next.expectedRevision + 1,
        rebind: true,
      }),
      /采用/,
    );
    await db.typesetUploadSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await uploads.cleanupExpired();
    assert.equal(
      await db.typesetUploadImage.count({
        where: { uploadFile: { sessionId: session.id } },
      }),
      0,
    );
    assert.equal(
      (
        await db.fileObject.findUniqueOrThrow({
          where: { id: adopted.fileObjectId },
        })
      ).lifecycleStatus,
      "active",
    );
    assert.deepEqual(
      Buffer.from(await storage.read(adopted.fileObject.objectKey)),
      png,
    );
  } finally {
    release();
    mock.restoreAll();
    if (actorId) {
      if (workId) {
        await db.workTypesetDraft.deleteMany({ where: { workId } });
        await db.typesetUploadPreview.deleteMany({ where: { workId } });
      }
      await db.typesetUploadImage.deleteMany({
        where: { uploadFile: { session: { actorId } } },
      });
      await db.typesetUploadFile.deleteMany({
        where: { session: { actorId } },
      });
      await db.typesetUploadSession.deleteMany({ where: { actorId } });
      if (workId) {
        await db.workPageAssignment.deleteMany({ where: { workId } });
        await db.workEvent.deleteMany({ where: { workId } });
        await db.workStageParticipant.deleteMany({ where: { workId } });
        await db.workImage.deleteMany({ where: { workId } });
        await db.work.delete({ where: { id: workId } });
      }
      if (authorId) {
        await db.candidatePost.deleteMany({ where: { authorId } });
        await db.author.delete({ where: { id: authorId } });
      }
      for (const file of await db.fileObject.findMany({
        where: { createdById: actorId },
      }))
        await files.purgeUnreferenced(file.id);
      await db.backgroundJob.deleteMany({ where: { actorId } });
      await db.authSession.deleteMany({ where: { userId: actorId } });
      await db.userRole.deleteMany({ where: { userId: actorId } });
      await db.user.delete({ where: { id: actorId } });
    }
    for (const key of stagedKeys) await storage.delete(key);
    await app.close();
  }
});

test("expired snapshot cleanup waits for the adopter session lock and rechecks its completed receipt", async () => {
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
      ),
    ],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  const db = app.get(PrismaService),
    uploads = app.get(TypesetUploadsService),
    storage = app.get<ObjectStorage>(OBJECT_STORAGE),
    files = app.get(FileObjectsService);
  let actorId = "",
    sessionId = "";
  let release: () => void = () => {};
  let adopter: Promise<void> | undefined;
  try {
    const actor = await db.user.create({
      data: {
        username: `cleanup_direct_${randomUUID()}`,
        displayName: "Cleanup fixture",
        passwordHash: "non-login",
        roles: { create: { role: "typesetter" } },
      },
    });
    actorId = actor.id;
    const session = await uploads.create(actorId, {
      files: [
        {
          sourceName: "snapshot.png",
          contentType: "image/png",
          size: png.length,
          checksum,
        },
      ],
    });
    sessionId = session.id;
    const attempt = await db.typesetUploadVerification.create({
      data: {
        uploadFileId: session.files[0].id,
        objectKey: `works/typeset-upload-preview/${session.id}/${randomUUID()}`,
        expiresAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    await storage.put({
      key: attempt.objectKey,
      body: png,
      size: png.length,
      contentType: "image/png",
      checksum,
    });
    let locked: () => void = () => {};
    const entered = new Promise<void>((r) => {
      locked = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ownerPid = 0;
    adopter = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM typeset_upload_sessions WHERE id=${sessionId}::uuid FOR UPDATE`;
        const [owner] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        ownerPid = owner.pid;
        locked();
        await gate;
        const adopted = await files.adoptCopiedObjectTx(tx, {
          objectKey: attempt.objectKey,
          contentType: "image/png",
          size: png.length,
          checksum,
          createdById: actorId,
        });
        await tx.typesetUploadImage.create({
          data: {
            uploadFileId: session.files[0].id,
            fileObjectId: adopted.id,
            sourceName: "snapshot.png",
            width: 1,
            height: 1,
            orderIndex: 0,
          },
        });
        await tx.typesetUploadFile.update({
          where: { id: session.files[0].id },
          data: { status: "processed" },
        });
        await tx.typesetUploadVerification.update({
          where: { id: attempt.id },
          data: { status: "completed" },
        });
      },
      { timeout: 15000 },
    );
    await entered;
    const cleanup = uploads.cleanupExpired();
    // Observe an actual PostgreSQL waiter instead of guessing a sleep duration.
    const deadline = Date.now() + 5000;
    let observed = false;
    while (Date.now() < deadline) {
      const waits = await db.$queryRaw<
        { blocked: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${ownerPid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
      if (waits[0].blocked) {
        observed = true;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(
      observed,
      "cleanup must wait for the same upload-session row lock",
    );
    release();
    await adopter;
    await cleanup;
    assert.equal(
      (
        await db.typesetUploadVerification.findUniqueOrThrow({
          where: { id: attempt.id },
        })
      ).status,
      "completed",
    );
    assert.deepEqual(Buffer.from(await storage.read(attempt.objectKey)), png);
    const abandoned = await db.typesetUploadVerification.create({
      data: {
        uploadFileId: session.files[0].id,
        objectKey: `works/typeset-upload-preview/${session.id}/${randomUUID()}`,
        status: "failed",
        expiresAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    await storage.put({
      key: abandoned.objectKey,
      body: png,
      size: png.length,
      contentType: "image/png",
      checksum,
    });
    await uploads.cleanupExpired();
    assert.equal(await storage.head(abandoned.objectKey), null);
    // A late copy writes only its abandoned key, never a newer adopted key.
    await storage.put({
      key: abandoned.objectKey,
      body: png,
      size: png.length,
      contentType: "image/png",
      checksum,
    });
    await db.typesetUploadVerification.update({
      where: { id: abandoned.id },
      data: { cleanedAt: new Date(Date.now() - 16 * 60_000) },
    });
    await uploads.cleanupExpired();
    assert.equal(await storage.head(abandoned.objectKey), null);
    assert.deepEqual(Buffer.from(await storage.read(attempt.objectKey)), png);
  } finally {
    release();
    await adopter?.catch(() => undefined);
    if (sessionId) {
      await db.typesetUploadImage.deleteMany({
        where: { uploadFile: { sessionId } },
      });
      await db.typesetUploadSession.delete({ where: { id: sessionId } });
    }
    if (actorId) {
      for (const file of await db.fileObject.findMany({
        where: { createdById: actorId },
      }))
        await files.purgeUnreferenced(file.id);
      await db.backgroundJob.deleteMany({ where: { actorId } });
      await db.userRole.deleteMany({ where: { userId: actorId } });
      await db.user.delete({ where: { id: actorId } });
    }
    await app.close();
  }
});
