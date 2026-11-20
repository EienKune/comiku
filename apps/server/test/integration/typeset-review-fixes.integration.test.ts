import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { configureApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { TypesettingService } from "../../src/typesetting/typesetting.service.js";
import { SingleTypesetSupplementsService } from "../../src/typesetting/single-typeset-supplements.service.js";
import { TranslationsService } from "../../src/translations/translations.service.js";
import { WorksService } from "../../src/works/works.service.js";
import { tokenHash } from "../../src/users/password.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable _test database required");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const upload = (originalname: string) => ({
  originalname,
  mimetype: "image/png",
  size: png.length,
  buffer: png,
});
test("current material identity rejects superseded downloads and the handoff transaction; single supplements preserve complete snapshots", async () => {
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
  const base = await app.getUrl();
  const db = app.get(PrismaService),
    files = app.get(FileObjectsService),
    typeset = app.get(TypesettingService),
    translations = app.get(TranslationsService),
    works = app.get(WorksService),
    supplements = app.get(SingleTypesetSupplementsService);
  const users: string[] = [],
    workIds: string[] = [];
  let authorId = "";
  try {
    const actor = await db.user.create({
      data: {
        username: `material_${randomUUID()}`,
        displayName: "Material owner",
        passwordHash: "fixture",
        mustChangePassword: false,
        roles: { create: [{ role: "proofreader" }, { role: "typesetter" }] },
        languageCapabilities: { create: { language: "ja" } },
      },
    });
    users.push(actor.id);
    const admin = await db.user.create({
      data: {
        username: `admin_${randomUUID()}`,
        displayName: "Reader",
        passwordHash: "fixture",
        roles: { create: { role: "admin" } },
      },
    });
    users.push(admin.id);
    const token = randomBytes(32).toString("base64url");
    const authenticatedSession = await db.authSession.create({
      data: {
        userId: actor.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const author = await db.author.create({
      data: { displayName: "Synthetic material author" },
    });
    authorId = author.id;
    const original = await files.store({
      body: png,
      contentType: "image/png",
      bucketScope: "works",
      kind: "fixture",
      createdById: actor.id,
    });
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
        importedById: actor.id,
        workflowStatus: "proofreading",
        images: {
          create: {
            orderIndex: 0,
            originalFileObjectId: original.id,
            translationEntries: {
              create: {
                orderIndex: 0,
                creationIdempotencyKey: randomUUID(),
                createdById: actor.id,
                updatedById: actor.id,
                markerX: 0.5,
                markerY: 0.5,
                markerPositionType: "inside",
                translatedText: "first",
              },
            },
          },
        },
        stageParticipants: {
          create: [
            {
              stage: "proofread",
              userId: actor.id,
              participationMode: "owner",
            },
            { stage: "typeset", userId: actor.id, participationMode: "owner" },
          ],
        },
      },
      include: { images: { include: { translationEntries: true } } },
    });
    workIds.push(work.id);
    const current = () => db.work.findUniqueOrThrow({ where: { id: work.id } });
    let state = await current();
    await works.submitStage(actor.id, work.id, {
      stage: "proofread",
      expectedRevision: state.revision,
      expectedEditorEpoch: state.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    state = await current();
    const old = await typeset.createHandoffPackage(actor.id, work.id, {
      expectedRevision: state.revision,
      expectedEditorEpoch: state.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    await works.cancelStageSubmission(actor.id, work.id, {
      stage: "proofread",
      expectedRevision: state.revision,
      expectedEditorEpoch: state.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    state = await current();
    const entry = work.images[0].translationEntries[0];
    const editorInstanceId = randomUUID();
    const lease = await translations.leasePage(
      actor.id,
      authenticatedSession.id,
      work.id,
      work.images[0].id,
      { editorInstanceId, expectedEditorEpoch: state.editorEpoch },
    );
    await translations.updateEntry(
      actor.id,
      entry.id,
      {
        expectedRevision: entry.revision,
        expectedEditorEpoch: lease.editorEpoch,
        translatedText: "second",
        editorInstanceId,
        leaseToken: lease.leaseToken,
      },
      authenticatedSession.id,
    );
    await translations.releaseLease(
      actor.id,
      authenticatedSession.id,
      work.id,
      work.images[0].id,
      { editorInstanceId, leaseToken: lease.leaseToken },
    );
    state = await current();
    await works.submitStage(actor.id, work.id, {
      stage: "proofread",
      expectedRevision: state.revision,
      expectedEditorEpoch: state.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    state = await current();
    const versionsBefore = await db.translationVersion.count({
      where: { workId: work.id },
    });
    const staleHttp = await fetch(
      `${base}/api/works/${work.id}/typeset/handoff-packages/${old.packageId}`,
      { headers: { Cookie: `comiku_session=${token}` } },
    );
    assert.equal(staleHttp.status, 409);
    await assert.rejects(
      translations.beginTypesetHandoff(actor.id, work.id, {
        material: "unified_handoff",
        fileId: old.packageId,
        expectedRevision: state.revision,
        expectedEditorEpoch: state.editorEpoch,
      }),
      /正式文本已更新/,
    );
    assert.equal((await current()).typesetHandoffStartedAt, null);
    assert.equal(
      await db.translationVersion.count({ where: { workId: work.id } }),
      versionsBefore,
    );
    const fresh = await typeset.createHandoffPackage(actor.id, work.id, {
      expectedRevision: state.revision,
      expectedEditorEpoch: state.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    assert.notEqual(fresh.packageId, old.packageId);
    await typeset.readHandoffPackage(admin.id, work.id, fresh.packageId);
    assert.equal((await current()).typesetHandoffStartedAt, null);
    await db.work.update({
      where: { id: work.id },
      data: { title: "Harmless title", revision: { increment: 1 } },
    });
    state = await current();
    const reused = await typeset.createHandoffPackage(actor.id, work.id, {
      expectedRevision: state.revision,
      expectedEditorEpoch: state.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    assert.equal(reused.packageId, fresh.packageId);
    await typeset.readHandoffPackage(actor.id, work.id, reused.packageId);
    state = await current();
    assert.ok(state.typesetHandoffStartedAt);
    const ordinary = await db.typesetImageVersion.create({
      data: {
        workId: work.id,
        versionNumber: 1,
        uploadedById: actor.id,
        idempotencyKey: randomUUID(),
        images: {
          create: [0, 1].map((orderIndex) => ({
            fileObjectId: original.id,
            workImageId: orderIndex === 0 ? work.images[0].id : null,
            orderIndex,
            sourceName: `ordinary-${orderIndex}.png`,
            width: 1,
            height: 1,
          })),
        },
      },
      include: { images: { orderBy: { orderIndex: "asc" } } },
    });
    await db.work.update({
      where: { id: work.id },
      data: {
        workflowStatus: "pending_publish",
        currentTypesetVersionId: ordinary.id,
      },
    });
    const change = async () => ({
      expectedRevision: (await current()).revision,
      idempotencyKey: randomUUID(),
    });
    // A retained sole member may still carry their historical collaborator flag.
    await db.workStageParticipant.updateMany({
      where: { workId: work.id, stage: "typeset", leftAt: null },
      data: { participationMode: "collaborator" },
    });
    let output = await supplements.add(
      actor.id,
      work.id,
      ordinary.id,
      upload("cover1.png"),
      { ...(await change()), position: "start" },
    );
    let active = output.items.find((v) => v.id === output.currentVersionId)!;
    const firstCover = active.images.find((i) => i.supplementId)!;
    assert.equal(active.images.length, 3);
    assert.equal(active.images[0].sourceName, "cover1.png");
    assert.equal(active.images[1].workImageId, work.images[0].id);
    await assert.rejects(
      supplements.add(
        admin.id,
        work.id,
        active.id,
        upload("unauthorized.png"),
        { ...(await change()), position: "end" },
      ),
      /嵌字职务/,
    );
    output = await supplements.add(
      actor.id,
      work.id,
      active.id,
      upload("cover2.png"),
      { ...(await change()), position: "start" },
    );
    active = output.items.find((v) => v.id === output.currentVersionId)!;
    assert.deepEqual(
      active.images.map((i) => i.sourceName),
      ["cover1.png", "cover2.png", "ordinary-0.png", "ordinary-1.png"],
    );
    const beforeReplace = active;
    const cover = active.images[0];
    output = await typeset.replaceCurrentImage(
      actor.id,
      work.id,
      active.id,
      cover.id,
      upload("cover-corrected.png"),
      await change(),
    );
    active = output.items.find((v) => v.id === output.currentVersionId)!;
    assert.equal(active.images[0].supplementId, firstCover.supplementId);
    assert.equal(active.images[0].supplementPosition, "start");
    await assert.rejects(
      supplements.remove(
        actor.id,
        work.id,
        active.id,
        active.images[3].id,
        await change(),
      ),
      /不是明确添加/,
    );
    output = await supplements.remove(
      actor.id,
      work.id,
      active.id,
      active.images[0].id,
      await change(),
    );
    active = output.items.find((v) => v.id === output.currentVersionId)!;
    assert.deepEqual(
      active.images.map((i) => i.sourceName),
      ["cover2.png", "ordinary-0.png", "ordinary-1.png"],
    );
    assert.equal((await current()).workflowStatus, "pending_publish");
    assert.equal(
      await db.typesetImageVersionImage.count({
        where: { versionId: beforeReplace.id },
      }),
      4,
    );
    const latestEvent = await db.workEvent.findFirstOrThrow({
      where: { workId: work.id, action: "typeset_version_uploaded" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(
      (latestEvent.detail as { isRevision: boolean }).isRevision,
      true,
    );
    assert.equal(
      (latestEvent.detail as { affectsSupplement: boolean }).affectsSupplement,
      true,
    );
    const only = await db.typesetImageVersion.create({
      data: {
        workId: work.id,
        versionNumber: 100,
        uploadedById: actor.id,
        idempotencyKey: randomUUID(),
        images: {
          create: {
            fileObjectId: original.id,
            orderIndex: 0,
            sourceName: "sole-cover.png",
            width: 1,
            height: 1,
            supplementId: randomUUID(),
            supplementPosition: "end",
          },
        },
      },
      include: { images: true },
    });
    await db.work.update({
      where: { id: work.id },
      data: { currentTypesetVersionId: only.id },
    });
    await assert.rejects(
      supplements.remove(
        actor.id,
        work.id,
        only.id,
        only.images[0].id,
        await change(),
      ),
      /零张/,
    );
    assert.equal((await current()).currentTypesetVersionId, only.id);
  } finally {
    await db.work.updateMany({
      where: { id: { in: workIds } },
      data: { currentTypesetVersionId: null, requiredHandoffVersionId: null },
    });
    await db.typesetImageVersionImage.deleteMany({
      where: { version: { workId: { in: workIds } } },
    });
    await db.typesetImageVersion.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.typesetHandoffPackage.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.translationVersionEntry.deleteMany({
      where: { version: { workId: { in: workIds } } },
    });
    await db.translationVersion.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
    await db.workPageAssignment.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workStageParticipant.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workCreditAlias.deleteMany({ where: { workId: { in: workIds } } });
    await db.translationEntry.deleteMany({
      where: { workImage: { workId: { in: workIds } } },
    });
    await db.workImage.deleteMany({ where: { workId: { in: workIds } } });
    await db.work.deleteMany({ where: { id: { in: workIds } } });
    if (authorId) {
      await db.candidatePost.deleteMany({ where: { authorId } });
      await db.author.delete({ where: { id: authorId } });
    }
    for (const file of await db.fileObject.findMany({
      where: { createdById: { in: users } },
    }))
      await files.purgeUnreferenced(file.id);
    await db.authSession.deleteMany({ where: { userId: { in: users } } });
    await db.userLanguageCapability.deleteMany({
      where: { userId: { in: users } },
    });
    await db.userRole.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  }
});
