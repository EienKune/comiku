import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { TranslationsService } from "../../src/translations/translations.service.js";
import { WorksService } from "../../src/works/works.service.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable _test database.",
  );

test("page ownership claims, empty-page submissions, cancellation and explicit release remain independent", async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
      ),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const db = app.get(PrismaService),
    files = app.get(FileObjectsService),
    works = app.get(WorksService);
  const prefix = randomUUID();
  const users: string[] = [];
  let workId = "",
    candidateId = "",
    authorId = "",
    accountId = "";
  try {
    const migration = await db.$queryRaw<
      { checksum: string }[]
    >`SELECT checksum FROM _prisma_migrations WHERE migration_name='20261120000000_page_ownership' AND finished_at IS NOT NULL`;
    const migrationFile = await readFile(
      new URL(
        "../../prisma/migrations/20261120000000_page_ownership/migration.sql",
        import.meta.url,
      ),
    );
    assert.equal(
      migration[0]?.checksum,
      createHash("sha256").update(migrationFile).digest("hex"),
      "applied migration must match reviewed current source",
    );
    const constraints = await db.$queryRaw<
      { definition: string }[]
    >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='work_page_assignments'::regclass`;
    assert.ok(
      constraints.some((c) =>
        c.definition.includes("FOREIGN KEY (work_image_id, work_id)"),
      ),
    );
    assert.ok(
      constraints.some((c) =>
        c.definition.includes("FOREIGN KEY (participant_id, work_id, stage)"),
      ),
    );
    async function member(suffix: string) {
      const user = await db.user.create({
        data: {
          username: `pages_${prefix}_${suffix}`,
          displayName: suffix,
          passwordHash: "fixture-not-a-real-password",
          roles: { create: [{ role: "translator" }, { role: "proofreader" }] },
          languageCapabilities: { create: { language: "ja" } },
        },
      });
      users.push(user.id);
      return user.id;
    }
    const a = await member("a"),
      b = await member("b"),
      c = await member("c");
    authorId = (await db.author.create({ data: { displayName: prefix } })).id;
    accountId = (
      await db.authorExternalAccount.create({
        data: { authorId, platform: "fixture", externalUserId: prefix },
      })
    ).id;
    candidateId = (
      await db.candidatePost.create({
        data: {
          authorId,
          authorExternalAccountId: accountId,
          platform: "fixture",
          externalPostId: prefix,
          postedAt: new Date(),
          rawJson: { fixture: true },
        },
      })
    ).id;
    const file = await files.store({
      body: new Uint8Array([1]),
      contentType: "image/png",
      bucketScope: "source",
      kind: "candidate-media",
      createdById: a,
    });
    const initial = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: candidateId,
        importedById: a,
        collaborationMode: "multi",
        images: {
          create: [0, 1, 2].map((orderIndex) => ({
            originalFileObjectId: file.id,
            orderIndex,
          })),
        },
      },
      include: { images: { orderBy: { orderIndex: "asc" } } },
    });
    workId = initial.id;
    const ids = initial.images.map((p) => p.id);
    const heads = (
      head: Awaited<ReturnType<WorksService["get"]>>,
      userId: string,
    ) =>
      head.pageAssignments
        .filter(
          (p) =>
            p.stage === "translate" && !p.isSubmitted && p.userId === userId,
        )
        .map((p) => ({
          imageId: p.workImageId,
          generation: p.generation,
          draftRevision: p.draftRevision,
        }));

    let head = await works.claimStage(a, workId, {
      stage: "translate",
      imageIds: [ids[0]],
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const currentPage = await db.workPageAssignment.findFirstOrThrow({
      where: { workId, stage: "translate", workImageId: ids[0] },
    });
    await assert.rejects(() =>
      db.workPageAssignment.create({
        data: { workId, workImageId: ids[0], stage: "translate" },
      }),
    );
    await assert.rejects(
      () =>
        db.workPageAssignment.update({
          where: { id: currentPage.id },
          data: { stage: "typeset" },
        }),
      /Foreign key/,
    );
    const before = head.revision;
    const race = await Promise.allSettled([
      works.claimStage(b, workId, {
        stage: "translate",
        imageIds: [ids[1]],
        expectedRevision: before,
        idempotencyKey: randomUUID(),
      }),
      works.claimStage(c, workId, {
        stage: "translate",
        imageIds: [ids[1], ids[2]],
        expectedRevision: before,
        idempotencyKey: randomUUID(),
      }),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    head = await works.get(workId, a);
    const winner = head.pageAssignments.find(
      (p) => p.stage === "translate" && p.workImageId === ids[1],
    )!.userId!;
    const unassigned = head.pageAssignments.filter(
      (p) => p.stage === "translate" && !p.participantId,
    );
    if (unassigned.length)
      head = await works.claimStage(winner, workId, {
        stage: "translate",
        imageIds: unassigned.map((p) => p.workImageId),
        expectedRevision: head.revision,
        idempotencyKey: randomUUID(),
      });
    const loser = [b, c].find((id) => id !== winner)!;
    await assert.rejects(
      () =>
        works.claimStage(loser, workId, {
          stage: "translate",
          expectedRevision: head.revision,
          idempotencyKey: randomUUID(),
        }),
      /空闲/,
    );
    assert.equal(
      await db.workStageParticipant.count({
        where: { workId, stage: "translate", userId: loser, leftAt: null },
      }),
      0,
    );
    await db.userRole.create({ data: { userId: a, role: "admin" } });
    head = await works.updateCollaboration(a, workId, {
      collaborationMode: "single",
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      head.pageAssignments
        .filter((p) => p.stage === "translate")
        .every((p) => p.userId === a),
      true,
      "progress-free conversion keeps earliest member for all originals",
    );
    head = await works.updateCollaboration(a, workId, {
      collaborationMode: "multi",
      retainedTranslationImageIds: [ids[0]],
      confirmClearDraft: true,
      impactImageIds: ids.slice(1),
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      head.pageAssignments.filter(
        (p) => p.stage === "translate" && !p.participantId,
      ).length,
      2,
    );
    head = await works.claimStage(winner, workId, {
      stage: "translate",
      imageIds: ids.slice(1),
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });

    const translations = app.get(TranslationsService);
    await db.userRole.deleteMany({ where: { userId: a, role: "admin" } });
    const commonEmptyDraft = await translations.getEditor(a, workId);
    assert.equal(
      commonEmptyDraft.images.every((image) => image.entries.length === 0),
      true,
    );
    const imageBeforeDraft = await db.workImage.findUniqueOrThrow({
      where: { id: ids[0] },
    });
    const ownedBeforeDraft = head.pageAssignments.find(
      (p) => p.stage === "translate" && p.workImageId === ids[0],
    )!;
    const createdDraft = await translations.createEntry(a, ids[0], {
      markerX: 0.2,
      markerY: 0.4,
      markerPositionType: "inside",
      expectedImageRevision: imageBeforeDraft.translationRevision,
      expectedEditorEpoch: head.editorEpoch,
      expectedAssignmentGeneration: ownedBeforeDraft.generation,
      idempotencyKey: randomUUID(),
    });
    const winnerPage = head.pageAssignments.find(
      (p) => p.stage === "translate" && p.workImageId === ids[1],
    )!;
    const createdOtherPage = await translations.createEntry(winner, ids[1], {
      markerX: 0.5,
      markerY: 0.6,
      markerPositionType: "outside",
      expectedImageRevision: commonEmptyDraft.images[1].translationRevision,
      expectedEditorEpoch: commonEmptyDraft.editorEpoch,
      expectedAssignmentGeneration: winnerPage.generation,
      idempotencyKey: randomUUID(),
    });
    await translations.updateEntry(winner, createdOtherPage.entries[0].id, {
      translatedText: "Other page preserved",
      expectedRevision: 0,
      expectedEditorEpoch: commonEmptyDraft.editorEpoch,
      expectedAssignmentGeneration: winnerPage.generation,
    });
    await assert.rejects(
      translations.updateEntry(winner, createdDraft.entries[0].id, {
        translatedText: "Forbidden overwrite",
        expectedRevision: 0,
        expectedEditorEpoch: commonEmptyDraft.editorEpoch,
        expectedAssignmentGeneration: ownedBeforeDraft.generation,
      }),
      /只能编辑本人/,
    );
    await assert.rejects(
      translations.createEntry(loser, ids[2], {
        markerX: 0.2,
        markerY: 0.3,
        markerPositionType: "inside",
        expectedImageRevision: commonEmptyDraft.images[2].translationRevision,
        expectedEditorEpoch: commonEmptyDraft.editorEpoch,
        expectedAssignmentGeneration: winnerPage.generation,
        idempotencyKey: randomUUID(),
      }),
      /需要先加入/,
    );
    const beforeOtherTab = await works.get(workId, a);
    const oldHeads = heads(beforeOtherTab, a);
    await translations.updateEntry(a, createdDraft.entries[0].id, {
      translatedText: "Saved translation",
      expectedRevision: createdDraft.entries[0].revision,
      expectedEditorEpoch: head.editorEpoch,
      expectedAssignmentGeneration: ownedBeforeDraft.generation,
    });
    head = await works.get(workId, a);
    assert.equal(
      head.revision,
      beforeOtherTab.revision,
      "other-tab entry save does not change work revision",
    );
    await assert.rejects(
      () =>
        works.submitStage(a, workId, {
          stage: "translate",
          pageHeads: oldHeads,
          expectedRevision: head.revision,
          expectedEditorEpoch: head.editorEpoch,
          idempotencyKey: randomUUID(),
        }),
      /确切内容/,
    );
    await assert.rejects(
      () =>
        works.submitStage(a, workId, {
          stage: "translate",
          expectedRevision: head.revision,
          expectedEditorEpoch: head.editorEpoch,
          idempotencyKey: randomUUID(),
        }),
      /确切内容/,
    );
    head = await works.submitStage(a, workId, {
      pageHeads: heads(head, a),
      stage: "translate",
      expectedRevision: head.revision,
      expectedEditorEpoch: head.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    assert.equal(head.workflowStatus, "translating");
    // The ordinary-owner save/submission checks above are complete. Restore
    // administration only for the following collaboration-management checks.
    await db.userRole.create({ data: { userId: a, role: "admin" } });
    await assert.rejects(
      () =>
        works.updateCollaboration(a, workId, {
          collaborationMode: "single",
          expectedRevision: head.revision,
          idempotencyKey: randomUUID(),
        }),
      /实际进展/,
    );

    assert.equal(
      head.pageAssignments.find(
        (p) => p.workImageId === ids[0] && p.stage === "translate",
      )?.isSubmitted,
      true,
    );
    const key = randomUUID();
    const submit = {
      pageHeads: heads(head, winner),
      stage: "translate" as const,
      expectedRevision: head.revision,
      expectedEditorEpoch: head.editorEpoch,
      idempotencyKey: key,
    };
    head = await works.submitStage(winner, workId, submit);
    assert.equal(head.workflowStatus, "pending_proofread");
    assert.deepEqual(
      (await translations.getEditor(winner, workId)).images
        .slice(0, 2)
        .map((image) => image.entries[0].translatedText),
      ["Saved translation", "Other page preserved"],
      "separate owners submit from the same empty baseline without replacing another page",
    );
    await works.submitStage(winner, workId, submit);
    assert.equal(
      await db.translationVersion.count({
        where: { workId, stage: "translate" },
      }),
      1,
    );
    head = await works.cancelStageSubmission(a, workId, {
      stage: "translate",
      expectedRevision: head.revision,
      expectedEditorEpoch: head.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    assert.equal(head.workflowStatus, "translating");
    assert.equal(
      head.pageAssignments
        .filter((p) => p.stage === "translate" && p.userId === winner)
        .every((p) => p.isSubmitted),
      true,
    );
    await assert.rejects(
      () =>
        works.updateStageAssignments(a, workId, {
          stage: "translate",
          imageIds: [],
          expectedRevision: head.revision,
          idempotencyKey: randomUUID(),
        }),
      /确认/,
    );
    assert.equal(
      await db.translationEntry.count({
        where: { workImageId: ids[0], translatedText: "Saved translation" },
      }),
      1,
      "cancel submission preserves current draft",
    );
    const oldGeneration = head.pageAssignments.find(
      (p) => p.stage === "translate" && p.workImageId === ids[0],
    )!.generation;
    const releasedMemberId = head.participants.find(
      (person) =>
        person.userId === a && person.stage === "translate" && !person.leftAt,
    )!.id;
    const releaseScope = {
      stage: "translate" as const,
      participantId: releasedMemberId,
      imageIds: [],
      expectedRevision: head.revision,
      confirmClearDraft: true,
      impactImageIds: [ids[0]],
    };
    await assert.rejects(
      () =>
        works.updateStageAssignments(loser, workId, {
          ...releaseScope,
          idempotencyKey: randomUUID(),
        }),
      /管理员/,
    );
    await db.userRole.create({ data: { userId: loser, role: "admin" } });
    head = await works.updateStageAssignments(loser, workId, {
      participantId: releasedMemberId,
      stage: "translate",
      imageIds: [],
      confirmClearDraft: true,
      impactImageIds: [ids[0]],
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      head.participants.find((p) => p.userId === a && p.stage === "translate")
        ?.leftAt !== null,
      true,
    );
    assert.equal(
      await db.translationEntry.count({ where: { workImageId: ids[0] } }),
      0,
      "confirmed release clears only current draft",
    );
    assert.equal(
      await db.translationVersionEntry.count({
        where: { version: { workId }, translatedText: "Saved translation" },
      }),
      1,
      "confirmed release preserves immutable translated history",
    );
    head = await works.claimStage(winner, workId, {
      stage: "translate",
      imageIds: [ids[0]],
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });
    assert.ok(
      head.pageAssignments.find(
        (p) => p.stage === "translate" && p.workImageId === ids[0],
      )!.generation > oldGeneration,
    );
    assert.equal(
      head.pageAssignments
        .filter((p) => p.stage === "translate" && p.workImageId !== ids[0])
        .every((p) => p.isSubmitted),
      true,
    );
    head = await works.submitStage(winner, workId, {
      pageHeads: heads(head, winner),
      stage: "translate",
      expectedRevision: head.revision,
      expectedEditorEpoch: head.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    assert.equal(head.workflowStatus, "pending_proofread");
    const translated = await db.workEvent.findFirstOrThrow({
      where: {
        workId,
        action: "stage_submitted",
        detail: { path: ["stage"], equals: "translate" },
      },
      orderBy: { createdAt: "desc" },
    });
    const translatedCredits = (
      translated.detail as { credits: { userId: string }[] }
    ).credits;
    assert.deepEqual(
      translatedCredits.map((p) => p.userId),
      [winner],
      "released historical translator is absent from current final credits",
    );
    head = await works.claimStage(a, workId, {
      stage: "proofread",
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });
    await db.userRole.deleteMany({ where: { userId: loser, role: "admin" } });
    const outsider = await member("unassigned");
    await assert.rejects(
      works.addProofreader(outsider, workId, {
        userId: c,
        expectedRevision: head.revision,
        idempotencyKey: randomUUID(),
      }),
      /只有当前校对或管理员可以添加校对/,
      "qualified outsiders cannot delegate before joining",
    );
    await db.work.update({
      where: { id: workId },
      data: { collaborationMode: "single" },
    });
    await assert.rejects(
      works.claimStage(outsider, workId, {
        stage: "proofread",
        expectedRevision: head.revision,
        idempotencyKey: randomUUID(),
      }),
      /单人模式下该职责已有负责人/,
      "self joining must not bypass the single-owner rule",
    );
    await db.work.update({
      where: { id: workId },
      data: { collaborationMode: "multi" },
    });
    head = await works.claimStage(b, workId, {
      stage: "proofread",
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      head.participants.find(
        (p) => p.userId === b && p.stage === "proofread" && !p.leftAt,
      )?.participationMode,
      "collaborator",
      "qualified ordinary members can join existing multiplayer proofreading",
    );
    const extra = [a, b, c].find((id) => id !== a && id !== b)!;
    head = await works.addProofreader(a, workId, {
      userId: extra,
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });
    head = await works.leaveStage(extra, workId, {
      stage: "proofread",
      expectedRevision: head.revision,
      idempotencyKey: randomUUID(),
    });

    const sessionA = await db.authSession.create({
      data: {
        userId: a,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const sessionB = await db.authSession.create({
      data: {
        userId: b,
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const text = Buffer.from(
      [
        "1,0",
        "-",
        "框内",
        "框外",
        "-",
        "",
        ...ids.map((_, i) => `>>>>>>>>[p${i + 1}.png]<<<<<<<<\r\n`),
      ].join("\r\n"),
    );
    const upload = {
      buffer: text,
      originalname: "proofread.txt",
      mimetype: "text/plain",
      size: text.byteLength,
    };
    const preview = await translations.previewLabelPlusImport(
      b,
      workId,
      upload,
    );
    assert.equal(
      preview.canImport,
      true,
      "a non-admin proofreader can preview the whole manuscript",
    );
    assert.match(preview.contentBaseline, /^[a-f0-9]{64}$/);
    await assert.rejects(
      translations.importLabelPlus(b, sessionB.id, workId, upload, {
        stage: "proofread",
        expectedRevision: head.revision,
        expectedEditorEpoch: head.editorEpoch,
        idempotencyKey: randomUUID(),
      }),
      /预览基线/,
    );
    const withdrawnEpoch = head.editorEpoch;
    head = await works.cancelStageSubmission(winner, workId, {
      stage: "translate",
      expectedRevision: head.revision,
      expectedEditorEpoch: head.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    head = await works.submitStage(winner, workId, {
      pageHeads: heads(head, winner),
      stage: "translate",
      expectedRevision: head.revision,
      expectedEditorEpoch: head.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    await assert.rejects(
      translations.createEntry(b, ids[0], {
        markerX: 0.2,
        markerY: 0.3,
        markerPositionType: "inside",
        expectedImageRevision: 0,
        expectedEditorEpoch: withdrawnEpoch,
        idempotencyKey: randomUUID(),
        editorInstanceId: randomUUID(),
        leaseToken: randomUUID(),
      }),
      /新的正式版本/,
      "old proofreading writes cannot survive withdrawal and resubmission even with legacy lease fields",
    );
    // Existing clients may still hold a lease; it must not block direct edits or submission.
    await translations.leasePage(a, sessionA.id, workId, ids[0], {
      editorInstanceId: randomUUID(),
      expectedEditorEpoch: head.editorEpoch,
    });
    let baseline = await translations.getEditor(b, workId);
    assert.equal(baseline.proofreadRequiresLease, false);
    assert.deepEqual(
      baseline.proofreadLeases,
      [],
      "legacy leases are no longer projected as page restrictions",
    );
    const createInput = (page: number, epoch = baseline.editorEpoch) => ({
      markerX: 0.2,
      markerY: 0.3,
      markerPositionType: "inside" as const,
      expectedImageRevision: baseline.images[page].translationRevision,
      expectedEditorEpoch: epoch,
      idempotencyKey: randomUUID(),
    });
    const oldEpoch = baseline.editorEpoch;
    const competition = await Promise.allSettled([
      works.cancelStageSubmission(winner, workId, {
        stage: "translate",
        expectedRevision: head.revision,
        expectedEditorEpoch: head.editorEpoch,
        idempotencyKey: randomUUID(),
      }),
      translations.createEntry(a, ids[0], createInput(0)),
    ]);
    assert.equal(
      competition.filter((r) => r.status === "fulfilled").length,
      1,
      "translation rollback and first actual proofread save cannot both commit",
    );
    head = await works.get(workId, a);
    if (competition[0].status === "fulfilled") {
      assert.equal(head.workflowStatus, "translating");
      head = await works.submitStage(winner, workId, {
        pageHeads: heads(head, winner),
        stage: "translate",
        expectedRevision: head.revision,
        expectedEditorEpoch: head.editorEpoch,
        idempotencyKey: randomUUID(),
      });
      await assert.rejects(
        translations.createEntry(b, ids[1], createInput(1, oldEpoch)),
        /新的正式版本/,
        "withdrawal and resubmission cannot authorize a stale proofreading round",
      );
      baseline = await translations.getEditor(b, workId);
      await translations.createEntry(a, ids[0], createInput(0));
      head = await works.get(workId, a);
    }
    assert.equal(head.workflowStatus, "proofreading");
    assert.equal(
      head.editorEpoch,
      baseline.editorEpoch + 1,
      "first save advances the stage epoch once",
    );
    await assert.rejects(
      translations.createEntry(b, ids[1], createInput(1)),
      /新的正式版本/,
    );
    const preRefreshImageRevision = baseline.images[1].translationRevision;
    baseline = await translations.getEditor(b, workId);
    assert.equal(
      baseline.images[1].translationRevision,
      preRefreshImageRevision,
    );
    const savedB = await translations.createEntry(b, ids[1], createInput(1));
    assert.equal(
      savedB.mutation?.editorEpoch,
      head.editorEpoch,
      "the same round's other proofreader can save after rereading the promoted epoch",
    );
    const addedOnSamePage = await translations.createEntry(
      b,
      ids[0],
      createInput(0),
    );
    const entryA = baseline.images[0].entries[0];
    const entryB = addedOnSamePage.entries.at(-1)!;
    const beforePatches = await translations.previewLabelPlusImport(
      b,
      workId,
      upload,
    );
    await translations.updateEntry(a, entryA.id, {
      translatedText: "Proofreader A",
      expectedRevision: entryA.revision,
      expectedEditorEpoch: head.editorEpoch,
    });
    await translations.updateEntry(b, entryB.id, {
      translatedText: "Proofreader B",
      expectedRevision: entryB.revision,
      expectedEditorEpoch: head.editorEpoch,
    });
    await assert.rejects(
      translations.updateEntry(b, entryA.id, {
        translatedText: "Stale overwrite",
        expectedRevision: entryA.revision,
        expectedEditorEpoch: head.editorEpoch,
      }),
      /条目已更新/,
    );
    await assert.rejects(
      translations.updateEntry(outsider, entryA.id, {
        translatedText: "Unauthorized overwrite",
        expectedRevision: entryA.revision + 1,
        expectedEditorEpoch: head.editorEpoch,
      }),
      /需要先加入/,
    );
    assert.equal(
      (await works.get(workId, b)).revision,
      head.revision,
      "entry patches do not advance the work revision",
    );
    await assert.rejects(
      translations.importLabelPlus(b, sessionB.id, workId, upload, {
        stage: "proofread",
        expectedRevision: head.revision,
        expectedEditorEpoch: head.editorEpoch,
        expectedContentBaseline: beforePatches.contentBaseline,
        idempotencyKey: randomUUID(),
      }),
      /当前稿已变化/,
    );
    assert.deepEqual(
      (await translations.getEditor(b, workId)).images[0].entries.map(
        (e) => e.translatedText,
      ),
      ["Proofreader A", "Proofreader B"],
      "stale whole-manuscript import preserves both authors' patches",
    );
    const refreshedPreview = await translations.previewLabelPlusImport(
      b,
      workId,
      upload,
    );
    const importedProof = await translations.importLabelPlus(
      b,
      sessionB.id,
      workId,
      upload,
      {
        stage: "proofread",
        expectedRevision: head.revision,
        expectedEditorEpoch: head.editorEpoch,
        expectedContentBaseline: refreshedPreview.contentBaseline,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(
      importedProof.images.every((image) => image.entries.length === 0),
      true,
      "a qualified proofreader imports the confirmed manuscript without any page locks",
    );
    await translations.leasePage(a, sessionA.id, workId, ids[0], {
      editorInstanceId: randomUUID(),
      expectedEditorEpoch: importedProof.editorEpoch,
    });
    assert.equal(
      await db.proofreadPageLease.count({
        where: {
          workId,
          editorEpoch: importedProof.editorEpoch,
          expiresAt: { gt: new Date() },
        },
      }),
      1,
      "an active legacy lease is present when proofreading is submitted",
    );
    head = await works.get(workId, a);
    head = await works.submitStage(b, workId, {
      stage: "proofread",
      expectedRevision: head.revision,
      expectedEditorEpoch: head.editorEpoch,
      idempotencyKey: randomUUID(),
    });
    assert.equal(head.workflowStatus, "pending_typeset");
    const proofEvent = await db.workEvent.findFirstOrThrow({
      where: {
        workId,
        action: "stage_submitted",
        detail: { path: ["stage"], equals: "proofread" },
      },
      orderBy: { createdAt: "desc" },
    });
    assert.deepEqual(
      (proofEvent.detail as { credits: { userId: string }[] }).credits.map(
        (p) => p.userId,
      ),
      [a, b],
      "exited proofreader remains history only",
    );

    await assert.rejects(
      () =>
        works.cancelStageSubmission(winner, workId, {
          stage: "translate",
          expectedRevision: head.revision,
          expectedEditorEpoch: head.editorEpoch,
          idempotencyKey: randomUUID(),
        }),
      /下游/,
    );
  } catch (error) {
    console.error("Page workflow assertion failure", error);
    throw error;
  } finally {
    if (workId) {
      await db.workEvent.deleteMany({ where: { workId } });
      await db.proofreadPageLease.deleteMany({ where: { workId } });
      await db.labelPlusFile.deleteMany({ where: { workId } });
      await db.workPageAssignment.deleteMany({ where: { workId } });
      await db.workStageAssignment.deleteMany({
        where: { participant: { workId } },
      });
      await db.stageContributionSubmission.deleteMany({
        where: { participant: { workId } },
      });
      await db.work.update({
        where: { id: workId },
        data: {
          requiredHandoffVersionId: null,
          proofreadSkippedVersionId: null,
        },
      });
      await db.translationVersion.deleteMany({ where: { workId } });
      await db.translationEntry.deleteMany({
        where: { workImage: { workId } },
      });
      await db.workStageParticipant.deleteMany({ where: { workId } });
      await db.work.deleteMany({ where: { id: workId } });
    }
    if (candidateId)
      await db.candidatePost.deleteMany({ where: { id: candidateId } });
    if (accountId)
      await db.authorExternalAccount.deleteMany({ where: { id: accountId } });
    if (authorId) await db.author.deleteMany({ where: { id: authorId } });
    await db.fileObject.deleteMany({ where: { createdById: { in: users } } });
    await db.authSession.deleteMany({ where: { userId: { in: users } } });
    await db.userRole.deleteMany({ where: { userId: { in: users } } });
    await db.userLanguageCapability.deleteMany({
      where: { userId: { in: users } },
    });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await app.close();
  }
});
