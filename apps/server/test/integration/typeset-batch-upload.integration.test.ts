import { JobsService } from "../../src/jobs/jobs.service.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { test, mock } from "node:test";
import { Test } from "@nestjs/testing";
import { zipSync } from "fflate";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
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
import { TypesettingService } from "../../src/typesetting/typesetting.service.js";
import { tokenHash } from "../../src/users/password.js";
import type { TypesetUploadSessionDto } from "../../src/typesetting/typeset-upload.dto.js";
import { WorksService } from "../../src/works/works.service.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable _test database required");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

test("staged typeset batches resolve ambiguity, freeze baselines, isolate failures and preserve idempotent versions", async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
      ),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApplication(app);
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  const db = app.get(PrismaService),
    files = app.get(FileObjectsService),
    uploads = app.get(TypesetUploadsService),
    typesetting = app.get(TypesettingService),
    works = app.get(WorksService),
    storage = app.get<ObjectStorage>(OBJECT_STORAGE);
  const userIds: string[] = [],
    workIds: string[] = [];
  let authorId = "";
  try {
    const user = await db.user.create({
      data: {
        username: `batch_${randomUUID()}`,
        displayName: "Batch fixture",
        passwordHash: "non-login",
        mustChangePassword: false,
        roles: { create: { role: "typesetter" } },
      },
    });
    userIds.push(user.id);
    const token = randomBytes(32).toString("base64url");
    await db.authSession.create({
      data: {
        userId: user.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    async function extractRequest(
      sessionId: string,
      options: { json?: boolean; origin?: string; marker?: string } = {},
    ) {
      return fetch(`${base}/api/typeset/upload-sessions/${sessionId}/extract`, {
        method: "POST",
        headers: {
          Origin: options.origin ?? "http://localhost:5173",
          "X-Comiku-Request": options.marker ?? "1",
          Cookie: `comiku_session=${token}`,
          ...(options.json === false
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: options.json === false ? undefined : "{}",
      });
    }
    const other = await db.user.create({
      data: {
        username: `other_${randomUUID()}`,
        displayName: "Other fixture",
        passwordHash: "non-login",
        roles: { create: { role: "typesetter" } },
      },
    });
    userIds.push(other.id);
    const admin = await db.user.create({
      data: {
        username: `admin_${randomUUID()}`,
        displayName: "Admin fixture",
        passwordHash: "non-login",
        roles: { create: { role: "admin" } },
      },
    });
    userIds.push(admin.id);
    const author = await db.author.create({
      data: { displayName: "Batch fixture author" },
    });
    authorId = author.id;
    const original = await files.store({
      body: png,
      contentType: "image/png",
      bucketScope: "works",
      kind: "fixture",
      createdById: user.id,
    });
    async function makeWork(started = true, owner = user.id) {
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
          importedById: user.id,
          sourceLanguage: "ja",
          editorEpoch: 1,
          workflowStatus: started ? "typesetting" : "pending_typeset",
          typesetHandoffStartedAt: started ? new Date() : null,
          images: {
            create: { originalFileObjectId: original.id, orderIndex: 0 },
          },
          stageParticipants: {
            create: {
              stage: "typeset",
              userId: owner,
              participationMode: "owner",
            },
          },
        },
      });
      workIds.push(work.id);
      return work;
    }
    const a = await makeWork(),
      b = await makeWork(false),
      unauthorized = await makeWork(true, other.id);
    // This legacy complete-version flow belongs to single mode. Multi-mode
    // uploads with explicit page maps atomically save and submit the actor's pages.
    await db.workCreditAlias.create({
      data: {
        workId: a.id,
        userId: user.id,
        stage: "typeset",
        creditName: "临时嵌字署名",
      },
    });
    const inputs = [
      {
        name: `${a.workNumber}_成图.zip`,
        body: Buffer.from(
          zipSync({
            [`${a.workNumber}-010成图.png`]: png,
            [`${a.workNumber}-002成图.png`]: png,
            "解释说明.png": png,
          }),
        ),
        type: "application/zip",
      },
      {
        name: `${a.workNumber}.zip`,
        body: Buffer.from(zipSync({ [`${a.workNumber}-003成图.png`]: png })),
        type: "application/zip",
      },
      { name: `${a.workNumber}-004.png`, body: png, type: "image/png" },
      { name: `${b.workNumber}-001成图.png`, body: png, type: "image/png" },
      {
        name: `${unauthorized.workNumber}-001成图.png`,
        body: png,
        type: "image/png",
      },
      { name: "missing.png", body: png, type: "image/png" },
    ];
    const session = await uploads.create(user.id, {
      files: inputs.map((input) => ({
        sourceName: input.name,
        contentType: input.type,
        size: input.body.length,
        checksum: createHash("sha256").update(input.body).digest("hex"),
      })),
    });
    assert.deepEqual(
      session.files.map((file) => file.sourceName),
      inputs.map((file) => file.name),
    );
    await assert.rejects(
      uploads.create(admin.id, { files: [] }),
      ForbiddenException,
    );
    for (const [index, item] of session.files.entries()) {
      const record = await db.typesetUploadFile.findUniqueOrThrow({
        where: { id: item.id },
      });
      const input = inputs[index];
      await storage.put({
        key: record.objectKey,
        body: input.body,
        size: input.body.length,
        contentType: input.type,
        checksum: record.checksum,
      });
    }
    for (const options of [
      { json: false },
      { origin: "https://other.invalid" },
      { marker: "0" },
    ]) {
      const denied = await extractRequest(session.id, options);
      assert.equal(denied.status, 403);
      const error = (await denied.json()) as { message: string };
      assert.match(error.message, /请求来源或格式无效/u);
    }
    assert.equal((await uploads.get(user.id, session.id)).status, "pending");
    const extractedResponse = await extractRequest(session.id);
    assert.equal(extractedResponse.status, 200);
    const queued = (await extractedResponse.json()) as TypesetUploadSessionDto;
    assert.equal(queued.status, "extracting");
    assert.equal(queued.files.flatMap((file) => file.images).length, 0);
    async function finishExtraction(id: string) {
      const job = await db.backgroundJob.findUniqueOrThrow({
        where: { idempotencyKey: `typeset-extract:${id}` },
      });
      await db.backgroundJob.update({
        where: { id: job.id },
        data: { priority: 100, createdAt: new Date("2000-01-01") },
      });
      assert.equal(await app.get(JobsService).runNext("heavy"), true);
      return uploads.get(user.id, id);
    }
    const extracted = await finishExtraction(session.id);
    assert.equal(extracted.files.flatMap((file) => file.images).length, 8);
    assert.equal(
      (await uploads.extract(user.id, session.id)).files.flatMap(
        (file) => file.images,
      ).length,
      8,
    );
    const raw = { name: "9-001.png", body: png, type: "image/png" };
    const packed = {
      name: "7.zip",
      body: Buffer.from(
        zipSync({
          "7-001.png": png,
          "7-002.png": png,
          "7-003.png": png,
          "7-004.png": png,
        }),
      ),
      type: "application/zip",
    };
    for (const selected of [[raw], [packed], [raw, packed]]) {
      const sample = await uploads.create(user.id, {
        files: selected.map((input) => ({
          sourceName: input.name,
          contentType: input.type,
          size: input.body.length,
          checksum: createHash("sha256").update(input.body).digest("hex"),
        })),
      });
      for (const [index, file] of sample.files.entries()) {
        const record = await db.typesetUploadFile.findUniqueOrThrow({
          where: { id: file.id },
        });
        const input = selected[index];
        await storage.put({
          key: record.objectKey,
          body: input.body,
          size: input.body.length,
          contentType: input.type,
          checksum: record.checksum,
        });
      }
      // Retrying the same HTTP action restores the already uploaded materials.
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await extractRequest(sample.id);
        assert.equal(response.status, 200);
        const initial = (await response.json()) as TypesetUploadSessionDto;
        const result =
          initial.status === "extracting"
            ? await finishExtraction(sample.id)
            : initial;
        assert.equal(
          result.files.flatMap((file) => file.images).length,
          selected.reduce(
            (count, file) => count + (file.type === "application/zip" ? 4 : 1),
            0,
          ),
        );
        assert.ok(result.files.every((file) => file.status === "processed"));
      }
    }
    await assert.rejects(uploads.get(other.id, session.id), NotFoundException);
    const aImages = extracted.files
      .filter((file) => file.sourceName.startsWith(`${a.workNumber}`))
      .flatMap((file) => file.images);
    const bImage = extracted.files[3].images[0],
      otherImage = extracted.files[4].images[0];
    assert.equal(aImages.length, 5);
    assert.ok((await uploads.imageUrl(user.id, session.id, aImages[0].id)).url);
    await assert.rejects(
      uploads.imageUrl(other.id, session.id, aImages[0].id),
      NotFoundException,
    );
    const group = (number: number, ids: string[], merge = false) => ({
      workNumber: number,
      imageIds: ids,
      mergeConfirmed: merge,
      manualTargetConfirmed: true,
      contentConfirmed: true,
    });
    const invalid = await uploads.plans(user.id, session.id, {
      groups: [
        group(
          a.workNumber,
          aImages.map((image) => image.id),
        ),
        group(b.workNumber, [bImage.id]),
        group(unauthorized.workNumber, [otherImage.id]),
        group(2147483647, [extracted.files[5].images[0].id]),
      ],
    });
    assert.match(invalid.items[0].error!, /合并/);
    assert.match(invalid.items[1].error!, /交接包/);
    assert.equal(invalid.items[1].workId, b.id);
    assert.match(invalid.items[2].error!, /认领/);
    assert.match(invalid.items[3].error!, /不存在/);
    const first = (
      await uploads.plans(user.id, session.id, {
        groups: [
          group(a.workNumber, aImages.map((image) => image.id).reverse(), true),
        ],
      })
    ).items[0];
    assert.equal(first.error, null);
    assert.ok(first.previewId);
    await db.work.update({
      where: { id: a.id },
      data: { revision: { increment: 1 } },
    });
    await assert.rejects(
      uploads.confirm(user.id, session.id, first.previewId!),
      ConflictException,
    );
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: a.id } }),
      0,
    );
    const fresh = (
      await uploads.plans(user.id, session.id, {
        groups: [
          group(a.workNumber, aImages.map((image) => image.id).reverse(), true),
        ],
      })
    ).items[0];
    await assert.rejects(
      uploads.confirm(user.id, session.id, first.previewId!),
      ConflictException,
    );
    const failure = mock.method(works, "submitStageTx", async () => {
      throw new ConflictException("模拟阶段提交失败");
    });
    try {
      await assert.rejects(
        uploads.confirm(user.id, session.id, fresh.previewId!),
        /模拟阶段提交失败/u,
      );
    } finally {
      failure.mock.restore();
    }
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: a.id } }),
      0,
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: a.id } }))
        .currentTypesetVersionId,
      null,
    );
    assert.equal(
      (
        await db.typesetUploadPreview.findUniqueOrThrow({
          where: { id: fresh.previewId! },
        })
      ).versionId,
      null,
    );
    assert.equal(
      await db.workEvent.count({
        where: { workId: a.id, action: "typeset_version_uploaded" },
      }),
      0,
    );
    const results = await Promise.all([
      uploads.confirm(user.id, session.id, fresh.previewId!),
      uploads.confirm(user.id, session.id, fresh.previewId!),
    ]);
    assert.equal(results[0].versionId, results[1].versionId);
    assert.ok(results.every((result) => result.stageSubmitted));
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: a.id } }),
      1,
    );
    const version = await typesetting.listVersions(a.id);
    assert.deepEqual(
      version.items[0].images.map((image) => image.sourceName),
      aImages.map((image) => image.sourceName).reverse(),
    );
    assert.ok(
      version.items[0].images.every((image) => image.workImageId === null),
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: a.id } })).workflowStatus,
      "pending_publish",
    );
    const participants = await db.workStageParticipant.findMany({
      where: { workId: a.id, stage: "typeset", leftAt: null },
    });
    assert.equal(participants.length, 1);
    assert.ok(participants.every((participant) => participant.submittedAt));
    assert.equal(
      participants.find((participant) => participant.userId === user.id)
        ?.creditNameSnapshot,
      "临时嵌字署名",
    );
    const committed = await db.work.findUniqueOrThrow({ where: { id: a.id } });
    await works.cancelStageSubmission(user.id, a.id, {
      stage: "typeset",
      expectedRevision: committed.revision,
      expectedEditorEpoch: committed.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    const replay = await uploads.confirm(user.id, session.id, fresh.previewId!);
    assert.equal(replay.versionId, results[0].versionId);
    assert.equal(replay.stageSubmitted, true);
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: a.id } })).workflowStatus,
      "typesetting",
    );
    assert.equal(
      await db.workStageParticipant.count({
        where: {
          workId: a.id,
          stage: "typeset",
          submittedAt: null,
          leftAt: null,
        },
      }),
      1,
    );
    assert.equal(
      (
        await uploads.plans(user.id, session.id, {
          groups: [
            group(
              a.workNumber,
              aImages.map((image) => image.id),
              true,
            ),
          ],
        })
      ).items[0].previewId,
      null,
    );
    await db.translationVersion.create({
      data: {
        workId: b.id,
        versionNumber: 1,
        kind: "proofread_submission",
        stage: "proofread",
        workRevision: b.revision,
        editorEpoch: b.editorEpoch,
        createdById: user.id,
      },
    });
    const packageInput = {
      expectedRevision: b.revision,
      expectedEditorEpoch: b.editorEpoch,
      idempotencyKey: randomUUID(),
    };
    const pack = await typesetting.prepareBatchHandoff(
      user.id,
      b.id,
      packageInput,
    );
    await typesetting.readHandoffPackage(
      user.id,
      b.id,
      pack.packageId,
      packageInput,
    );
    const bPlan = (
      await uploads.plans(user.id, session.id, {
        groups: [group(b.workNumber, [bImage.id])],
      })
    ).items[0];
    assert.ok(bPlan.previewId);
    await db.workStageParticipant.updateMany({
      where: { workId: b.id, userId: user.id },
      data: { leftAt: new Date() },
    });
    await assert.rejects(
      uploads.confirm(user.id, session.id, bPlan.previewId!),
      ForbiddenException,
    );
    await db.workStageParticipant.updateMany({
      where: { workId: b.id, userId: user.id },
      data: { leftAt: null },
    });
    await db.work.update({
      where: { id: b.id },
      data: { reviewStatus: "blocked" },
    });
    await assert.rejects(
      uploads.confirm(user.id, session.id, bPlan.previewId!),
      ConflictException,
    );
    await db.work.update({
      where: { id: b.id },
      data: { reviewStatus: "normal" },
    });
    assert.equal(
      (await uploads.confirm(user.id, session.id, bPlan.previewId!))
        .stageSubmitted,
      true,
    );
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: b.id } }),
      1,
    );
    assert.equal(await db.candidatePost.count({ where: { authorId } }), 3);
    assert.ok(results[0].versionId);
    const linked = await db.typesetImageVersionImage.findFirstOrThrow({
      where: { versionId: results[0].versionId },
    });
    const unlinked = await db.typesetUploadImage.findUniqueOrThrow({
      where: { id: otherImage.id },
    });
    await db.typesetUploadSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await assert.rejects(
      uploads.confirm(user.id, session.id, bPlan.previewId!),
      ConflictException,
    );
    await uploads.cleanupExpired();
    assert.ok((await files.read(linked.fileObjectId)).body.length);
    assert.equal(
      await db.fileObject.findUnique({ where: { id: unlinked.fileObjectId } }),
      null,
    );
    assert.equal(
      await db.typesetUploadImage.count({
        where: { uploadFile: { sessionId: session.id } },
      }),
      0,
    );
    assert.equal(
      await db.workEvent.count({
        where: { workId: { in: workIds }, action: "stage_submitted" },
      }),
      2,
    );

    // A complete archive can cover several owners. The frozen map is explicit,
    // only our pages are written, and confirmation submits them atomically.
    const multi = await makeWork();
    await db.work.update({
      where: { id: multi.id },
      data: { collaborationMode: "multi" },
    });
    await db.workImage.createMany({
      data: [1, 2].map((orderIndex) => ({
        workId: multi.id,
        originalFileObjectId: original.id,
        orderIndex,
      })),
    });
    const pages = await db.workImage.findMany({
      where: { workId: multi.id },
      orderBy: { orderIndex: "asc" },
    });
    const me = await db.workStageParticipant.findFirstOrThrow({
      where: { workId: multi.id, userId: user.id, stage: "typeset" },
    });
    const them = await db.workStageParticipant.create({
      data: {
        workId: multi.id,
        userId: other.id,
        stage: "typeset",
        participationMode: "collaborator",
      },
    });
    await db.workPageAssignment.createMany({
      data: pages.map((page, index) => ({
        workId: multi.id,
        workImageId: page.id,
        stage: "typeset",
        participantId: index === 1 ? them.id : me.id,
      })),
    });
    async function stageArchive(actorId: string, count: number) {
      const body = Buffer.from(
        zipSync(
          Object.fromEntries(
            Array.from({ length: count }, (_, i) => [
              `plain-${String.fromCharCode(97 + i)}.png`,
              png,
            ]),
          ),
        ),
      );
      const created = await uploads.create(actorId, {
        files: [
          {
            sourceName: "unnumbered.zip",
            contentType: "application/zip",
            size: body.length,
            checksum: createHash("sha256").update(body).digest("hex"),
          },
        ],
      });
      const file = await db.typesetUploadFile.findUniqueOrThrow({
        where: { id: created.files[0].id },
      });
      await storage.put({
        key: file.objectKey,
        body,
        size: body.length,
        contentType: "application/zip",
        checksum: file.checksum,
      });
      return uploads.extract(actorId, created.id);
    }
    const stagedMulti = await stageArchive(user.id, 3);
    const stagedImages = stagedMulti.files[0].images;
    const multiGroup = {
      workNumber: multi.workNumber,
      imageIds: stagedImages.map((image) => image.id),
      mergeConfirmed: false,
      manualTargetConfirmed: true,
      contentConfirmed: true,
    };
    const unmapped = await uploads.plans(user.id, stagedMulti.id, {
      groups: [multiGroup],
    });
    assert.match(unmapped.items[0].error!, /逐图确认/);
    // Deliberately reverse the two own pages: the explicit order wins over filenames.
    const mapped = await uploads.plans(user.id, stagedMulti.id, {
      groups: [
        {
          ...multiGroup,
          pageMappings: stagedImages.map((image, index) => ({
            imageId: image.id,
            workImageId: pages[2 - index].id,
          })),
        },
      ],
    });
    assert.equal(mapped.items[0].error, null);
    assert.equal(mapped.items[0].savedImageCount, 2);
    assert.deepEqual(mapped.items[0].ignored, [stagedImages[1].sourceName]);
    // The first own-page write occurs before the second file is rejected.
    // Both it and the submission must roll back together, then retry safely.
    const rejectedImage = await db.typesetUploadImage.findUniqueOrThrow({
      where: { id: stagedImages[2].id },
    });
    await db.fileObject.update({
      where: { id: rejectedImage.fileObjectId },
      data: { lifecycleStatus: "pending_deletion" },
    });
    await assert.rejects(
      uploads.confirm(user.id, stagedMulti.id, mapped.items[0].previewId!),
      /预览文件不可用/,
    );
    assert.equal(
      await db.workTypesetDraft.count({ where: { workId: multi.id } }),
      0,
    );
    assert.equal(await db.workEvent.count({ where: { workId: multi.id } }), 0);
    await db.fileObject.update({
      where: { id: rejectedImage.fileObjectId },
      data: { lifecycleStatus: "active" },
    });
    const multiResults = await Promise.all(
      [0, 1].map(() =>
        uploads.confirm(user.id, stagedMulti.id, mapped.items[0].previewId!),
      ),
    );
    assert.equal(multiResults[0].stageSubmitted, true);
    assert.equal(multiResults[0].workCompleted, false);
    assert.equal(multiResults[0].versionId, null);
    assert.equal(multiResults[1].stageSubmitted, true);
    const restoredPersonal = await uploads.get(user.id, stagedMulti.id);
    assert.deepEqual(restoredPersonal.receipts, [
      {
        workNumber: multi.workNumber,
        workId: multi.id,
        versionId: null,
        stageSubmitted: true,
        workCompleted: false,
        imageIds: stagedImages.map((image) => image.id),
      },
    ]);
    const ownDrafts = await db.workTypesetDraft.findMany({
      where: { workId: multi.id },
      orderBy: { orderIndex: "asc" },
    });
    assert.deepEqual(
      ownDrafts.map((draft) => [draft.workImageId, draft.sourceName]),
      [
        [pages[0].id, stagedImages[2].sourceName],
        [pages[2].id, stagedImages[0].sourceName],
      ],
    );
    assert.ok(
      ownDrafts.every(
        (draft) =>
          draft.participantId === me.id &&
          draft.submittedRevision === draft.revision,
      ),
    );
    assert.equal(
      await db.workTypesetDraft.count({
        where: { workId: multi.id, participantId: them.id },
      }),
      0,
    );
    assert.equal(
      await db.workEvent.count({
        where: { workId: multi.id, action: "stage_submitted" },
      }),
      1,
    );
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: multi.id } }),
      0,
    );
    const otherSession = await stageArchive(other.id, 1);
    const otherPlan = await uploads.plans(other.id, otherSession.id, {
      groups: [
        {
          ...multiGroup,
          imageIds: [otherSession.files[0].images[0].id],
          pageMappings: [
            {
              imageId: otherSession.files[0].images[0].id,
              workImageId: pages[1].id,
            },
          ],
        },
      ],
    });
    assert.equal(otherPlan.items[0].error, null);
    const finalResult = await uploads.confirm(
      other.id,
      otherSession.id,
      otherPlan.items[0].previewId!,
    );
    assert.equal(finalResult.stageSubmitted, true);
    assert.equal(finalResult.workCompleted, true);
    assert.ok(finalResult.versionId);
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: multi.id } }))
        .workflowStatus,
      "pending_publish",
    );
    assert.equal(
      await db.typesetImageVersion.count({ where: { workId: multi.id } }),
      1,
    );
    // Old replays retain the historical personal-only receipt after someone else completes.
    const oldReceipt = await uploads.confirm(
      user.id,
      stagedMulti.id,
      mapped.items[0].previewId!,
    );
    assert.equal(oldReceipt.workCompleted, false);
    assert.equal(oldReceipt.versionId, null);
    assert.equal(
      (await uploads.get(user.id, stagedMulti.id)).receipts?.[0].workCompleted,
      false,
    );
    assert.equal(
      (await uploads.get(other.id, otherSession.id)).receipts?.[0]
        .workCompleted,
      true,
    );
  } finally {
    await db.typesetUploadPreview.deleteMany({
      where: { session: { actorId: { in: userIds } } },
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
    await db.stageContributionPage.deleteMany({
      where: { submission: { participant: { workId: { in: workIds } } } },
    });
    await db.stageContributionSubmission.deleteMany({
      where: { participant: { workId: { in: workIds } } },
    });
    await db.workTypesetDraft.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workPageAssignment.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workStageParticipant.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workCreditAlias.deleteMany({ where: { workId: { in: workIds } } });
    await db.workImage.deleteMany({ where: { workId: { in: workIds } } });
    await db.work.deleteMany({ where: { id: { in: workIds } } });
    if (authorId) {
      await db.candidatePost.deleteMany({ where: { authorId } });
      await db.author.delete({ where: { id: authorId } });
    }
    const ownedFiles = await db.fileObject.findMany({
      where: { createdById: { in: userIds } },
    });
    for (const file of ownedFiles) await files.purgeUnreferenced(file.id);
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
