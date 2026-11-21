import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { zipSync } from "fflate";
import { AppModule } from "../../src/app.module.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { TypesetCollaborationService } from "../../src/typesetting/typeset-collaboration.service.js";
import { SourceHdService } from "../../src/typesetting/source-hd.service.js";
import { TypesettingService } from "../../src/typesetting/typesetting.service.js";
import {
  submitTypesetPagesTx,
  cancelTypesetPagesTx,
} from "../../src/typesetting/typeset-page-workflow.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable _test database required");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);
const upload = (name: string) => ({
  originalname: name,
  mimetype: "image/png",
  size: png.length,
  buffer: png,
});

test("typeset page drafts accumulate, isolate owners, aggregate once, revise complete versions and retain asset history", async () => {
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
    files = app.get(FileObjectsService),
    collaboration = app.get(TypesetCollaborationService),
    hd = app.get(SourceHdService),
    typesetting = app.get(TypesettingService);
  const userIds: string[] = [],
    workIds: string[] = [];
  let authorId = "";
  try {
    const a = await db.user.create({
      data: {
        username: `typeset_a_${randomUUID()}`,
        displayName: "A",
        passwordHash: "fixture",
        roles: { create: [{ role: "typesetter" }, { role: "source" }] },
      },
    });
    userIds.push(a.id);
    const b = await db.user.create({
      data: {
        username: `typeset_b_${randomUUID()}`,
        displayName: "B",
        passwordHash: "fixture",
        roles: { create: { role: "typesetter" } },
      },
    });
    userIds.push(b.id);
    const author = await db.author.create({
      data: { displayName: "typeset synthetic" },
    });
    authorId = author.id;
    const original = await files.store({
      body: png,
      contentType: "image/png",
      bucketScope: "works",
      kind: "fixture",
      createdById: a.id,
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
        importedById: a.id,
        collaborationMode: "multi",
        workflowStatus: "typesetting",
        typesetHandoffStartedAt: new Date(),
        images: {
          create: [0, 1, 2].map((orderIndex) => ({
            originalFileObjectId: original.id,
            orderIndex,
          })),
        },
        stageParticipants: {
          create: [
            { stage: "typeset", userId: a.id, participationMode: "owner" },
            {
              stage: "typeset",
              userId: b.id,
              participationMode: "collaborator",
            },
          ],
        },
      },
      include: {
        images: { orderBy: { orderIndex: "asc" } },
        stageParticipants: true,
      },
    });
    workIds.push(work.id);
    const pa = work.stageParticipants.find((p) => p.userId === a.id)!,
      pb = work.stageParticipants.find((p) => p.userId === b.id)!;
    await db.workPageAssignment.createMany({
      data: work.images.map((p, i) => ({
        workId: work.id,
        workImageId: p.id,
        stage: "typeset",
        participantId: i < 2 ? pa.id : pb.id,
      })),
    });
    const revision = async () =>
      (await db.work.findUniqueOrThrow({ where: { id: work.id } })).revision;
    async function save(
      actorId: string,
      pages: number[],
      opts: { supplement?: boolean; zip?: boolean; staged?: boolean } = {},
    ) {
      const inputs = opts.zip
        ? [
            {
              originalname: `${work.workNumber}_成图.zip`,
              mimetype: "application/zip",
              buffer: Buffer.from(
                zipSync(
                  Object.fromEntries(
                    pages.map((p) => [
                      `${work.workNumber}-${String(p + 1).padStart(3, "0")}.png`,
                      png,
                    ]),
                  ),
                ),
              ),
              size: 0,
            },
          ]
        : pages.map((p) =>
            upload(`${work.workNumber}-${String(p + 1).padStart(3, "0")}.png`),
          );
      if (opts.zip) inputs[0].size = inputs[0].buffer.length;
      const expectedRevision = await revision();
      // Simulate the worker's durable extracted metadata; the detail bind must reuse it.
      const staged = opts.staged
        ? await db.typesetUploadSession.create({
            data: {
              actorId,
              status: "previewed",
              expiresAt: new Date(Date.now() + 3600000),
              files: {
                create: {
                  sourceName: "detail-fixture.zip",
                  contentType: "application/zip",
                  status: "processed",
                  objectKey: `fixture/${randomUUID()}`,
                  size: 0,
                  checksum: "0".repeat(64),
                  orderIndex: 0,
                  images: {
                    create: inputs.map((file, orderIndex) => ({
                      sourceName: file.originalname,
                      fileObjectId: original.id,
                      width: 1,
                      height: 1,
                      orderIndex,
                    })),
                  },
                },
              },
            },
          })
        : null;
      const preview = staged
        ? await collaboration.previewSession(actorId, work.id, {
            sessionId: staged.id,
            expectedRevision,
            idempotencyKey: randomUUID(),
          })
        : await collaboration.preview(actorId, work.id, inputs, {
            expectedRevision,
            idempotencyKey: randomUUID(),
          });
      if (staged) {
        assert.deepEqual(
          await collaboration.previewSession(actorId, work.id, {
            sessionId: staged.id,
            expectedRevision,
            idempotencyKey: randomUUID(),
          }),
          preview,
        );
        assert.equal(
          await db.typesetUploadPreview.count({
            where: { sessionId: staged.id, workId: work.id },
          }),
          1,
        );
        await assert.rejects(
          collaboration.previewSession(b.id, work.id, {
            sessionId: staged.id,
            expectedRevision,
            idempotencyKey: randomUUID(),
          }),
        );
      }
      return collaboration.apply(actorId, work.id, {
        sessionId: preview.sessionId,
        expectedRevision: preview.expectedRevision,
        idempotencyKey: randomUUID(),
        mappings: preview.images.map((i) => ({
          imageId: i.id,
          workImageId: opts.supplement ? null : i.suggestedWorkImageId,
          position: opts.supplement ? "end" : "page",
        })),
      });
    }
    await save(a.id, [0], { staged: true });
    await assert.rejects(
      db.$transaction((tx) =>
        submitTypesetPagesTx(tx, a.id, work.id, {
          expectedRevision: work.revision + 1,
          idempotencyKey: randomUUID(),
        }),
      ),
      /缺图/,
    );
    await save(a.id, [1]);
    await assert.rejects(save(a.id, [2]), /本人/);
    assert.equal(
      await db.workTypesetDraft.count({ where: { workId: work.id } }),
      2,
    );
    await save(b.id, [2], { zip: true });
    await save(a.id, [0], { supplement: true });
    await db.$transaction((tx) =>
      submitTypesetPagesTx(tx, b.id, work.id, {
        expectedRevision: 4,
        idempotencyKey: randomUUID(),
      }),
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: work.id } }))
        .workflowStatus,
      "typesetting",
    );
    const key = randomUUID();
    const rev = await revision();
    await Promise.all(
      [0, 1].map(() =>
        db.$transaction((tx) =>
          submitTypesetPagesTx(tx, a.id, work.id, {
            expectedRevision: rev,
            idempotencyKey: key,
          }),
        ),
      ),
    );
    let current = await db.work.findUniqueOrThrow({
      where: { id: work.id },
      include: { currentTypesetVersion: { include: { images: true } } },
    });
    assert.equal(current.workflowStatus, "pending_publish");
    assert.equal(current.currentTypesetVersion!.images.length, 4);
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: work.id } }),
      1,
    );
    const oldFileIds = current.currentTypesetVersion!.images.map(
      (i) => i.fileObjectId,
    );
    await save(a.id, [0]);
    current = await db.work.findUniqueOrThrow({
      where: { id: work.id },
      include: { currentTypesetVersion: { include: { images: true } } },
    });
    assert.equal(current.workflowStatus, "pending_publish");
    assert.equal(current.currentTypesetVersion!.images.length, 4);
    assert.equal(
      current.currentTypesetVersion!.images.filter((i) =>
        oldFileIds.includes(i.fileObjectId),
      ).length,
      3,
    );
    await db.$transaction((tx) =>
      cancelTypesetPagesTx(tx, a.id, work.id, {
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
      }),
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: work.id } }))
        .workflowStatus,
      "typesetting",
    );
    assert.equal(
      (
        await db.workTypesetDraft.findFirstOrThrow({
          where: { workId: work.id, participantId: pb.id },
        })
      ).submittedRevision,
      1,
    );
    const oldSupplement = await db.workTypesetDraft.findFirstOrThrow({
      where: { workId: work.id, workImageId: null },
    });
    await collaboration.remove(a.id, work.id, oldSupplement.id, {
      expectedRevision: await revision(),
      idempotencyKey: randomUUID(),
    });
    await db.$transaction((tx) =>
      submitTypesetPagesTx(tx, a.id, work.id, {
        expectedRevision: current.revision + 2,
        idempotencyKey: randomUUID(),
      }),
    );
    await db.$transaction(async (tx) =>
      cancelTypesetPagesTx(tx, b.id, work.id, {
        expectedRevision: await revision(),
        idempotencyKey: randomUUID(),
      }),
    );
    await save(a.id, [0], { supplement: true });
    await db.$transaction(async (tx) =>
      submitTypesetPagesTx(tx, b.id, work.id, {
        expectedRevision: await revision(),
        idempotencyKey: randomUUID(),
      }),
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: work.id } }))
        .workflowStatus,
      "typesetting",
    );
    const lastSupplement = await db.workTypesetDraft.findFirstOrThrow({
      where: { workId: work.id, workImageId: null },
    });
    const deleteKey = randomUUID();
    await collaboration.remove(a.id, work.id, lastSupplement.id, {
      expectedRevision: await revision(),
      idempotencyKey: deleteKey,
    });
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: work.id } }))
        .workflowStatus,
      "pending_publish",
    );
    const readyEvent = await db.workEvent.findUniqueOrThrow({
      where: {
        workId_idempotencyKey: { workId: work.id, idempotencyKey: deleteKey },
      },
    });
    assert.equal(readyEvent.action, "stage_submitted");
    assert.deepEqual(
      (readyEvent.detail as { credits: { userId: string }[] }).credits.map(
        (c) => c.userId,
      ),
      [a.id, b.id],
    );
    await assert.rejects(
      hd.replace(a.id, work.id, work.images[0].id, upload("hd.png"), {
        expectedRevision: await revision(),
        idempotencyKey: randomUUID(),
        sameContentConfirmed: true,
      }),
      /承接/,
    );
    await db.work.update({
      where: { id: work.id },
      data: {
        typesetHandoffStartedAt: null,
        workflowStatus: "pending_typeset",
      },
    });
    const before = await db.workImage.findUniqueOrThrow({
      where: { id: work.images[0].id },
    });
    await hd.replace(a.id, work.id, before.id, upload("hd.png"), {
      expectedRevision: await revision(),
      idempotencyKey: randomUUID(),
      sameContentConfirmed: true,
    });
    const after = await db.workImage.findUniqueOrThrow({
      where: { id: before.id },
    });
    assert.equal(after.id, before.id);
    assert.equal(after.translationRevision, before.translationRevision);
    assert.notEqual(after.originalFileObjectId, before.originalFileObjectId);
    await files.purgeUnreferenced(before.originalFileObjectId);
    assert.ok(
      await db.fileObject.findUnique({
        where: { id: before.originalFileObjectId },
      }),
    );
    assert.equal(
      await db.workSourceAssetReplacement.count({ where: { workId: work.id } }),
      1,
    );
    const importCandidate = await db.candidatePost.create({
      data: {
        authorId,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    const importWork = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: importCandidate.id,
        importedById: a.id,
        workflowStatus: "typesetting",
        typesetHandoffStartedAt: new Date(),
        images: {
          create: [0, 1, 2].map((orderIndex) => ({
            originalFileObjectId: original.id,
            orderIndex,
          })),
        },
        stageParticipants: {
          create: {
            stage: "typeset",
            userId: a.id,
            participationMode: "owner",
          },
        },
      },
    });
    workIds.push(importWork.id);
    const singleZip = Buffer.from(
      zipSync({ "free-one.png": png, "free-two.png": png }),
    );
    const zipPreview = await collaboration.preview(
      a.id,
      importWork.id,
      [
        {
          originalname: `${importWork.workNumber}_成图.zip`,
          mimetype: "application/zip",
          buffer: singleZip,
          size: singleZip.length,
        },
      ],
      { expectedRevision: importWork.revision, idempotencyKey: randomUUID() },
    );
    await collaboration.apply(a.id, importWork.id, {
      sessionId: zipPreview.sessionId,
      expectedRevision: zipPreview.expectedRevision,
      idempotencyKey: randomUUID(),
      mappings: zipPreview.images
        .slice()
        .reverse()
        .map((i) => ({ imageId: i.id, position: "free" })),
    });
    const importedSingle = await db.work.findUniqueOrThrow({
      where: { id: importWork.id },
      include: {
        currentTypesetVersion: {
          include: { images: { orderBy: { orderIndex: "asc" } } },
        },
        stageParticipants: true,
      },
    });
    assert.equal(importedSingle.workflowStatus, "typesetting");
    assert.equal(importedSingle.stageParticipants[0].submittedAt, null);
    assert.equal(importedSingle.currentTypesetVersion!.images.length, 2);
    assert.deepEqual(
      importedSingle.currentTypesetVersion!.images.map((i) => i.sourceName),
      zipPreview.images.map((i) => i.sourceName).reverse(),
    );
    assert.ok(
      importedSingle.currentTypesetVersion!.images.every(
        (i) => i.workImageId === null,
      ),
    );
    const singleCandidate = await db.candidatePost.create({
      data: {
        authorId,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    const single = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: singleCandidate.id,
        importedById: a.id,
        workflowStatus: "pending_publish",
        typesetHandoffStartedAt: new Date(),
        images: {
          create: { originalFileObjectId: original.id, orderIndex: 0 },
        },
        stageParticipants: {
          create: {
            stage: "typeset",
            userId: a.id,
            participationMode: "owner",
            submittedAt: new Date(),
          },
        },
      },
    });
    workIds.push(single.id);
    const initial = await db.typesetImageVersion.create({
      data: {
        workId: single.id,
        versionNumber: 1,
        uploadedById: a.id,
        idempotencyKey: randomUUID(),
        images: {
          create: [0, 1].map((orderIndex) => ({
            fileObjectId: original.id,
            sourceName: `extra-${orderIndex}.png`,
            width: 1,
            height: 1,
            orderIndex,
          })),
        },
      },
      include: { images: { orderBy: { orderIndex: "asc" } } },
    });
    await db.work.update({
      where: { id: single.id },
      data: { currentTypesetVersionId: initial.id },
    });
    const corrected = await typesetting.replaceCurrentImage(
      a.id,
      single.id,
      initial.id,
      initial.images[1].id,
      upload("replacement.png"),
      { expectedRevision: single.revision, idempotencyKey: randomUUID() },
    );
    const revised = corrected.items.find(
      (i) => i.id === corrected.currentVersionId,
    )!;
    assert.equal(revised.images.length, 2);
    assert.equal(revised.images[0].sourceName, initial.images[0].sourceName);
    assert.equal(revised.images[1].sourceName, "replacement.png");
    assert.ok(revised.images.every((i) => i.workImageId === null));
    const revisedRows = await db.typesetImageVersionImage.findMany({
      where: { versionId: revised.id },
      orderBy: { orderIndex: "asc" },
    });
    assert.equal(revisedRows[0].fileObjectId, original.id);
    assert.notEqual(revisedRows[1].fileObjectId, original.id);
    await db.work.update({
      where: { id: single.id },
      data: { workflowStatus: "published" },
    });
    await assert.rejects(
      typesetting.replaceCurrentImage(
        a.id,
        single.id,
        revised.id,
        revised.images[0].id,
        upload("late.png"),
        {
          expectedRevision: corrected.workRevision,
          idempotencyKey: randomUUID(),
        },
      ),
      /不能修改/,
    );
  } finally {
    await db.workSourceAssetReplacement.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workTypesetDraft.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.typesetUploadPreview.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.typesetUploadImage.deleteMany({
      where: { uploadFile: { session: { actorId: { in: userIds } } } },
    });
    await db.typesetUploadFile.deleteMany({
      where: { session: { actorId: { in: userIds } } },
    });
    await db.typesetUploadSession.deleteMany({
      where: { actorId: { in: userIds } },
    });
    await db.work.updateMany({
      where: { id: { in: workIds } },
      data: { currentTypesetVersionId: null },
    });
    await db.typesetImageVersionImage.deleteMany({
      where: { version: { workId: { in: workIds } } },
    });
    await db.typesetImageVersion.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.stageContributionPage.deleteMany({
      where: { submission: { participant: { workId: { in: workIds } } } },
    });
    await db.stageContributionSubmission.deleteMany({
      where: { participant: { workId: { in: workIds } } },
    });
    await db.workPageAssignment.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
    await db.workStageParticipant.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workImage.deleteMany({ where: { workId: { in: workIds } } });
    await db.work.deleteMany({ where: { id: { in: workIds } } });
    if (authorId) {
      await db.candidatePost.deleteMany({ where: { authorId } });
      await db.author.delete({ where: { id: authorId } });
    }
    for (const file of await db.fileObject.findMany({
      where: { createdById: { in: userIds } },
    }))
      await files.purgeUnreferenced(file.id);
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
