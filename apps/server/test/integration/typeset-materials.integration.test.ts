import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { tokenHash } from "../../src/users/password.js";
import { parseLabelPlus } from "../../src/labelplus/labelplus-codec.js";
import type { TypesetMaterialDto } from "../../src/typesetting/typeset-materials.dto.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable _test database required");

test("HTTP material inspection and formal receipts preserve bytes, renew exactly and reject replaced originals", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "comiku-material-http-"));
  const app = await createApplication(
    parseEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: testUrl,
      OBJECT_STORAGE_DRIVER: "local",
      LOCAL_STORAGE_PATH: storagePath,
    }),
  );
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl(),
    db = app.get(PrismaService),
    files = app.get(FileObjectsService);
  let userId = "",
    workId = "",
    authorId = "";
  const fileIds: string[] = [];
  try {
    const user = await db.user.create({
      data: {
        username: `materials_${randomUUID()}`,
        displayName: "Synthetic materials",
        passwordHash: "non-login",
        mustChangePassword: false,
        roles: { create: { role: "typesetter" } },
      },
    });
    userId = user.id;
    const token = randomBytes(32).toString("base64url");
    await db.authSession.create({
      data: {
        userId,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const body = new Uint8Array([1, 2, 3]);
    const original = await files.store({
      body,
      contentType: "image/png",
      bucketScope: "works",
      kind: "synthetic-material",
      createdById: userId,
    });
    fileIds.push(original.id);
    const author = await db.author.create({
      data: { displayName: "Synthetic material author" },
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
        importedById: userId,
        sourceCandidatePostId: candidate.id,
        sourceLanguage: "ja",
        workflowStatus: "pending_typeset",
        editorEpoch: 1,
        images: {
          create: {
            orderIndex: 0,
            originalFileObjectId: original.id,
            translationEntries: {
              create: {
                orderIndex: 0,
                markerX: 0.5,
                markerY: 0.5,
                markerPositionType: "inside",
                translatedText: "可变草稿",
                creationIdempotencyKey: randomUUID(),
                createdById: userId,
                updatedById: userId,
              },
            },
          },
        },
        stageParticipants: {
          create: { userId, stage: "typeset", participationMode: "owner" },
        },
      },
      include: { images: true },
    });
    workId = work.id;
    const version = await db.translationVersion.create({
      data: {
        workId,
        versionNumber: 1,
        kind: "proofread_submission",
        stage: "proofread",
        createdById: userId,
        editorEpoch: 1,
        workRevision: work.revision,
        entries: {
          create: {
            workImageId: work.images[0].id,
            orderIndex: 0,
            markerX: 0.5,
            markerY: 0.5,
            markerPositionType: "inside",
            translatedText: "正式译文",
          },
        },
      },
    });
    async function post(path: string, input: object = {}) {
      return fetch(`${base}/api/works/${workId}/typeset/materials${path}`, {
        method: "POST",
        headers: {
          Cookie: `comiku_session=${token}`,
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
          "X-Comiku-Request": "1",
        },
        body: JSON.stringify(input),
      });
    }
    const createInput = {
      expectedRevision: work.revision,
      expectedEditorEpoch: 1,
      idempotencyKey: randomUUID(),
      requireCurrentParticipation: false,
    };
    const prepared = await post("", createInput);
    assert.equal(prepared.status, 200);
    const inspection = (await prepared.json()) as TypesetMaterialDto;
    assert.equal(inspection.translationVersionId, version.id);
    assert.equal(
      parseLabelPlus(Buffer.from(inspection.translationBase64, "base64"))
        .document.images[0].markers[0].translation,
      "正式译文",
    );
    assert.equal((await post(`/${inspection.id}/deliver`)).status, 200);
    const afterInspection = await db.work.findUniqueOrThrow({
      where: { id: workId },
    });
    assert.equal(afterInspection.typesetHandoffStartedAt, null);
    assert.equal(afterInspection.revision, work.revision);
    assert.equal(
      await db.typesetHandoffPackage.count({ where: { workId } }),
      0,
    );
    assert.equal(
      await db.fileObject.count({ where: { createdById: userId } }),
      1,
    );

    const formalResponse = await post("", {
      ...createInput,
      idempotencyKey: randomUUID(),
      requireCurrentParticipation: true,
    });
    assert.equal(formalResponse.status, 200);
    const formal = (await formalResponse.json()) as TypesetMaterialDto;
    const deliveredResponse = await post(`/${formal.id}/deliver`);
    assert.equal(deliveredResponse.status, 200);
    const delivered = (await deliveredResponse.json()) as TypesetMaterialDto;
    assert.equal(
      delivered.images[0].checksum,
      createHash("sha256").update(body).digest("hex"),
    );
    const imageResponse = await fetch(
      delivered.images[0].url!.startsWith("/")
        ? `${base}${delivered.images[0].url}`
        : delivered.images[0].url!,
      { headers: { Cookie: `comiku_session=${token}` } },
    );
    assert.equal(imageResponse.status, 200);
    assert.deepEqual(new Uint8Array(await imageResponse.arrayBuffer()), body);
    const after = await db.work.findUniqueOrThrow({ where: { id: workId } });
    assert.equal(after.workflowStatus, "typesetting");
    assert.equal(after.revision, work.revision + 1);
    assert.ok(
      (await db.typesetMaterial.findUniqueOrThrow({ where: { id: formal.id } }))
        .deliveredAt,
    );
    assert.ok(
      (
        await db.translationVersion.findUniqueOrThrow({
          where: { id: version.id },
        })
      ).handoffStartedAt,
    );
    assert.equal((await post(`/${formal.id}/deliver`)).status, 200);
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: workId } })).revision,
      after.revision,
    );
    assert.equal(
      await db.workEvent.count({
        where: { workId, action: "typeset_handoff_started" },
      }),
      1,
    );

    const replacement = await files.store({
      body: new Uint8Array([4, 5, 6]),
      contentType: "image/png",
      bucketScope: "works",
      kind: "synthetic-material",
      createdById: userId,
    });
    fileIds.push(replacement.id);
    await db.workImage.update({
      where: { id: work.images[0].id },
      data: { originalFileObjectId: replacement.id },
    });
    await db.work.update({
      where: { id: workId },
      data: {
        sourceAssetRevision: { increment: 1 },
        revision: { increment: 1 },
      },
    });
    assert.equal((await post(`/${formal.id}/deliver`)).status, 409);
    await files.purgeUnreferenced(original.id);
    assert.ok(
      await db.fileObject.findUnique({ where: { id: original.id } }),
      "material's original reference must block purge",
    );
  } finally {
    if (workId) {
      await db.typesetMaterial.deleteMany({ where: { workId } });
      await db.translationVersion.deleteMany({ where: { workId } });
      await db.workEvent.deleteMany({ where: { workId } });
      await db.workStageParticipant.deleteMany({ where: { workId } });
      await db.translationEntry.deleteMany({
        where: { workImage: { workId } },
      });
      await db.workImage.deleteMany({ where: { workId } });
      await db.work.delete({ where: { id: workId } });
    }
    if (authorId) {
      await db.candidatePost.deleteMany({ where: { authorId } });
      await db.author.delete({ where: { id: authorId } });
    }
    for (const id of fileIds) await files.purgeUnreferenced(id);
    if (userId) {
      await db.authSession.deleteMany({ where: { userId } });
      await db.userRole.deleteMany({ where: { userId } });
      await db.user.delete({ where: { id: userId } });
    }
    await app.close();
    assert.ok(
      resolve(storagePath).startsWith(
        resolve(tmpdir()) + sep + "comiku-material-http-",
      ),
    );
    await rm(storagePath, { recursive: true, force: true });
  }
});
