import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { unzipSync } from "fflate";
import { AppModule } from "../../src/app.module.js";
import { configureApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { hashPassword } from "../../src/users/password.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable _test database.",
  );
}

type Browser = { cookie?: string };

test("work participation, review blocking, audit and dashboard lifecycle", async () => {
  const prefix = randomUUID().slice(0, 8);
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
      ),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApplication(app);
  const db = app.get(PrismaService);
  const files = app.get(FileObjectsService);
  const password = "workflow-password-12345";
  const userIds: string[] = [];
  let authorId = "";
  let accountId = "";
  let candidateId = "";
  let fileId = "";
  let workId = "";
  let base = "";

  async function request<T>(
    browser: Browser,
    method: string,
    path: string,
    body?: object,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) browser.cookie = cookie.split(";")[0];
    const data = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : await response.text();
    return { status: response.status, data: data as T };
  }

  async function multipartRequest<T>(
    browser: Browser,
    path: string,
    fields: Record<string, string>,
    uploads: { name: string; body: Uint8Array; type: string }[],
  ) {
    const form = new FormData();
    Object.entries(fields).forEach(([key, value]) => form.set(key, value));
    uploads.forEach((upload) =>
      form.append(
        "files",
        new Blob([upload.body], { type: upload.type }),
        upload.name,
      ),
    );
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
      },
      body: form,
    });
    return { status: response.status, data: (await response.json()) as T };
  }

  function png(width: number, height: number) {
    const body = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(body);
    body.writeUInt32BE(width, 16);
    body.writeUInt32BE(height, 20);
    return body;
  }

  async function createBrowser(
    suffix: string,
    role:
      | "admin"
      | "source"
      | "translator"
      | "proofreader"
      | "typesetter"
      | "operator"
      | "reviewer",
  ) {
    const user = await db.user.create({
      data: {
        username: `flow_${prefix}_${suffix}`,
        displayName: suffix,
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
        roles: { create: { role } },
        languageCapabilities: {
          create: [{ language: "ja" }, { language: "ko" }],
        },
      },
    });
    userIds.push(user.id);
    const browser: Browser = {};
    assert.equal(
      (
        await request(browser, "POST", "/api/auth/login", {
          username: user.username,
          password,
        })
      ).status,
      200,
    );
    return { browser, user };
  }

  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const pendingCandidateBaseline = await db.candidatePost.count({
      where: { status: "pending" },
    });
    const admin = await createBrowser("admin", "admin");
    const source = await createBrowser("source", "source");
    const translator = await createBrowser("translator", "translator");
    await db.userRole.create({
      data: { userId: translator.user.id, role: "proofreader" },
    });
    const proofreader = await createBrowser("proofreader", "proofreader");
    const typesetter = await createBrowser("typesetter", "typesetter");
    const operator = await createBrowser("operator", "operator");
    const reviewer = await createBrowser("reviewer", "reviewer");
    const unrelated = await createBrowser("unrelated", "translator");

    const author = await db.author.create({
      data: {
        displayName: `流程作者 ${prefix}`,
        authorizationStatus: "authorized",
      },
    });
    authorId = author.id;
    const account = await db.authorExternalAccount.create({
      data: {
        authorId,
        platform: "fixture",
        externalUserId: `workflow-${prefix}`,
        handle: "_workflow_author_",
      },
    });
    accountId = account.id;
    const file = await files.store({
      body: new TextEncoder().encode("workflow image"),
      contentType: "image/png",
      bucketScope: "source",
      kind: "candidate-media",
      createdById: source.user.id,
    });
    fileId = file.id;
    const candidate = await db.candidatePost.create({
      data: {
        authorId,
        authorExternalAccountId: accountId,
        platform: "fixture",
        externalPostId: `workflow-post-${prefix}`,
        externalPostUrl: `https://fixture.invalid/${prefix}`,
        text: "流程测试作品",
        postedAt: new Date(),
        rawJson: { fixture: true },
      },
    });
    candidateId = candidate.id;
    await db.candidateMedia.create({
      data: {
        candidatePostId: candidateId,
        externalMediaId: `workflow-media-${prefix}`,
        orderIndex: 0,
        fileObjectId: fileId,
        sourceUrl: `https://media.fixture.invalid/${prefix}.png`,
        width: 1000,
        height: 700,
        mediaType: "photo",
      },
    });
    const work = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: candidateId,
        sourcePostUrl: candidate.externalPostUrl,
        title: "流程测试作品",
        importedById: source.user.id,
        images: {
          create: {
            originalFileObjectId: fileId,
            orderIndex: 0,
            width: 1000,
            height: 700,
          },
        },
        events: {
          create: {
            actorId: source.user.id,
            action: "imported",
            toWorkflowStatus: "pending_translate",
            toReviewStatus: "normal",
          },
        },
      },
    });
    workId = work.id;
    const originalWorkImage = await db.workImage.findFirstOrThrow({
      where: { workId },
      orderBy: { orderIndex: "asc" },
    });

    type WorkResponse = {
      id: string;
      workflowStatus: string;
      reviewStatus: string;
      revision: number;
      editorEpoch: number;
      typesetHandoffStartedAt: string | null;
      translationAttentionStage: string | null;
      translationAttentionVersionNumber: number | null;
      assignedStages: string[];
      openReviewCaseId: string | null;
      participants: {
        id: string;
        userId: string;
        participationMode: string;
        workCreditName: string | null;
        creditNameSnapshot: string | null;
        submittedAt: string | null;
        leftAt: string | null;
      }[];
      events: { action: string }[];
      images: { id: string }[];
    };
    type TranslationEntryResponse = {
      id: string;
      orderIndex: number;
      markerX: number;
      markerY: number;
      translatedText: string;
      revision: number;
      mutation?: {
        workRevision: number;
        editorEpoch: number;
        workflowStatus: string;
      };
    };
    type TranslationImageResponse = {
      id: string;
      translationRevision: number;
      entries: TranslationEntryResponse[];
      mutation?: {
        workRevision: number;
        editorEpoch: number;
        workflowStatus: string;
      };
    };
    type TranslationEditorResponse = {
      canEdit: boolean;
      editStages: string[];
      joinableStage: string | null;
      submissionStage: string | null;
      cancelableSubmissionStage: string | null;
      editorEpoch: number;
      typesetHandoffStartedAt: string | null;
      workRevision: number;
      hasUnsubmittedChanges: boolean;
      revisionStages: string[];
      translationAttentionStage: string | null;
      translationAttentionVersionNumber: number | null;
      latestVersion: {
        versionNumber: number;
        editorEpoch: number;
        kind: string;
      } | null;
      images: TranslationImageResponse[];
      activeParticipants: {
        userId: string;
        displayName: string;
        mode: "view" | "edit";
        stages: string[];
        isCurrentSession: boolean;
      }[];
    };
    type TranslationPresenceResponse = {
      expiresInSeconds: number;
      items: TranslationEditorResponse["activeParticipants"];
    };
    const initial = await request<WorkResponse>(
      translator.browser,
      "GET",
      `/api/works/${workId}`,
    );
    assert.equal(initial.status, 200);
    assert.equal(initial.data.workflowStatus, "pending_translate");
    assert.match(
      (
        await request<{ url: string }>(
          translator.browser,
          "GET",
          `/api/works/${workId}/images/${initial.data.images[0].id}/url`,
        )
      ).data.url,
      /^memory:/,
    );

    const joinKey = randomUUID();
    assert.equal(
      (
        await request(
          reviewer.browser,
          "POST",
          `/api/works/${workId}/stages/join`,
          {
            stage: "translate",
            expectedRevision: 0,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );
    const missingWorkId = randomUUID();
    const proofreadBatch = await request<{
      results: {
        id: string;
        outcome: "succeeded" | "not_found";
        message: string | null;
      }[];
    }>(proofreader.browser, "POST", "/api/works/stages/claims", {
      stage: "proofread",
      items: [
        {
          id: workId,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        },
        {
          id: missingWorkId,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        },
      ],
    });
    assert.equal(proofreadBatch.status, 200);
    assert.deepEqual(
      proofreadBatch.data.results.map(({ id, outcome }) => ({ id, outcome })),
      [
        { id: workId, outcome: "succeeded" },
        { id: missingWorkId, outcome: "not_found" },
      ],
    );
    let proofReserved = await request<WorkResponse>(
      proofreader.browser,
      "GET",
      `/api/works/${workId}`,
    );
    assert.equal(proofReserved.data.workflowStatus, "pending_translate");
    assert.deepEqual(proofReserved.data.assignedStages, ["proofread"]);
    assert.equal(
      (
        await request(
          proofreader.browser,
          "POST",
          `/api/works/${workId}/stages/leave`,
          {
            stage: "proofread",
            expectedRevision: proofReserved.data.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      200,
    );
    const afterLeave = (
      await request<WorkResponse>(
        translator.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.ok(!afterLeave.assignedStages.includes("proofread"));
    assert.ok(afterLeave.events.some((event) => event.action === "stage_left"));
    assert.equal(
      (
        await request(
          admin.browser,
          "POST",
          `/api/works/${workId}/stages/claim`,
          {
            stage: "publish",
            expectedRevision: afterLeave.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      400,
    );
    proofReserved = await request<WorkResponse>(
      proofreader.browser,
      "POST",
      `/api/works/${workId}/stages/claim`,
      {
        stage: "proofread",
        expectedRevision: afterLeave.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(proofReserved.status, 200);
    assert.equal(
      (
        await request(
          admin.browser,
          "POST",
          `/api/works/${workId}/stages/claim`,
          {
            stage: "proofread",
            expectedRevision: proofReserved.data.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          reviewer.browser,
          "POST",
          `/api/works/${workId}/stages/claim`,
          {
            stage: "typeset",
            expectedRevision: proofReserved.data.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );
    const typesetClaimed = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/claim`,
      {
        stage: "typeset",
        expectedRevision: proofReserved.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(typesetClaimed.status, 200);
    assert.equal(typesetClaimed.data.workflowStatus, "pending_translate");
    assert.ok(typesetClaimed.data.assignedStages.includes("typeset"));
    const withoutProofread = await request<{ items: { id: string }[] }>(
      translator.browser,
      "GET",
      "/api/works?unassignedStage=proofread",
    );
    assert.equal(withoutProofread.status, 200);
    assert.ok(!withoutProofread.data.items.some((item) => item.id === workId));
    let joined = await request<WorkResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/stages/join`,
      {
        stage: "translate",
        creditName: "本作品译者署名",
        expectedRevision: typesetClaimed.data.revision,
        idempotencyKey: joinKey,
      },
    );
    assert.equal(joined.status, 200);
    assert.equal(joined.data.workflowStatus, "pending_translate");
    assert.equal(joined.data.editorEpoch, 0);
    assert.equal(
      joined.data.participants.find(
        (participant) => participant.userId === translator.user.id,
      )?.participationMode,
      "owner",
    );
    const replayedJoin = await request<WorkResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/stages/join`,
      {
        stage: "translate",
        creditName: "本作品译者署名",
        expectedRevision: typesetClaimed.data.revision,
        idempotencyKey: joinKey,
      },
    );
    assert.equal(replayedJoin.status, 200);
    assert.equal(replayedJoin.data.revision, joined.data.revision);
    const imageId = initial.data.images[0].id;
    const startedTranslation = await request<TranslationImageResponse>(
      translator.browser,
      "POST",
      `/api/work-images/${imageId}/markers`,
      {
        markerX: 0.5,
        markerY: 0.5,
        markerPositionType: "inside",
        expectedImageRevision: 0,
        expectedEditorEpoch: 0,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(startedTranslation.status, 201);
    assert.equal(
      startedTranslation.data.mutation?.workflowStatus,
      "translating",
    );
    const leftCurrentStage = await request<WorkResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/stages/leave`,
      {
        stage: "translate",
        expectedRevision: startedTranslation.data.mutation!.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(leftCurrentStage.status, 200);
    assert.equal(leftCurrentStage.data.workflowStatus, "pending_translate");
    joined = await request<WorkResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/stages/join`,
      {
        stage: "translate",
        expectedRevision: leftCurrentStage.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(joined.status, 200);
    assert.equal(joined.data.workflowStatus, "pending_translate");
    assert.equal(
      joined.data.participants.find(
        (participant) =>
          participant.userId === translator.user.id && !participant.leftAt,
      )?.workCreditName,
      null,
    );
    joined = await request<WorkResponse>(
      translator.browser,
      "PATCH",
      `/api/works/${workId}/stages/credit`,
      {
        stage: "translate",
        creditName: null,
        expectedRevision: joined.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(joined.status, 200);
    assert.equal(
      joined.data.participants.find(
        (participant) =>
          participant.userId === translator.user.id && !participant.leftAt,
      )?.workCreditName,
      null,
    );
    joined = await request<WorkResponse>(
      translator.browser,
      "PATCH",
      `/api/works/${workId}/stages/credit`,
      {
        stage: "translate",
        creditName: "本作品译者署名",
        expectedRevision: joined.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(joined.status, 200);
    assert.equal(
      joined.data.participants.find(
        (participant) =>
          participant.userId === translator.user.id && !participant.leftAt,
      )?.workCreditName,
      "本作品译者署名",
    );
    let activeEditorEpoch = joined.data.editorEpoch;
    assert.equal(activeEditorEpoch, 1);

    const readOnlyEditor = await request<TranslationEditorResponse>(
      reviewer.browser,
      "GET",
      `/api/works/${workId}/translations`,
    );
    assert.equal(readOnlyEditor.status, 200);
    assert.equal(readOnlyEditor.data.canEdit, false);
    assert.equal(readOnlyEditor.data.joinableStage, null);
    const adminEditor = await request<TranslationEditorResponse>(
      admin.browser,
      "GET",
      `/api/works/${workId}/translations`,
    );
    assert.equal(adminEditor.status, 200);
    assert.equal(adminEditor.data.canEdit, false);
    assert.equal(adminEditor.data.joinableStage, null);
    const initialImageRevision = adminEditor.data.images[0].translationRevision;
    assert.equal(initialImageRevision, 2);
    assert.equal(adminEditor.data.images[0].entries.length, 0);

    const translatingPresence = await request<TranslationPresenceResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/translations/presence`,
      { mode: "edit" },
    );
    assert.equal(translatingPresence.status, 200);
    assert.equal(translatingPresence.data.expiresInSeconds, 90);
    assert.deepEqual(
      translatingPresence.data.items.map(({ mode, isCurrentSession }) => ({
        mode,
        isCurrentSession,
      })),
      [{ mode: "edit", isCurrentSession: true }],
    );
    const viewingPresence = await request<TranslationPresenceResponse>(
      reviewer.browser,
      "POST",
      `/api/works/${workId}/translations/presence`,
      { mode: "view" },
    );
    assert.equal(viewingPresence.status, 200);
    assert.equal(viewingPresence.data.items.length, 2);
    assert.equal(
      viewingPresence.data.items.find(
        ({ userId }) => userId === translator.user.id,
      )?.mode,
      "edit",
    );
    assert.equal(
      viewingPresence.data.items.find(
        ({ userId }) => userId === reviewer.user.id,
      )?.isCurrentSession,
      true,
    );
    assert.equal(
      (
        await request(
          reviewer.browser,
          "POST",
          `/api/works/${workId}/translations/presence`,
          { mode: "edit" },
        )
      ).status,
      403,
    );
    const repeatedPresence = await request<TranslationPresenceResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/translations/presence`,
      { mode: "edit" },
    );
    assert.equal(
      repeatedPresence.data.items.filter(
        ({ userId }) => userId === translator.user.id,
      ).length,
      1,
    );
    const afterViewerLeft = await request<TranslationPresenceResponse>(
      reviewer.browser,
      "DELETE",
      `/api/works/${workId}/translations/presence`,
      {},
    );
    assert.equal(
      afterViewerLeft.status,
      200,
      JSON.stringify(afterViewerLeft.data),
    );
    assert.equal(afterViewerLeft.data.items.length, 1);
    assert.equal(
      (
        await request(
          reviewer.browser,
          "POST",
          `/api/work-images/${imageId}/markers`,
          {
            markerX: 0.2,
            markerY: 0.3,
            markerPositionType: "inside",
            expectedImageRevision: initialImageRevision,
            expectedEditorEpoch: activeEditorEpoch,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );

    const firstCreateKey = randomUUID();
    const firstImage = await request<TranslationImageResponse>(
      translator.browser,
      "POST",
      `/api/work-images/${imageId}/markers`,
      {
        markerX: 0.250000012345,
        markerY: 0.37500006789,
        markerPositionType: "inside",
        expectedImageRevision: initialImageRevision,
        expectedEditorEpoch: activeEditorEpoch,
        idempotencyKey: firstCreateKey,
      },
    );
    assert.equal(firstImage.status, 201);
    assert.equal(firstImage.data.translationRevision, initialImageRevision + 1);
    assert.equal(firstImage.data.entries[0].orderIndex, 0);
    assert.equal(firstImage.data.entries[0].markerX, 0.25);
    assert.equal(firstImage.data.entries[0].markerY, 0.375);
    const firstEntryId = firstImage.data.entries[0].id;
    const replayedCreate = await request<TranslationImageResponse>(
      translator.browser,
      "POST",
      `/api/work-images/${imageId}/markers`,
      {
        markerX: 0.25,
        markerY: 0.375,
        markerPositionType: "inside",
        expectedImageRevision: initialImageRevision,
        expectedEditorEpoch: activeEditorEpoch,
        idempotencyKey: firstCreateKey,
      },
    );
    assert.equal(replayedCreate.status, 201);
    assert.equal(
      replayedCreate.data.translationRevision,
      initialImageRevision + 1,
    );
    assert.equal(replayedCreate.data.entries.length, 1);
    assert.equal(
      (
        await request(
          translator.browser,
          "POST",
          `/api/work-images/${imageId}/markers`,
          {
            markerX: 0.4,
            markerY: 0.5,
            markerPositionType: "outside",
            expectedImageRevision: initialImageRevision,
            expectedEditorEpoch: activeEditorEpoch,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      409,
    );
    const concurrentCreates = await Promise.all([
      request<TranslationImageResponse>(
        translator.browser,
        "POST",
        `/api/work-images/${imageId}/markers`,
        {
          markerX: 0.4,
          markerY: 0.5,
          markerPositionType: "outside",
          expectedImageRevision: initialImageRevision + 1,
          expectedEditorEpoch: activeEditorEpoch,
          idempotencyKey: randomUUID(),
        },
      ),
      request<TranslationImageResponse>(
        translator.browser,
        "POST",
        `/api/work-images/${imageId}/markers`,
        {
          markerX: 0.6,
          markerY: 0.7,
          markerPositionType: "inside",
          expectedImageRevision: initialImageRevision + 1,
          expectedEditorEpoch: activeEditorEpoch,
          idempotencyKey: randomUUID(),
        },
      ),
    ]);
    assert.deepEqual(
      concurrentCreates.map(({ status }) => status).sort(),
      [201, 409],
    );
    const secondImage = concurrentCreates.find(({ status }) => status === 201);
    assert.ok(secondImage);
    assert.equal(secondImage.status, 201);
    assert.equal(
      secondImage.data.translationRevision,
      initialImageRevision + 2,
    );
    const secondEntryId = secondImage.data.entries[1].id;

    const concurrentSaves = await Promise.all([
      request<TranslationEntryResponse>(
        translator.browser,
        "PATCH",
        `/api/translation-entries/${firstEntryId}`,
        {
          expectedRevision: 0,
          expectedEditorEpoch: activeEditorEpoch,
          translatedText: "并发保存 A",
        },
      ),
      request<TranslationEntryResponse>(
        translator.browser,
        "PATCH",
        `/api/translation-entries/${firstEntryId}`,
        {
          expectedRevision: 0,
          expectedEditorEpoch: activeEditorEpoch,
          translatedText: "并发保存 B",
        },
      ),
    ]);
    assert.deepEqual(
      concurrentSaves.map(({ status }) => status).sort(),
      [200, 409],
    );
    const savedEntry = concurrentSaves.find(({ status }) => status === 200);
    assert.ok(savedEntry);
    assert.equal(savedEntry.status, 200);
    assert.equal(savedEntry.data.revision, 1);
    assert.ok(
      ["并发保存 A", "并发保存 B"].includes(
        savedEntry.data.translatedText ?? "",
      ),
    );

    const reordered = await request<TranslationImageResponse>(
      translator.browser,
      "POST",
      `/api/work-images/${imageId}/markers/${secondEntryId}/reorder`,
      {
        beforeMarkerId: firstEntryId,
        expectedImageRevision: initialImageRevision + 2,
        expectedEditorEpoch: activeEditorEpoch,
      },
    );
    assert.equal(reordered.status, 200);
    assert.equal(reordered.data.translationRevision, initialImageRevision + 3);
    assert.deepEqual(
      reordered.data.entries.map((entry) => entry.id),
      [secondEntryId, firstEntryId],
    );
    assert.deepEqual(
      reordered.data.entries.map((entry) => entry.orderIndex),
      [0, 1],
    );
    assert.equal(
      (
        await request(
          translator.browser,
          "POST",
          `/api/work-images/${imageId}/markers/${firstEntryId}/reorder`,
          {
            beforeMarkerId: secondEntryId,
            expectedImageRevision: initialImageRevision + 2,
            expectedEditorEpoch: activeEditorEpoch,
          },
        )
      ).status,
      409,
    );

    const afterDelete = await request<TranslationImageResponse>(
      translator.browser,
      "DELETE",
      `/api/translation-entries/${firstEntryId}`,
      {
        expectedRevision: 1,
        expectedImageRevision: initialImageRevision + 3,
        expectedEditorEpoch: activeEditorEpoch,
      },
    );
    assert.equal(afterDelete.status, 200);
    assert.equal(
      afterDelete.data.translationRevision,
      initialImageRevision + 4,
    );
    assert.equal(afterDelete.data.entries.length, 1);
    assert.equal(afterDelete.data.entries[0].id, secondEntryId);
    assert.equal(afterDelete.data.entries[0].orderIndex, 0);

    const editable = await request<TranslationEditorResponse>(
      translator.browser,
      "GET",
      `/api/works/${workId}/translations`,
    );
    assert.equal(editable.data.canEdit, true);
    assert.equal(
      editable.data.images[0].translationRevision,
      initialImageRevision + 4,
    );
    assert.equal(
      (
        await request(
          translator.browser,
          "POST",
          `/api/works/${workId}/stages/submit`,
          {
            stage: "translate",
            expectedRevision: joined.data.revision,
            expectedEditorEpoch: activeEditorEpoch,
            idempotencyKey: joinKey,
          },
        )
      ).status,
      409,
    );

    const opened = await request<{
      id: string;
      status: string;
      workRevision: number;
    }>(proofreader.browser, "POST", `/api/works/${workId}/reviews`, {
      reason: "需要确认原文语气",
      expectedRevision: firstImage.data.mutation!.workRevision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.data.status, "open");
    assert.equal(
      opened.data.workRevision,
      firstImage.data.mutation!.workRevision + 1,
    );
    let current = (
      await request<WorkResponse>(
        translator.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.equal(current.workflowStatus, "translating");
    assert.equal(current.reviewStatus, "needs_review");
    assert.equal(
      (
        await request(
          translator.browser,
          "POST",
          `/api/works/${workId}/stages/submit`,
          {
            stage: "translate",
            expectedRevision: current.revision,
            expectedEditorEpoch: activeEditorEpoch,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          proofreader.browser,
          "POST",
          `/api/reviews/${opened.data.id}/resolve`,
          {
            resolution: "resume",
            expectedRevision: current.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );
    const blocked = await request<{ status: string; resolution: string }>(
      reviewer.browser,
      "POST",
      `/api/reviews/${opened.data.id}/resolve`,
      {
        resolution: "block",
        note: "等待作者确认授权范围",
        expectedRevision: opened.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(blocked.status, 403);
    current = (
      await request<WorkResponse>(
        translator.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.equal(current.reviewStatus, "needs_review");

    const resumeKey = randomUUID();
    const resumed = await request<{ status: string; resolution: string }>(
      admin.browser,
      "POST",
      `/api/reviews/${opened.data.id}/resolve`,
      {
        resolution: "continue_production",
        expectedRevision: current.revision,
        idempotencyKey: resumeKey,
      },
    );
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.status, "resolved");
    assert.equal(resumed.data.resolution, "continue_production");
    activeEditorEpoch += 2;
    current = (
      await request<WorkResponse>(
        translator.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.equal(current.reviewStatus, "normal");
    const submitted = await request<WorkResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "translate",
        expectedRevision: current.revision,
        expectedEditorEpoch: activeEditorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.workflowStatus, "pending_proofread");
    assert.ok(submitted.data.assignedStages.includes("translate"));
    const translatedIsNotUnassigned = await request<{
      items: { id: string }[];
    }>(
      translator.browser,
      "GET",
      "/api/works?unassignedStage=translate&limit=100",
    );
    assert.equal(
      translatedIsNotUnassigned.data.items.some((item) => item.id === workId),
      false,
    );
    assert.equal(submitted.data.editorEpoch, activeEditorEpoch + 1);
    assert.equal(
      submitted.data.participants.find(
        (participant) =>
          participant.userId === translator.user.id && participant.submittedAt,
      )?.creditNameSnapshot,
      "本作品译者署名",
    );
    const submittedEditor = await request<TranslationEditorResponse>(
      translator.browser,
      "GET",
      `/api/works/${workId}/translations`,
    );
    assert.equal(submittedEditor.data.editorEpoch, submitted.data.editorEpoch);
    assert.equal(submittedEditor.data.latestVersion?.versionNumber, 1);
    assert.equal(
      submittedEditor.data.latestVersion?.editorEpoch,
      submitted.data.editorEpoch,
    );
    assert.equal(
      submittedEditor.data.latestVersion?.kind,
      "translate_submission",
    );
    assert.equal(
      (
        await request(
          translator.browser,
          "PATCH",
          `/api/translation-entries/${secondEntryId}`,
          {
            expectedRevision: 0,
            expectedEditorEpoch: activeEditorEpoch,
            translatedText: "过期设备内容",
          },
        )
      ).status,
      409,
    );
    const storedVersion = await db.translationVersion.findFirstOrThrow({
      where: { workId },
      include: { entries: true },
    });
    assert.equal(storedVersion.editorEpoch, submitted.data.editorEpoch);
    assert.equal(storedVersion.entries.length, 1);
    assert.equal(storedVersion.entries[0].sourceEntryId, secondEntryId);

    const postSubmitDraft = await request<TranslationEntryResponse>(
      translator.browser,
      "PATCH",
      `/api/translation-entries/${secondEntryId}`,
      {
        expectedRevision: 0,
        expectedEditorEpoch: submitted.data.editorEpoch,
        translatedText: "提交后的翻译修订",
      },
    );
    assert.equal(postSubmitDraft.status, 403);
    const revisionDraft = await request<TranslationEditorResponse>(
      translator.browser,
      "GET",
      `/api/works/${workId}/translations`,
    );
    assert.equal(revisionDraft.data.canEdit, false);
    assert.deepEqual(revisionDraft.data.editStages, []);
    assert.equal(revisionDraft.data.submissionStage, null);
    assert.equal(revisionDraft.data.cancelableSubmissionStage, "translate");
    assert.equal(revisionDraft.data.hasUnsubmittedChanges, false);
    assert.deepEqual(revisionDraft.data.revisionStages, []);
    assert.equal(
      (
        await request<TranslationEditorResponse>(
          translator.browser,
          "POST",
          `/api/works/${workId}/translations/revisions/submit`,
          {
            stage: "translate",
            expectedRevision: submitted.data.revision,
            expectedEditorEpoch: submitted.data.editorEpoch,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      404,
    );
    const versions = await db.translationVersion.findMany({
      where: { workId },
      orderBy: { versionNumber: "asc" },
      include: { entries: true },
    });
    assert.equal(versions.length, 1);
    assert.equal(versions[0].entries[0].translatedText, "");

    const cancelledTranslation = await request<WorkResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/stages/submission/cancel`,
      {
        stage: "translate",
        expectedRevision: submitted.data.revision,
        expectedEditorEpoch: submitted.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(cancelledTranslation.status, 200);
    assert.equal(cancelledTranslation.data.workflowStatus, "translating");
    const translatedRevision = await request<TranslationEntryResponse>(
      translator.browser,
      "PATCH",
      `/api/translation-entries/${secondEntryId}`,
      {
        expectedRevision: 0,
        expectedEditorEpoch: cancelledTranslation.data.editorEpoch,
        translatedText: "取消提交后的翻译修订",
      },
    );
    assert.equal(translatedRevision.status, 200);
    const resubmittedTranslation = await request<WorkResponse>(
      translator.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "translate",
        expectedRevision: cancelledTranslation.data.revision,
        expectedEditorEpoch: cancelledTranslation.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(resubmittedTranslation.status, 200);

    const proofJoined = await request<WorkResponse>(
      proofreader.browser,
      "POST",
      `/api/works/${workId}/stages/join`,
      {
        stage: "proofread",
        expectedRevision: resubmittedTranslation.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(proofJoined.status, 200);
    assert.equal(proofJoined.data.workflowStatus, "pending_proofread");
    assert.equal(
      proofJoined.data.editorEpoch,
      resubmittedTranslation.data.editorEpoch,
    );
    const proofreadStarted = await request<TranslationEntryResponse>(
      proofreader.browser,
      "PATCH",
      `/api/translation-entries/${secondEntryId}`,
      {
        expectedRevision: translatedRevision.data.revision,
        expectedEditorEpoch: proofJoined.data.editorEpoch,
        translatedText: "校对首次修改",
      },
    );
    assert.equal(proofreadStarted.status, 200);
    assert.equal(
      proofreadStarted.data.mutation?.workflowStatus,
      "proofreading",
    );
    const frozenVersions = await db.translationVersion.findMany({
      where: { workId },
      orderBy: { versionNumber: "asc" },
      include: { entries: true },
    });
    assert.equal(frozenVersions.length, 2);
    assert.equal(frozenVersions[0].stage, "translate");
    assert.equal(frozenVersions[0].entries[0].translatedText, "");
    assert.equal(frozenVersions[1].stage, "translate");
    assert.equal(frozenVersions[1].kind, "revision");
    assert.equal(
      frozenVersions[1].entries[0].translatedText,
      "取消提交后的翻译修订",
    );
    assert.equal(
      (
        await request(
          translator.browser,
          "PATCH",
          `/api/translation-entries/${secondEntryId}`,
          {
            expectedRevision: translatedRevision.data.revision,
            expectedEditorEpoch: proofJoined.data.editorEpoch,
            translatedText: "校对开始后的过期翻译修改",
          },
        )
      ).status,
      409,
    );
    const proofSubmitted = await request<WorkResponse>(
      proofreader.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "proofread",
        expectedRevision: proofreadStarted.data.mutation!.workRevision,
        expectedEditorEpoch: proofreadStarted.data.mutation!.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(proofSubmitted.status, 200);
    assert.equal(proofSubmitted.data.workflowStatus, "pending_typeset");
    assert.equal(
      proofSubmitted.data.participants.find(
        (participant) =>
          participant.userId === proofreader.user.id && participant.submittedAt,
      )?.creditNameSnapshot,
      proofreader.user.displayName,
    );
    assert.equal(proofSubmitted.data.translationAttentionStage, null);
    assert.equal(proofSubmitted.data.translationAttentionVersionNumber, null);
    const completedVersions = await db.translationVersion.findMany({
      where: { workId },
      orderBy: { versionNumber: "asc" },
      include: { entries: true },
    });
    assert.equal(completedVersions.length, 3);
    assert.equal(completedVersions[1].stage, "translate");
    assert.equal(completedVersions[2].stage, "proofread");
    assert.equal(completedVersions[2].kind, "proofread_submission");
    assert.equal(
      completedVersions[2].entries[0].translatedText,
      "校对首次修改",
    );
    assert.equal(proofSubmitted.data.typesetHandoffStartedAt, null);
    const proofreadingGraceEdit = await request<TranslationEntryResponse>(
      proofreader.browser,
      "PATCH",
      `/api/translation-entries/${secondEntryId}`,
      {
        expectedRevision: proofreadStarted.data.revision,
        expectedEditorEpoch: proofSubmitted.data.editorEpoch,
        translatedText: "校对提交后的最终修正",
      },
    );
    assert.equal(proofreadingGraceEdit.status, 403);
    const proofreadingGraceEditor = await request<TranslationEditorResponse>(
      proofreader.browser,
      "GET",
      `/api/works/${workId}/translations`,
    );
    assert.equal(proofreadingGraceEditor.data.canEdit, false);
    assert.deepEqual(proofreadingGraceEditor.data.editStages, []);
    assert.equal(proofreadingGraceEditor.data.submissionStage, null);
    assert.equal(
      proofreadingGraceEditor.data.cancelableSubmissionStage,
      "proofread",
    );
    const cancelledProofread = await request<WorkResponse>(
      proofreader.browser,
      "POST",
      `/api/works/${workId}/stages/submission/cancel`,
      {
        stage: "proofread",
        expectedRevision: proofSubmitted.data.revision,
        expectedEditorEpoch: proofSubmitted.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(cancelledProofread.status, 200);
    assert.equal(cancelledProofread.data.workflowStatus, "proofreading");
    const correctedProofread = await request<TranslationEntryResponse>(
      proofreader.browser,
      "PATCH",
      `/api/translation-entries/${secondEntryId}`,
      {
        expectedRevision: proofreadStarted.data.revision,
        expectedEditorEpoch: cancelledProofread.data.editorEpoch,
        translatedText: "取消提交后的校对修正",
      },
    );
    assert.equal(correctedProofread.status, 200);
    const resubmittedProofread = await request<WorkResponse>(
      proofreader.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "proofread",
        expectedRevision: cancelledProofread.data.revision,
        expectedEditorEpoch: cancelledProofread.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(resubmittedProofread.status, 200);
    const typesetStarted = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/join`,
      {
        stage: "typeset",
        expectedRevision: resubmittedProofread.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(typesetStarted.status, 200);
    assert.equal(typesetStarted.data.workflowStatus, "pending_typeset");
    const manifest = await request<{
      items: { workId: string; canDownload: boolean }[];
    }>(typesetter.browser, "GET", "/api/typeset/handoff-manifest");
    assert.equal(manifest.status, 200);
    assert.ok(
      manifest.data.items.some(
        (item) => item.workId === workId && item.canDownload,
      ),
    );
    assert.equal(
      (await db.work.findUniqueOrThrow({ where: { id: workId } }))
        .typesetHandoffStartedAt,
      null,
    );
    const forbiddenBatch = await request(
      reviewer.browser,
      "POST",
      `/api/typeset/handoff-items/${workId}`,
      {
        expectedRevision: typesetStarted.data.revision,
        expectedEditorEpoch: resubmittedProofread.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(forbiddenBatch.status, 403);
    const handoffPackageKey = randomUUID();
    const handoffPackage = await request<{
      packageId: string;
      fileName: string;
      downloadUrl: string;
      imageCount: number;
      markerCount: number;
    }>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/handoff-packages`,
      {
        expectedRevision: typesetStarted.data.revision,
        expectedEditorEpoch: resubmittedProofread.data.editorEpoch,
        idempotencyKey: handoffPackageKey,
      },
    );
    assert.equal(handoffPackage.status, 200);
    assert.equal(handoffPackage.data.imageCount, 1);
    assert.equal(handoffPackage.data.markerCount, 1);
    assert.equal(
      handoffPackage.data.fileName,
      `${work.workNumber}_嵌字交接.zip`,
    );
    const inspectionDownload = await fetch(
      base + handoffPackage.data.downloadUrl,
      {
        headers: reviewer.browser.cookie
          ? { Cookie: reviewer.browser.cookie }
          : undefined,
      },
    );
    assert.equal(inspectionDownload.status, 200);
    await inspectionDownload.arrayBuffer();
    assert.equal(
      (
        await request<WorkResponse>(
          reviewer.browser,
          "GET",
          `/api/works/${workId}`,
        )
      ).data.typesetHandoffStartedAt,
      null,
    );
    const handoffDownload = await fetch(
      `${base}/api/typeset/handoff-items/${workId}/${handoffPackage.data.packageId}/download`,
      {
        method: "POST",
        headers: {
          Cookie: typesetter.browser.cookie!,
          "Content-Type": "application/json",
          "X-Comiku-Request": "1",
          Origin: "http://localhost:5173",
        },
        body: JSON.stringify({
          expectedRevision: typesetStarted.data.revision,
          expectedEditorEpoch: resubmittedProofread.data.editorEpoch,
          idempotencyKey: handoffPackageKey,
        }),
      },
    );
    assert.equal(handoffDownload.status, 200);
    const staleBatch = await request(
      typesetter.browser,
      "POST",
      `/api/typeset/handoff-items/${workId}`,
      {
        expectedRevision: typesetStarted.data.revision,
        expectedEditorEpoch: resubmittedProofread.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(staleBatch.status, 409);
    assert.equal(
      handoffDownload.headers.get("content-type"),
      "application/zip",
    );
    const handoffArchive = unzipSync(
      new Uint8Array(await handoffDownload.arrayBuffer()),
    );
    assert.deepEqual(Object.keys(handoffArchive), [
      `${work.workNumber}-001.png`,
      `${work.workNumber}_翻译.txt`,
    ]);
    assert.equal(
      new TextDecoder().decode(handoffArchive[`${work.workNumber}-001.png`]),
      "workflow image",
    );
    assert.match(
      new TextDecoder().decode(handoffArchive[`${work.workNumber}_翻译.txt`]),
      /取消提交后的校对修正/,
    );
    const afterTypesetHandoff = (
      await request<WorkResponse>(
        proofreader.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.ok(afterTypesetHandoff.typesetHandoffStartedAt);
    assert.equal(
      afterTypesetHandoff.editorEpoch,
      resubmittedProofread.data.editorEpoch + 1,
    );
    assert.equal(
      (
        await request(
          proofreader.browser,
          "PATCH",
          `/api/translation-entries/${secondEntryId}`,
          {
            expectedRevision: correctedProofread.data.revision,
            expectedEditorEpoch: resubmittedProofread.data.editorEpoch,
            translatedText: "交接后的过期校对修改",
          },
        )
      ).status,
      409,
    );
    const handoffVersions = await db.translationVersion.findMany({
      where: { workId },
      orderBy: { versionNumber: "asc" },
      include: { entries: true },
    });
    assert.equal(handoffVersions.length, 4);
    assert.equal(handoffVersions[3].stage, "proofread");
    assert.equal(handoffVersions[3].kind, "revision");
    assert.equal(
      handoffVersions[3].entries[0].translatedText,
      "取消提交后的校对修正",
    );
    assert.equal(
      (
        await request(
          proofreader.browser,
          "POST",
          `/api/works/${workId}/stages/submission/cancel`,
          {
            stage: "proofread",
            expectedRevision: afterTypesetHandoff.revision,
            expectedEditorEpoch: afterTypesetHandoff.editorEpoch,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      409,
    );
    const replayedHandoffPackage = await request<{ packageId: string }>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/handoff-packages`,
      {
        expectedRevision: typesetStarted.data.revision,
        expectedEditorEpoch: resubmittedProofread.data.editorEpoch,
        idempotencyKey: handoffPackageKey,
      },
    );
    assert.equal(replayedHandoffPackage.status, 200);
    assert.equal(
      replayedHandoffPackage.data.packageId,
      handoffPackage.data.packageId,
    );
    const repeatedHandoffPackage = await request<{
      packageId: string;
      downloadUrl: string;
    }>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/handoff-packages`,
      {
        expectedRevision: afterTypesetHandoff.revision,
        expectedEditorEpoch: afterTypesetHandoff.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(repeatedHandoffPackage.status, 200);
    assert.equal(
      (
        await fetch(base + repeatedHandoffPackage.data.downloadUrl, {
          headers: typesetter.browser.cookie
            ? { Cookie: typesetter.browser.cookie }
            : undefined,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request<WorkResponse>(
          typesetter.browser,
          "GET",
          `/api/works/${workId}`,
        )
      ).data.editorEpoch,
      afterTypesetHandoff.editorEpoch,
    );
    const leftAfterTypesetHandoff = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/leave`,
      {
        stage: "typeset",
        expectedRevision: afterTypesetHandoff.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(leftAfterTypesetHandoff.status, 200);
    assert.equal(
      leftAfterTypesetHandoff.data.workflowStatus,
      "pending_typeset",
    );
    assert.equal(leftAfterTypesetHandoff.data.typesetHandoffStartedAt, null);
    await db.work.update({
      where: { id: workId },
      data: { typesetHandoffStartedAt: new Date() },
    });
    const rejoinedAfterTypesetHandoff = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/join`,
      {
        stage: "typeset",
        expectedRevision: leftAfterTypesetHandoff.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(rejoinedAfterTypesetHandoff.status, 200);
    const resumedHandoffPackage = await request<{
      downloadUrl: string;
    }>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/handoff-packages`,
      {
        expectedRevision: rejoinedAfterTypesetHandoff.data.revision,
        expectedEditorEpoch: rejoinedAfterTypesetHandoff.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(resumedHandoffPackage.status, 200);
    assert.equal(
      (
        await fetch(base + resumedHandoffPackage.data.downloadUrl, {
          headers: typesetter.browser.cookie
            ? { Cookie: typesetter.browser.cookie }
            : undefined,
        })
      ).status,
      200,
    );
    const resumedTypesetHandoff = (
      await request<WorkResponse>(
        typesetter.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.equal(resumedTypesetHandoff.workflowStatus, "typesetting");
    assert.ok(resumedTypesetHandoff.typesetHandoffStartedAt);
    assert.equal(
      resumedTypesetHandoff.editorEpoch,
      afterTypesetHandoff.editorEpoch + 1,
    );
    type TypesetVersionListResponse = {
      items: {
        id: string;
        versionNumber: number;
        isCurrent: boolean;
        deletedAt: string | null;
        purgeAfter: string | null;
        images: {
          id: string;
          sourceName: string;
          workImageId: string | null;
        }[];
      }[];
      currentVersionId: string | null;
      workRevision: number;
    };
    const typesetWithoutImages = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "typeset",
        expectedRevision: resumedTypesetHandoff.revision,
        expectedEditorEpoch: resumedTypesetHandoff.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(typesetWithoutImages.status, 409);
    const firstTypesetVersion =
      await multipartRequest<TypesetVersionListResponse>(
        typesetter.browser,
        `/api/works/${workId}/typeset/versions`,
        {
          expectedRevision: String(resumedTypesetHandoff.revision),
          idempotencyKey: randomUUID(),
          mode: "new_version",
          note: "首次成图",
          sourceImageIds: JSON.stringify([originalWorkImage.id, null]),
        },
        [
          {
            name: "result-01.png",
            body: png(1600, 1120),
            type: "image/png",
          },
          {
            name: "result-02.png",
            body: png(900, 600),
            type: "image/png",
          },
        ],
      );
    assert.equal(firstTypesetVersion.status, 201);
    assert.equal(firstTypesetVersion.data.items.length, 1);
    assert.equal(firstTypesetVersion.data.items[0].isCurrent, true);
    assert.equal(firstTypesetVersion.data.items[0].versionNumber, 1);
    assert.equal(firstTypesetVersion.data.items[0].images.length, 2);
    assert.equal(
      firstTypesetVersion.data.items[0].images[0].workImageId,
      originalWorkImage.id,
    );
    assert.equal(firstTypesetVersion.data.items[0].images[1].workImageId, null);
    const firstVersionId = firstTypesetVersion.data.items[0].id;
    const firstVersionImageId = firstTypesetVersion.data.items[0].images[0].id;
    assert.match(
      (
        await request<{ url: string }>(
          typesetter.browser,
          "GET",
          `/api/works/${workId}/typeset/versions/${firstVersionId}/images/${firstVersionImageId}/url`,
        )
      ).data.url,
      /^memory:/,
    );
    const replacedTypesetVersion =
      await multipartRequest<TypesetVersionListResponse>(
        typesetter.browser,
        `/api/works/${workId}/typeset/versions`,
        {
          expectedRevision: String(firstTypesetVersion.data.workRevision),
          idempotencyKey: randomUUID(),
          mode: "replace_current",
          note: "修正版",
        },
        [
          {
            name: "result-01.png",
            body: png(1000, 700),
            type: "image/png",
          },
        ],
      );
    assert.equal(replacedTypesetVersion.status, 201);
    assert.equal(replacedTypesetVersion.data.items.length, 2);
    const replacedFirst = replacedTypesetVersion.data.items.find(
      (version) => version.id === firstVersionId,
    );
    const secondVersion = replacedTypesetVersion.data.items.find(
      (version) => version.id !== firstVersionId,
    );
    assert.ok(replacedFirst?.deletedAt);
    assert.ok(replacedFirst?.purgeAfter);
    assert.ok(secondVersion?.isCurrent);
    const restoredTypesetVersion = await request<TypesetVersionListResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/versions/${firstVersionId}/restore`,
      {
        expectedRevision: replacedTypesetVersion.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(restoredTypesetVersion.status, 200);
    assert.equal(
      restoredTypesetVersion.data.items.find(
        (version) => version.id === firstVersionId,
      )?.deletedAt,
      null,
    );
    const selectedTypesetVersion = await request<TypesetVersionListResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/versions/${firstVersionId}/select`,
      {
        expectedRevision: restoredTypesetVersion.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(selectedTypesetVersion.status, 200);
    assert.equal(selectedTypesetVersion.data.currentVersionId, firstVersionId);
    const deletedTypesetVersion = await request<TypesetVersionListResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/versions/${secondVersion?.id}/delete`,
      {
        expectedRevision: selectedTypesetVersion.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(deletedTypesetVersion.status, 200);
    assert.ok(
      deletedTypesetVersion.data.items.find(
        (version) => version.id === secondVersion?.id,
      )?.deletedAt,
    );
    let typesetSubmitted = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "typeset",
        expectedRevision: deletedTypesetVersion.data.workRevision,
        expectedEditorEpoch: resumedTypesetHandoff.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(typesetSubmitted.status, 200);
    assert.equal(typesetSubmitted.data.workflowStatus, "pending_publish");
    const originalTypesetterParticipation =
      typesetSubmitted.data.participants.find(
        (participant) =>
          participant.userId === typesetter.user.id && participant.submittedAt,
      );
    assert.ok(originalTypesetterParticipation?.submittedAt);
    const cannotDeleteSubmittedVersion = await request(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/versions/${firstVersionId}/delete`,
      {
        expectedRevision: typesetSubmitted.data.revision,
        idempotencyKey: randomUUID(),
        clearCurrent: true,
      },
    );
    assert.equal(cannotDeleteSubmittedVersion.status, 409);
    const cancelledTypeset = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submission/cancel`,
      {
        stage: "typeset",
        expectedRevision: typesetSubmitted.data.revision,
        expectedEditorEpoch: typesetSubmitted.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(cancelledTypeset.status, 200);
    assert.equal(cancelledTypeset.data.workflowStatus, "typesetting");
    assert.equal(
      cancelledTypeset.data.participants.find(
        (participant) => participant.id === originalTypesetterParticipation.id,
      )?.submittedAt,
      null,
    );
    const deletedCurrentVersion = await request<TypesetVersionListResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/versions/${firstVersionId}/delete`,
      {
        expectedRevision: cancelledTypeset.data.revision,
        idempotencyKey: randomUUID(),
        clearCurrent: true,
      },
    );
    assert.equal(deletedCurrentVersion.status, 200);
    assert.equal(deletedCurrentVersion.data.currentVersionId, null);
    assert.equal(
      (
        await request<WorkResponse>(
          typesetter.browser,
          "GET",
          `/api/works/${workId}`,
        )
      ).data.workflowStatus,
      "typesetting",
    );
    const restoredCurrentVersion = await request<TypesetVersionListResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/versions/${firstVersionId}/restore`,
      {
        expectedRevision: deletedCurrentVersion.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(restoredCurrentVersion.status, 200);
    assert.equal(restoredCurrentVersion.data.currentVersionId, null);
    const reselectedCurrentVersion = await request<TypesetVersionListResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/versions/${firstVersionId}/select`,
      {
        expectedRevision: restoredCurrentVersion.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(reselectedCurrentVersion.status, 200);
    typesetSubmitted = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "typeset",
        expectedRevision: reselectedCurrentVersion.data.workRevision,
        expectedEditorEpoch: cancelledTypeset.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(typesetSubmitted.status, 200);
    assert.equal(typesetSubmitted.data.workflowStatus, "pending_publish");
    assert.equal(
      typesetSubmitted.data.participants.filter(
        (participant) => participant.id === originalTypesetterParticipation.id,
      ).length,
      1,
    );
    type PublishingViewResponse = {
      workRevision: number;
      workflowStatus: string;
      body: string | null;
      generatedText: string;
      authorCredit: string;
      currentTypesetVersionId: string;
      currentTypesetVersionNumber: number;
      translationCredits: string[];
      proofreadCredits: string[];
      typesetCredits: string[];
      records: {
        id: string;
        typesetVersionId: string;
        generatedText: string;
      }[];
    };
    const typesetReview = await request<{
      id: string;
      workRevision: number;
      openedTypesetVersionId: string | null;
      openedTypesetVersionNumber: number | null;
    }>(operator.browser, "POST", `/api/works/${workId}/reviews`, {
      reason: "成图气泡位置需要调整",
      expectedRevision: typesetSubmitted.data.revision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(typesetReview.status, 200);
    assert.equal(typesetReview.data.openedTypesetVersionId, firstVersionId);
    assert.equal(typesetReview.data.openedTypesetVersionNumber, 1);
    const reviewBlocksPublishing = await request<PublishingViewResponse>(
      operator.browser,
      "POST",
      `/api/works/${workId}/publishing/confirm`,
      {
        expectedRevision: typesetReview.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(reviewBlocksPublishing.status, 409);
    const publishIsNotAReworkTarget = await request(
      admin.browser,
      "POST",
      `/api/reviews/${typesetReview.data.id}/resolve`,
      {
        resolution: "revise",
        targetWorkflowStatus: "pending_publish",
        note: "无实际编辑阶段",
        expectedRevision: typesetReview.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(publishIsNotAReworkTarget.status, 400);
    const typesetContinue = await request<{
      workRevision: number;
      editorEpoch: number;
    }>(admin.browser, "POST", `/api/reviews/${typesetReview.data.id}/resolve`, {
      resolution: "continue_production",
      expectedRevision: typesetReview.data.workRevision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(typesetContinue.status, 200);
    const rejoinedTypesetter = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submission/cancel`,
      {
        stage: "typeset",
        expectedEditorEpoch: typesetContinue.data.editorEpoch,
        expectedRevision: typesetContinue.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(rejoinedTypesetter.status, 200);
    assert.equal(rejoinedTypesetter.data.workflowStatus, "typesetting");
    const reworkSourcePackage = await request<{
      packageId: string;
      downloadUrl: string;
    }>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/handoff-packages`,
      {
        expectedRevision: rejoinedTypesetter.data.revision,
        expectedEditorEpoch: rejoinedTypesetter.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(reworkSourcePackage.status, 200);
    assert.equal(
      (
        await fetch(base + reworkSourcePackage.data.downloadUrl, {
          headers: typesetter.browser.cookie
            ? { Cookie: typesetter.browser.cookie }
            : undefined,
        })
      ).status,
      200,
    );
    const reworkTypesetHead = (
      await request<WorkResponse>(
        typesetter.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.equal(reworkTypesetHead.workflowStatus, "typesetting");
    assert.equal(
      (
        await request(
          typesetter.browser,
          "POST",
          `/api/works/${workId}/typeset/versions/${firstVersionId}/delete`,
          {
            expectedRevision: reworkTypesetHead.revision,
            idempotencyKey: randomUUID(),
            clearCurrent: true,
          },
        )
      ).status,
      409,
    );
    // Continuing a production decision preserves the current content baseline.
    // Actual text revision and stale rendered baselines are covered separately.
    const correctedTypesetVersion =
      await multipartRequest<TypesetVersionListResponse>(
        typesetter.browser,
        `/api/works/${workId}/typeset/versions`,
        {
          expectedRevision: String(reworkTypesetHead.revision),
          idempotencyKey: randomUUID(),
          mode: "new_version",
          note: "审核返工修正版",
        },
        [
          {
            name: "result-01.png",
            body: png(1000, 700),
            type: "image/png",
          },
          {
            name: "result-02.png",
            body: png(1200, 800),
            type: "image/png",
          },
        ],
      );
    assert.equal(correctedTypesetVersion.status, 201);
    assert.equal(correctedTypesetVersion.data.items[0].versionNumber, 3);
    const correctedVersionId = correctedTypesetVersion.data.items[0].id;
    const reviewedTypesetSubmitted = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "typeset",
        expectedRevision: correctedTypesetVersion.data.workRevision,
        expectedEditorEpoch: reworkTypesetHead.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(reviewedTypesetSubmitted.status, 200);
    assert.equal(
      reviewedTypesetSubmitted.data.workflowStatus,
      "pending_publish",
    );
    const cannotRestoreReviewedCurrent =
      await request<TypesetVersionListResponse>(
        typesetter.browser,
        "POST",
        `/api/works/${workId}/typeset/versions/${firstVersionId}/select`,
        {
          expectedRevision: reviewedTypesetSubmitted.data.revision,
          idempotencyKey: randomUUID(),
        },
      );
    assert.equal(cannotRestoreReviewedCurrent.status, 409);
    assert.equal(
      (
        await request(
          translator.browser,
          "GET",
          `/api/works/${workId}/publishing`,
        )
      ).status,
      403,
    );
    await db.work.update({ where: { id: workId }, data: { title: null } });
    const untitledPublishing = await request<{ message: string }>(
      operator.browser,
      "GET",
      `/api/works/${workId}/publishing`,
    );
    assert.equal(untitledPublishing.status, 409);
    assert.match(untitledPublishing.data.message, /填写作品标题/);
    await db.work.update({
      where: { id: workId },
      data: { title: "流程测试作品", sourceText: "原帖参考配文 · 三图示例" },
    });
    const latestTranslationCredit = await request<WorkResponse>(
      translator.browser,
      "PATCH",
      `/api/works/${workId}/stages/credit`,
      {
        stage: "translate",
        creditName: "发布前新署名",
        expectedRevision: reviewedTypesetSubmitted.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(latestTranslationCredit.status, 200);
    let publishingView = await request<PublishingViewResponse>(
      operator.browser,
      "GET",
      `/api/works/${workId}/publishing`,
    );
    assert.equal(publishingView.status, 200);
    assert.equal(publishingView.data.authorCredit, "@_workflow_author_");
    assert.equal(
      publishingView.data.currentTypesetVersionId,
      correctedVersionId,
    );
    assert.equal(publishingView.data.currentTypesetVersionNumber, 3);
    assert.deepEqual(publishingView.data.translationCredits, ["发布前新署名"]);
    assert.deepEqual(publishingView.data.proofreadCredits, ["proofreader"]);
    assert.deepEqual(publishingView.data.typesetCredits, ["typesetter"]);
    assert.match(publishingView.data.generatedText, /^\*\*流程测试作品\*\*/);
    assert.equal(publishingView.data.body, null);
    assert.ok(!publishingView.data.generatedText.includes("原帖参考配文"));
    assert.match(
      publishingView.data.generatedText,
      /^\*\*流程测试作品\*\*\n作者：/,
    );
    assert.match(
      publishingView.data.generatedText,
      /作者：@_workflow_author_[\s\S]*翻译：发布前新署名[\s\S]*校对：proofreader[\s\S]*嵌字：typesetter/,
    );
    assert.equal(
      (
        await request(translator.browser, "PATCH", `/api/works/${workId}`, {
          publicationBody: "没有运营权限",
          expectedRevision: publishingView.data.workRevision,
          idempotencyKey: randomUUID(),
        })
      ).status,
      403,
    );
    const staleBodyRevision = publishingView.data.workRevision;
    for (const body of ["  发布正文\n第二行  ", "   ", "确认发布正文"]) {
      const savedBody = await request<WorkResponse>(
        operator.browser,
        "PATCH",
        `/api/works/${workId}`,
        {
          publicationBody: body,
          expectedRevision: publishingView.data.workRevision,
          idempotencyKey: randomUUID(),
        },
      );
      assert.equal(savedBody.status, 200);
      publishingView = await request<PublishingViewResponse>(
        operator.browser,
        "GET",
        `/api/works/${workId}/publishing`,
      );
      assert.equal(publishingView.data.body, body.trim() || null);
      assert.equal(publishingView.data.workRevision, savedBody.data.revision);
      assert.ok(
        publishingView.data.generatedText.startsWith(
          `**流程测试作品**\n${body.trim() ? `${body.trim()}\n` : ""}作者：`,
        ),
      );
      assert.ok(!publishingView.data.generatedText.includes("原帖参考配文"));
    }
    assert.equal(
      (
        await request(operator.browser, "PATCH", `/api/works/${workId}`, {
          publicationBody: "过期的正文保存",
          expectedRevision: staleBodyRevision,
          idempotencyKey: randomUUID(),
        })
      ).status,
      409,
    );
    const publishingDownload = await fetch(
      base + `/api/works/${workId}/publishing/images`,
      {
        headers: operator.browser.cookie
          ? { Cookie: operator.browser.cookie }
          : undefined,
      },
    );
    assert.equal(publishingDownload.status, 200);
    assert.equal(
      publishingDownload.headers.get("content-type"),
      "application/zip",
    );
    assert.deepEqual(
      Object.keys(
        unzipSync(new Uint8Array(await publishingDownload.arrayBuffer())),
      ),
      [`${work.workNumber}-001成图.png`, `${work.workNumber}-002成图.png`],
    );
    const publishKey = randomUUID();
    const published = await request<PublishingViewResponse>(
      operator.browser,
      "POST",
      `/api/works/${workId}/publishing/confirm`,
      {
        expectedRevision: publishingView.data.workRevision,
        idempotencyKey: publishKey,
        note: "集成测试发布",
      },
    );
    assert.equal(published.status, 200);
    assert.equal(published.data.workflowStatus, "published");
    assert.equal(published.data.records.length, 1);
    assert.deepEqual(published.data.translationCredits, ["发布前新署名"]);
    assert.equal(
      (
        await request(operator.browser, "PATCH", `/api/works/${workId}`, {
          publicationBody: "发布后试图更改正文",
          expectedRevision: published.data.workRevision,
          idempotencyKey: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          typesetter.browser,
          "POST",
          `/api/works/${workId}/typeset/versions/${correctedVersionId}/delete`,
          {
            expectedRevision: published.data.workRevision,
            idempotencyKey: randomUUID(),
            clearCurrent: true,
          },
        )
      ).status,
      409,
    );
    await db.user.update({
      where: { id: proofreader.user.id },
      data: { displayName: "发布后改名" },
    });
    const frozenPublishingView = await request<PublishingViewResponse>(
      operator.browser,
      "GET",
      `/api/works/${workId}/publishing`,
    );
    assert.deepEqual(frozenPublishingView.data.proofreadCredits, [
      "proofreader",
    ]);
    assert.equal(
      frozenPublishingView.data.generatedText,
      published.data.generatedText,
    );
    assert.equal(
      published.data.records[0].typesetVersionId,
      correctedVersionId,
    );
    assert.equal(
      published.data.records[0].generatedText,
      publishingView.data.generatedText,
    );
    assert.equal(
      (
        await request<PublishingViewResponse>(
          operator.browser,
          "POST",
          `/api/works/${workId}/publishing/confirm`,
          {
            expectedRevision: publishingView.data.workRevision,
            idempotencyKey: publishKey,
            note: "集成测试发布",
          },
        )
      ).status,
      200,
    );
    type BusinessAuditPageResponse = {
      scope: "global" | "related";
      total: number;
      items: { workId: string; action: string }[];
      nextCursor: string | null;
    };
    const translatorAudit = await request<BusinessAuditPageResponse>(
      translator.browser,
      "GET",
      `/api/audit/events?action=publish_confirmed&search=${prefix}`,
    );
    assert.equal(translatorAudit.status, 200);
    assert.equal(translatorAudit.data.scope, "related");
    assert.equal(translatorAudit.data.items.length, 1);
    assert.equal(translatorAudit.data.items[0].workId, workId);
    assert.equal(translatorAudit.data.items[0].action, "publish_confirmed");
    const reviewerAudit = await request<BusinessAuditPageResponse>(
      reviewer.browser,
      "GET",
      `/api/audit/events?action=publish_confirmed&search=${prefix}`,
    );
    assert.equal(reviewerAudit.status, 200);
    assert.equal(reviewerAudit.data.scope, "global");
    assert.equal(reviewerAudit.data.total, 1);
    assert.equal(reviewerAudit.data.items[0].workId, workId);
    const unrelatedAudit = await request<BusinessAuditPageResponse>(
      unrelated.browser,
      "GET",
      `/api/audit/events?search=${prefix}`,
    );
    assert.equal(unrelatedAudit.status, 200);
    assert.equal(unrelatedAudit.data.scope, "related");
    assert.equal(unrelatedAudit.data.total, 0);
    const unrelatedDashboard = await request<{
      recentActivity: { workId: string }[];
    }>(unrelated.browser, "GET", "/api/dashboard/summary");
    assert.equal(unrelatedDashboard.status, 200);
    assert.deepEqual(unrelatedDashboard.data.recentActivity, []);
    const held = await request<{
      id: string;
      openedTypesetVersionId: string | null;
      openedTypesetVersionNumber: number | null;
    }>(source.browser, "POST", `/api/works/${workId}/reviews`, {
      reason: "等待补充来源说明",
      expectedRevision: published.data.workRevision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(held.status, 200);
    assert.equal(held.data.openedTypesetVersionId, correctedVersionId);
    assert.equal(held.data.openedTypesetVersionNumber, 3);
    current = (
      await request<WorkResponse>(
        translator.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    const discarded = await request<{
      workRevision: number;
      canRestore: boolean;
    }>(admin.browser, "POST", `/api/reviews/${held.data.id}/resolve`, {
      resolution: "discard",
      confirmDiscard: true,
      note: "制作决定舍弃",
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(discarded.status, 200);
    assert.equal(discarded.data.canRestore, true);
    const reviewRestored = await request<{ workRevision: number }>(
      admin.browser,
      "POST",
      `/api/reviews/${held.data.id}/resolve`,
      {
        resolution: "restore_production",
        note: "确认继续制作",
        expectedRevision: discarded.data.workRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(reviewRestored.status, 200);
    current = (
      await request<WorkResponse>(
        translator.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    assert.equal(current.workflowStatus, "published");
    assert.equal(current.reviewStatus, "normal");
    const rejoined = { data: current };
    const updated = await request<WorkResponse>(
      source.browser,
      "PATCH",
      `/api/works/${workId}`,
      {
        title: "修改后的流程作品",
        priority: 5,
        expectedRevision: rejoined.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(updated.status, 200);
    const archived = await request<WorkResponse>(
      admin.browser,
      "POST",
      `/api/works/${workId}/archive`,
      {
        expectedRevision: updated.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(archived.data.workflowStatus, "archived");
    const restored = await request<WorkResponse>(
      admin.browser,
      "POST",
      `/api/works/${workId}/restore`,
      {
        expectedRevision: archived.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.workflowStatus, "published");

    const mine = await request<{
      items: { id: string; coverImageId: string | null }[];
    }>(translator.browser, "GET", "/api/works?mine=true");
    const listedWork = mine.data.items.find((item) => item.id === workId);
    assert.equal(listedWork?.coverImageId, initial.data.images[0].id);
    const dashboard = await request<{
      pendingCandidates: number | null;
      myParticipatingWorks: number;
      myWorkflowCounts: { status: string; count: number }[];
    }>(translator.browser, "GET", "/api/dashboard/summary");
    assert.equal(dashboard.data.pendingCandidates, null);
    assert.equal(dashboard.data.myParticipatingWorks, 1);
    assert.equal(
      dashboard.data.myWorkflowCounts.find(
        ({ status }) => status === "published",
      )?.count,
      1,
    );
    assert.equal(
      (
        await request<{ pendingCandidates: number | null }>(
          source.browser,
          "GET",
          "/api/dashboard/summary",
        )
      ).data.pendingCandidates,
      pendingCandidateBaseline + 1,
    );
    const resolvedReviews = await request<{ items: { id: string }[] }>(
      translator.browser,
      "GET",
      "/api/reviews?status=resolved",
    );
    assert.ok(
      resolvedReviews.data.items.some((item) => item.id === opened.data.id),
    );
    assert.equal(await db.workReviewCase.count({ where: { workId } }), 3);
    assert.equal(
      await db.workEvent.count({
        where: { workId, action: "stage_submitted" },
      }),
      7,
    );

    // Preserve compatibility with historic resolved revise records without accepting new legacy commands.
    await db.workReviewCase.create({
      data: {
        workId,
        openedFromWorkflowStatus: "published",
        openedTypesetVersionId: correctedVersionId,
        reason: "legacy revision fixture",
        status: "resolved",
        resolution: "revise",
        targetWorkflowStatus: "pending_typeset",
        openedById: source.user.id,
        resolvedById: admin.user.id,
        resolvedAt: new Date(),
      },
    });
    await db.work.update({
      where: { id: workId },
      data: {
        workflowStatus: "pending_typeset",
        typesetHandoffStartedAt: null,
        revision: { increment: 1 },
      },
    });
    current = (
      await request<WorkResponse>(
        typesetter.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    const typesetJoined = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/join`,
      {
        stage: "typeset",
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(typesetJoined.status, 200);
    const finalSourcePackage = await request<{
      packageId: string;
      downloadUrl: string;
    }>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/typeset/handoff-packages`,
      {
        expectedRevision: typesetJoined.data.revision,
        expectedEditorEpoch: typesetJoined.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(finalSourcePackage.status, 200);
    assert.equal(
      (
        await fetch(base + finalSourcePackage.data.downloadUrl, {
          headers: typesetter.browser.cookie
            ? { Cookie: typesetter.browser.cookie }
            : undefined,
        })
      ).status,
      200,
    );
    const finalTypesetHead = (
      await request<WorkResponse>(
        typesetter.browser,
        "GET",
        `/api/works/${workId}`,
      )
    ).data;
    const resubmittedTypeset = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "typeset",
        expectedRevision: finalTypesetHead.revision,
        expectedEditorEpoch: finalTypesetHead.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(resubmittedTypeset.status, 409);
    const cannotReplacePublishedVersion =
      await multipartRequest<TypesetVersionListResponse>(
        typesetter.browser,
        `/api/works/${workId}/typeset/versions`,
        {
          expectedRevision: String(finalTypesetHead.revision),
          idempotencyKey: randomUUID(),
          mode: "replace_current",
        },
        [{ name: "replacement.png", body: png(1000, 700), type: "image/png" }],
      );
    assert.equal(cannotReplacePublishedVersion.status, 409);
    const postPublishReworkVersion =
      await multipartRequest<TypesetVersionListResponse>(
        typesetter.browser,
        `/api/works/${workId}/typeset/versions`,
        {
          expectedRevision: String(finalTypesetHead.revision),
          idempotencyKey: randomUUID(),
          mode: "new_version",
          note: "发布后返工成图",
        },
        [
          {
            name: "result-04.png",
            body: png(1000, 700),
            type: "image/png",
          },
        ],
      );
    assert.equal(postPublishReworkVersion.status, 201);
    const finalTypesetSubmission = await request<WorkResponse>(
      typesetter.browser,
      "POST",
      `/api/works/${workId}/stages/submit`,
      {
        stage: "typeset",
        expectedRevision: postPublishReworkVersion.data.workRevision,
        expectedEditorEpoch: finalTypesetHead.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(finalTypesetSubmission.status, 200);
    assert.equal(finalTypesetSubmission.data.workflowStatus, "pending_publish");
  } finally {
    if (workId) {
      const typesetImageFiles = await db.typesetImageVersionImage.findMany({
        where: { version: { workId } },
        select: { fileObjectId: true },
      });
      const labelPlusFiles = await db.labelPlusFile.findMany({
        where: { workId },
        select: { fileObjectId: true },
      });
      const typesetPackages = await db.typesetHandoffPackage.findMany({
        where: { workId },
        select: { fileObjectId: true },
      });
      await db.typesetHandoffPackage.deleteMany({ where: { workId } });
      await db.publishRecord.deleteMany({ where: { workId } });
      await db.workReviewCase.deleteMany({ where: { workId } });
      await db.work.updateMany({
        where: { id: workId },
        data: { currentTypesetVersionId: null },
      });
      await db.typesetImageVersion.deleteMany({ where: { workId } });
      await db.labelPlusFile.deleteMany({ where: { workId } });
      await db.workEvent.deleteMany({ where: { workId } });
      await db.stageContributionSubmission.deleteMany({
        where: { participant: { workId } },
      });
      await db.workStageAssignment.deleteMany({
        where: { participant: { workId } },
      });
      await db.workStageParticipant.deleteMany({ where: { workId } });
      await db.translationVersion.deleteMany({ where: { workId } });
      await db.workImage.deleteMany({ where: { workId } });
      await db.work.deleteMany({ where: { id: workId } });
      await db.fileObject.deleteMany({
        where: {
          id: {
            in: [
              ...labelPlusFiles,
              ...typesetPackages,
              ...typesetImageFiles,
            ].map(({ fileObjectId }) => fileObjectId),
          },
        },
      });
    }
    if (candidateId) {
      await db.candidateMedia.deleteMany({
        where: { candidatePostId: candidateId },
      });
      await db.candidatePost.deleteMany({ where: { id: candidateId } });
    }
    if (accountId)
      await db.authorExternalAccount.deleteMany({ where: { id: accountId } });
    if (authorId) await db.author.deleteMany({ where: { id: authorId } });
    if (fileId) await db.fileObject.deleteMany({ where: { id: fileId } });
    await db.accountAudit.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
      },
    });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.userLanguageCapability.deleteMany({
      where: { userId: { in: userIds } },
    });
    await db.fileObject.deleteMany({
      where: { createdById: { in: userIds }, kind: "publication-package" },
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
