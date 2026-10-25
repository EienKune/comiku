import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { test, mock } from "node:test";
import { unzipSync } from "fflate";
import { createApplication } from "../../src/application.js";
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
import { JobsService } from "../../src/jobs/jobs.service.js";
import { DirectUploadsService } from "../../src/transfers/direct-uploads.service.js";
import { DownloadsService } from "../../src/transfers/downloads.service.js";
import { tokenHash } from "../../src/users/password.js";
import type {
  DirectUploadDto,
  DownloadPreparationDto,
  DownloadDeliveryDto,
} from "../../src/transfers/transfers.dto.js";
import type { Prisma, Role } from "../../src/generated/prisma/client.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable _test database required");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

test("direct uploads and asynchronous ZIP delivery preserve adoption permissions, idempotency and handoff boundaries", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl(),
    db = app.get(PrismaService),
    files = app.get(FileObjectsService),
    jobs = app.get(JobsService),
    storage = app.get<ObjectStorage>(OBJECT_STORAGE);
  const users: string[] = [],
    workIds: string[] = [];
  let authorId = "";
  async function member(role: Role) {
    const user = await db.user.create({
      data: {
        username: `transfer_${randomUUID()}`,
        displayName: role,
        passwordHash: "fixture-no-login",
        mustChangePassword: false,
        roles: { create: { role } },
      },
    });
    users.push(user.id);
    const token = randomBytes(32).toString("base64url");
    await db.authSession.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { id: user.id, cookie: `comiku_session=${token}` };
  }
  async function request<T>(
    actor: { cookie: string },
    method: string,
    path: string,
    body?: unknown,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        Cookie: actor.cookie,
        "X-Comiku-Request": "1",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as T };
  }
  async function run(resourceId: string, kind: string) {
    const job = await db.backgroundJob.findFirstOrThrow({
      where: { resourceId, kind },
      orderBy: { createdAt: "desc" },
    });
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { priority: 10000, createdAt: new Date("1900-01-01") },
    });
    const claim = await jobs.claim("heavy");
    assert.equal(claim?.id, job.id);
    await jobs.execute(claim!);
  }
  try {
    const source = await member("source"),
      typesetter = await member("typesetter"),
      admin = await member("admin"),
      outsider = await member("translator");
    const author = await db.author.create({
      data: {
        displayName: "Synthetic author",
        authorizationStatus: "authorized",
      },
    });
    authorId = author.id;
    const descriptor = {
      sourceName: "sample.png",
      contentType: "image/png",
      size: png.length,
      checksum: createHash("sha256").update(png).digest("hex"),
    };
    async function prepareUpload(
      purpose: "author_avatar" | "author_evidence" | "typeset_single",
      resourceId = authorId,
      revision = 0,
      owner = source,
      descriptors = [descriptor],
    ) {
      const created = await request<DirectUploadDto>(
        owner,
        "POST",
        "/api/transfers/uploads",
        { purpose, resourceId, expectedRevision: revision, files: descriptors },
      );
      assert.equal(created.status, 200, JSON.stringify(created.data));
      for (const target of created.data.files) {
        assert.ok(target.upload);
        const put = await fetch(base + target.upload.url, {
          method: "PUT",
          headers: {
            ...target.upload.headers,
            Origin: "http://localhost:5173",
          },
          body: png,
        });
        assert.equal(put.status, 200, await put.text());
      }
      const queued = await request<DirectUploadDto>(
        owner,
        "POST",
        `/api/transfers/uploads/${created.data.id}/finalize`,
        {},
      );
      assert.equal(queued.status, 200);
      assert.equal(queued.data.status, "queued");
      return created.data;
    }
    const avatar = await prepareUpload("author_avatar");
    assert.equal(
      (await db.author.findUniqueOrThrow({ where: { id: authorId } }))
        .avatarFileObjectId,
      null,
    );
    assert.equal(
      (await request(outsider, "GET", `/api/transfers/uploads/${avatar.id}`))
        .status,
      404,
    );
    await run(avatar.id, "direct_author_avatar");
    assert.equal(
      (await app.get(DirectUploadsService).get(source.id, avatar.id)).status,
      "completed",
    );
    const savedAuthor = await db.author.findUniqueOrThrow({
      where: { id: authorId },
    });
    assert.ok(savedAuthor.avatarFileObjectId);
    assert.equal(savedAuthor.revision, 1);
    assert.equal(
      await db.imageDerivative.count({
        where: { sourceFileId: savedAuthor.avatarFileObjectId! },
      }),
      0,
    );
    assert.equal(
      (
        await request<DirectUploadDto>(
          source,
          "POST",
          `/api/transfers/uploads/${avatar.id}/finalize`,
          {},
        )
      ).data.status,
      "completed",
    );
    assert.equal(
      (await db.author.findUniqueOrThrow({ where: { id: authorId } })).revision,
      1,
    );
    const evidence = await prepareUpload("author_evidence", authorId, 1);
    await run(evidence.id, "direct_author_evidence");
    assert.equal(
      (await app.get(DirectUploadsService).get(source.id, evidence.id)).status,
      "completed",
    );
    assert.equal(
      (
        await request(
          outsider,
          "GET",
          `/api/authors/${authorId}/authorization-evidence`,
        )
      ).status,
      403,
    );
    assert.equal(
      await db.authorAuthorizationEvidence.count({ where: { authorId } }),
      1,
    );
    const stale = await prepareUpload("author_avatar", authorId, 2);
    await db.author.update({
      where: { id: authorId },
      data: { revision: { increment: 1 } },
    });
    await run(stale.id, "direct_author_avatar");
    assert.equal(
      (await app.get(DirectUploadsService).get(source.id, stale.id)).status,
      "failed",
    );
    assert.equal(
      (await db.author.findUniqueOrThrow({ where: { id: authorId } }))
        .avatarFileObjectId,
      savedAuthor.avatarFileObjectId,
    );
    const revoked = await prepareUpload("author_avatar", authorId, 3);
    await db.userRole.deleteMany({ where: { userId: source.id } });
    await run(revoked.id, "direct_author_avatar");
    assert.equal(
      (
        await db.directUploadSession.findUniqueOrThrow({
          where: { id: revoked.id },
        })
      ).status,
      "failed",
    );
    await db.userRole.create({ data: { userId: source.id, role: "source" } });
    const forged = await prepareUpload("author_avatar", authorId, 3, source, [
      { ...descriptor, contentType: "image/webp" },
    ]);
    await run(forged.id, "direct_author_avatar");
    assert.equal(
      (await app.get(DirectUploadsService).get(source.id, forged.id)).status,
      "failed",
    );
    assert.match(
      (await app.get(DirectUploadsService).get(source.id, forged.id)).error!,
      /实际格式/,
    );
    assert.equal(
      (
        await request(source, "POST", "/api/transfers/uploads", {
          purpose: "author_avatar",
          resourceId: authorId,
          expectedRevision: 3,
          files: [{ ...descriptor, size: 5 * 1024 * 1024 + 1 }],
        })
      ).status,
      400,
    );
    const expired = await prepareUpload("author_avatar", authorId, 3);
    await db.directUploadSession.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(0) },
    });
    await run(expired.id, "direct_author_avatar");
    assert.equal(
      (await app.get(DirectUploadsService).get(source.id, expired.id)).status,
      "failed",
    );
    const interrupted = await prepareUpload("author_avatar", authorId, 3);
    const interruptedJob = await db.backgroundJob.findFirstOrThrow({
      where: { resourceId: interrupted.id },
    });
    const originalStore = files.store.bind(files);
    const loseLease = mock.method(
      files,
      "store",
      async (input: Parameters<FileObjectsService["store"]>[0]) => {
        const stored = await originalStore(input);
        await db.backgroundJob.update({
          where: { id: interruptedJob.id },
          data: { leaseId: randomUUID(), leaseUntil: new Date(0) },
        });
        return stored;
      },
    );
    await run(interrupted.id, "direct_author_avatar");
    loseLease.mock.restore();
    assert.equal(
      (await db.author.findUniqueOrThrow({ where: { id: authorId } })).revision,
      3,
    );
    assert.equal(
      (
        await db.directUploadSession.findUniqueOrThrow({
          where: { id: interrupted.id },
        })
      ).status,
      "processing",
    );
    await run(interrupted.id, "direct_author_avatar");
    assert.equal(
      (
        await db.directUploadSession.findUniqueOrThrow({
          where: { id: interrupted.id },
        })
      ).status,
      "completed",
    );
    assert.equal(
      (await db.author.findUniqueOrThrow({ where: { id: authorId } })).revision,
      4,
    );
    const original = await files.store({
      body: png,
      contentType: "image/png",
      bucketScope: "works",
      kind: "fixture",
      createdById: typesetter.id,
    });
    async function makeWork() {
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
          importedById: source.id,
          sourceLanguage: "ja",
          workflowStatus: "pending_typeset",
          title: "Synthetic export",
          images: {
            create: { originalFileObjectId: original.id, orderIndex: 0 },
          },
          stageParticipants: {
            create: {
              userId: typesetter.id,
              stage: "typeset",
              participationMode: "owner",
            },
          },
        },
      });
      workIds.push(work.id);
      return work;
    }
    const work = await makeWork();
    const input = {
      purpose: "handoff",
      workId: work.id,
      expectedRevision: work.revision,
      expectedEditorEpoch: work.editorEpoch,
      idempotencyKey: randomUUID(),
    };
    const queued = await request<DownloadPreparationDto>(
      typesetter,
      "POST",
      "/api/transfers/downloads",
      input,
    );
    assert.equal(queued.status, 200);
    assert.equal(queued.data.status, "queued");
    await run(queued.data.id, "download_handoff");
    assert.equal(
      (await app.get(DownloadsService).get(typesetter.id, queued.data.id))
        .status,
      "succeeded",
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: work.id } }))
        .typesetHandoffStartedAt,
      null,
    );
    assert.equal(
      (
        await request(
          outsider,
          "GET",
          `/api/transfers/downloads/${queued.data.id}`,
        )
      ).status,
      404,
    );
    const failedSign = mock.method(storage, "signedReadUrl", async () => {
      throw new Error("Synthetic signing failure");
    });
    await assert.rejects(
      app.get(DownloadsService).deliver(typesetter.id, queued.data.id),
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: work.id } }))
        .typesetHandoffStartedAt,
      null,
    );
    failedSign.mock.restore();
    for (let repeat = 0; repeat < 2; repeat++) {
      const delivery = await request<DownloadDeliveryDto>(
        typesetter,
        "POST",
        `/api/transfers/downloads/${queued.data.id}/deliver`,
        {},
      );
      assert.equal(delivery.status, 200, JSON.stringify(delivery.data));
      assert.equal(delivery.data.fileName, `${work.workNumber}_嵌字交接.zip`);
    }
    const handed = await db.work.findUniqueOrThrow({ where: { id: work.id } });
    assert.equal(handed.workflowStatus, "typesetting");
    assert.equal(handed.revision, work.revision + 1);
    assert.equal(handed.editorEpoch, work.editorEpoch + 1);
    assert.equal(
      await db.workEvent.count({
        where: { workId: work.id, action: "typeset_handoff_started" },
      }),
      1,
    );
    const packageTask = await db.downloadPreparation.findUniqueOrThrow({
      where: { id: queued.data.id },
    });
    const zip = unzipSync((await files.read(packageTask.fileObjectId!)).body);
    assert.deepEqual(Buffer.from(zip[`${work.workNumber}-001.png`]), png);
    assert.ok(zip[`${work.workNumber}_翻译.txt`]);
    const rendered = await prepareUpload(
      "typeset_single",
      work.id,
      handed.revision,
      typesetter,
    );
    await run(rendered.id, "direct_typeset_single");
    assert.equal(
      (await app.get(DirectUploadsService).get(typesetter.id, rendered.id))
        .status,
      "completed",
    );
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: work.id } }),
      1,
    );
    const renderedWork = await db.work.findUniqueOrThrow({
      where: { id: work.id },
    });
    assert.equal(renderedWork.workflowStatus, "typesetting"); // Detail upload saves only.
    assert.equal(
      await db.workEvent.count({
        where: { workId: work.id, action: "stage_submitted" },
      }),
      0,
    );
    await app.get(DirectUploadsService).finalize(typesetter.id, rendered.id);
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: work.id } }),
      1,
    );
    const changed = await makeWork();
    const changedTask = await app.get(DownloadsService).prepare(typesetter.id, {
      ...input,
      workId: changed.id,
      expectedRevision: changed.revision,
      expectedEditorEpoch: changed.editorEpoch,
      idempotencyKey: randomUUID(),
      purpose: "handoff",
    });
    await run(changedTask.id, "download_handoff");
    await db.work.update({
      where: { id: changed.id },
      data: { reviewStatus: "needs_review", revision: { increment: 1 } },
    });
    await assert.rejects(
      app.get(DownloadsService).deliver(typesetter.id, changedTask.id),
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: changed.id } }))
        .typesetHandoffStartedAt,
      null,
    );
    const management = await makeWork();
    const managementTask = await app.get(DownloadsService).prepare(admin.id, {
      ...input,
      purpose: "handoff",
      workId: management.id,
      expectedRevision: management.revision,
      expectedEditorEpoch: management.editorEpoch,
      idempotencyKey: randomUUID(),
      requireCurrentParticipation: false,
    });
    await run(managementTask.id, "download_handoff");
    await app.get(DownloadsService).deliver(admin.id, managementTask.id);
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: management.id } }))
        .typesetHandoffStartedAt,
      null,
    );
    // Publication fixture represents completed submissions, preserving the real credit contract.
    await db.work.update({
      where: { id: work.id },
      data: { workflowStatus: "pending_publish" },
    });
    for (const stage of ["translate", "proofread", "typeset"])
      await db.workEvent.create({
        data: {
          workId: work.id,
          actorId: typesetter.id,
          action: "stage_submitted",
          detail: {
            stage,
            credits: [{ userId: typesetter.id, creditName: "Fixture" }],
          } as Prisma.InputJsonObject,
        },
      });
    const publicationWork = await db.work.findUniqueOrThrow({
      where: { id: work.id },
    });
    const publicationTask = await app.get(DownloadsService).prepare(admin.id, {
      purpose: "publication",
      workId: work.id,
      expectedRevision: publicationWork.revision,
      expectedEditorEpoch: publicationWork.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    await run(publicationTask.id, "download_publication");
    const publishedFile = await db.downloadPreparation.findUniqueOrThrow({
      where: { id: publicationTask.id },
    });
    assert.equal(publishedFile.status, "succeeded", publishedFile.error!);
    const publishedZip = unzipSync(
      (await files.read(publishedFile.fileObjectId!)).body,
    );
    assert.deepEqual(Object.keys(publishedZip), [
      `${work.workNumber}-001成图.png`,
    ]);
    assert.deepEqual(
      Buffer.from(publishedZip[`${work.workNumber}-001成图.png`]),
      png,
    );
    const repeatTask = await app.get(DownloadsService).prepare(admin.id, {
      purpose: "publication",
      workId: work.id,
      expectedRevision: publicationWork.revision,
      expectedEditorEpoch: publicationWork.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    await run(repeatTask.id, "download_publication");
    assert.equal(
      (
        await db.downloadPreparation.findUniqueOrThrow({
          where: { id: repeatTask.id },
        })
      ).fileObjectId,
      publishedFile.fileObjectId,
    );
    await app.get(DownloadsService).deliver(admin.id, repeatTask.id);
    // Expiry clears staging/cache sessions without removing adopted images or durable handoff history.
    const expiredManifest = (
      await db.directUploadSession.findUniqueOrThrow({
        where: { id: expired.id },
      })
    ).manifest as { key: string }[];
    const deleted = mock.method(storage, "delete", async () => {
      throw new Error("Synthetic cleanup failure");
    });
    await assert.rejects(app.get(DirectUploadsService).cleanupExpired());
    assert.equal(
      await db.directUploadSession.count({ where: { id: expired.id } }),
      1,
    );
    deleted.mock.restore();
    await app.get(DirectUploadsService).cleanupExpired();
    assert.equal(await storage.head(expiredManifest[0].key), null);
    assert.equal(
      await db.directUploadSession.count({ where: { id: expired.id } }),
      0,
    );
    await db.downloadPreparation.updateMany({
      where: { actorId: { in: users } },
      data: { expiresAt: new Date(0) },
    });
    await db.fileObject.update({
      where: { id: publishedFile.fileObjectId! },
      data: { createdAt: new Date(0) },
    });
    await db.workerSchedule.updateMany({
      where: { name: "transfer-cleanup" },
      data: { dueAt: new Date(0) },
    });
    await app.get(DownloadsService).scheduleCleanup();
    await run("00000000-0000-0000-0000-000000000004", "transfer_cleanup");
    assert.equal(
      await db.fileObject.count({ where: { id: publishedFile.fileObjectId! } }),
      0,
    );
    assert.equal(
      await db.typesetHandoffPackage.count({ where: { workId: work.id } }),
      1,
    );
    assert.ok(
      await storage.head(
        (await db.fileObject.findUniqueOrThrow({ where: { id: original.id } }))
          .objectKey,
      ),
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    try {
      mock.restoreAll();
      await db.backgroundJob.deleteMany({
        where: {
          OR: [{ actorId: { in: users } }, { kind: "transfer_cleanup" }],
        },
      });
      await db.downloadPreparation.deleteMany({
        where: { actorId: { in: users } },
      });
      await db.directUploadSession.deleteMany({
        where: { actorId: { in: users } },
      });
      await db.work.updateMany({
        where: { id: { in: workIds } },
        data: {
          currentTypesetVersionId: null,
          requiredHandoffVersionId: null,
          proofreadSkippedVersionId: null,
        },
      });
      await db.typesetHandoffPackage.deleteMany({
        where: { workId: { in: workIds } },
      });
      await db.publishRecord.deleteMany({ where: { workId: { in: workIds } } });
      await db.workReviewCase.deleteMany({
        where: { workId: { in: workIds } },
      });
      await db.typesetImageVersion.deleteMany({
        where: { workId: { in: workIds } },
      });
      await db.labelPlusFile.deleteMany({ where: { workId: { in: workIds } } });
      await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
      await db.workStageParticipant.deleteMany({
        where: { workId: { in: workIds } },
      });
      await db.translationVersion.deleteMany({
        where: { workId: { in: workIds } },
      });
      await db.workImage.deleteMany({ where: { workId: { in: workIds } } });
      await db.work.deleteMany({ where: { id: { in: workIds } } });
      await db.candidatePost.deleteMany({ where: { authorId } });
      if (authorId) {
        await db.authorAuthorizationEvidence.deleteMany({
          where: { authorId },
        });
        await db.author.delete({ where: { id: authorId } });
      }
      const ownedFiles = await db.fileObject.findMany({
        where: { createdById: { in: users } },
      });
      for (const file of ownedFiles) await files.purgeUnreferenced(file.id);
      await db.authSession.deleteMany({ where: { userId: { in: users } } });
      await db.userRole.deleteMany({ where: { userId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
