import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { hashPassword } from "../../src/users/password.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable _test database.",
  );
}

type Browser = { cookie?: string };
type WorkResponse = {
  id: string;
  revision: number;
  editorEpoch: number;
  workflowStatus: string;
  images: { id: string }[];
};

test("single-stage identity locks and multi-page contributions integrate server drafts", async () => {
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
  const password = "collaboration-password-12345";
  const userIds: string[] = [];
  const workIds: string[] = [];
  const candidateIds: string[] = [];
  let authorId = "";
  let accountId = "";
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
    return { status: response.status, data: (await response.json()) as T };
  }

  async function createMember(
    suffix: string,
    roles: ("admin" | "translator" | "proofreader")[],
    languages: ("ja" | "ko")[],
  ) {
    const user = await db.user.create({
      data: {
        username: `collab_${prefix}_${suffix}`,
        displayName: suffix,
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
        roles: { create: roles.map((role) => ({ role })) },
        languageCapabilities: {
          create: languages.map((language) => ({ language })),
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
    const admin = await createMember("admin", ["admin"], ["ja", "ko"]);
    const memberA = await createMember(
      "member_a",
      ["translator", "proofreader"],
      ["ja"],
    );
    const memberB = await createMember("member_b", ["translator"], ["ja"]);
    const noJapanese = await createMember("no_ja", ["translator"], []);
    const author = await db.author.create({
      data: { displayName: `协作作者 ${prefix}`, sourceLanguage: "ja" },
    });
    authorId = author.id;
    const account = await db.authorExternalAccount.create({
      data: {
        authorId,
        platform: "fixture",
        externalUserId: `collaboration-${prefix}`,
      },
    });
    accountId = account.id;
    const singleCandidate = await db.candidatePost.create({
      data: {
        authorId,
        authorExternalAccountId: accountId,
        platform: "fixture",
        externalPostId: `collaboration-single-${prefix}`,
        postedAt: new Date(),
        rawJson: { fixture: true },
      },
    });
    candidateIds.push(singleCandidate.id);

    const single = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: singleCandidate.id,
        title: "单人职责约束",
        sourceLanguage: "ja",
        importedById: admin.user.id,
      },
    });
    workIds.push(single.id);
    const singleJoined = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${single.id}/stages/claim`,
      {
        stage: "translate",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(singleJoined.status, 200);
    assert.equal(
      (
        await request(
          memberA.browser,
          "POST",
          `/api/works/${single.id}/stages/claim`,
          {
            stage: "proofread",
            expectedRevision: singleJoined.data.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          memberB.browser,
          "POST",
          `/api/works/${single.id}/stages/join`,
          {
            stage: "translate",
            expectedRevision: singleJoined.data.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      409,
    );

    const originals = await Promise.all(
      [1, 2].map((value) =>
        files.store({
          body: new Uint8Array([value]),
          contentType: "image/png",
          bucketScope: "source",
          kind: "candidate-media",
          createdById: admin.user.id,
        }),
      ),
    );
    const collaborativeCandidate = await db.candidatePost.create({
      data: {
        authorId,
        authorExternalAccountId: accountId,
        platform: "fixture",
        externalPostId: `collaboration-multi-${prefix}`,
        postedAt: new Date(),
        rawJson: { fixture: true },
      },
    });
    candidateIds.push(collaborativeCandidate.id);
    const collaborative = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: collaborativeCandidate.id,
        title: "多人分页协作",
        sourceLanguage: "ja",
        collaborationMode: "multi",
        workflowStatus: "translating",
        importedById: admin.user.id,
        images: {
          create: originals.map((file, orderIndex) => ({
            originalFileObjectId: file.id,
            orderIndex,
          })),
        },
        stageParticipants: {
          create: {
            stage: "translate",
            userId: memberA.user.id,
            participationMode: "owner",
          },
        },
      },
      include: { images: { orderBy: { orderIndex: "asc" } } },
    });
    workIds.push(collaborative.id);
    assert.equal(
      (
        await request(
          noJapanese.browser,
          "POST",
          `/api/works/${collaborative.id}/stages/join`,
          {
            stage: "translate",
            expectedRevision: 0,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );
    const joined = await request<WorkResponse>(
      memberB.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/join`,
      {
        stage: "translate",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(joined.status, 200);
    const clearedA = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/assignments`,
      {
        stage: "translate",
        imageIds: [],
        expectedRevision: joined.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(clearedA.status, 200);
    const assignedA = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/assignments`,
      {
        stage: "translate",
        imageIds: [collaborative.images[0].id],
        expectedRevision: clearedA.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(assignedA.status, 200);
    const assignedB = await request<WorkResponse>(
      memberB.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/assignments`,
      {
        stage: "translate",
        imageIds: [collaborative.images[1].id],
        expectedRevision: assignedA.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(assignedB.status, 200);
    const completedA = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/contributions/complete`,
      {
        stage: "translate",
        expectedRevision: assignedB.data.revision,
        expectedEditorEpoch: 0,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(completedA.status, 200);
    assert.equal(
      (
        await request(
          memberA.browser,
          "POST",
          `/api/works/${collaborative.id}/stages/submit`,
          {
            stage: "translate",
            expectedRevision: completedA.data.revision,
            expectedEditorEpoch: 0,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      409,
    );
    const createdMarker = await request<{
      entries: { id: string; revision: number }[];
    }>(
      memberB.browser,
      "POST",
      `/api/work-images/${collaborative.images[1].id}/markers`,
      {
        markerX: 0.25,
        markerY: 0.375,
        markerPositionType: "inside",
        expectedImageRevision: 0,
        expectedEditorEpoch: 0,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(createdMarker.status, 201);
    const completedB = await request<WorkResponse>(
      memberB.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/contributions/complete`,
      {
        stage: "translate",
        expectedRevision: completedA.data.revision,
        expectedEditorEpoch: 0,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(completedB.status, 200);
    const submitted = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/submit`,
      {
        stage: "translate",
        expectedRevision: completedB.data.revision,
        expectedEditorEpoch: 0,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.workflowStatus, "pending_proofread");
    assert.equal(submitted.data.editorEpoch, 1);
    const version = await db.translationVersion.findFirstOrThrow({
      where: { workId: collaborative.id },
      include: { entries: true },
    });
    assert.equal(version.entries.length, 1);
    assert.equal(version.entries[0].workImageId, collaborative.images[1].id);
    const submittedEdit = await request<{ translatedText: string }>(
      memberB.browser,
      "PATCH",
      `/api/translation-entries/${createdMarker.data.entries[0].id}`,
      {
        expectedRevision: createdMarker.data.entries[0].revision,
        expectedEditorEpoch: 1,
        translatedText: "提交后不应直接修改",
      },
    );
    assert.equal(submittedEdit.status, 403);
    const cancelled = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/submission/cancel`,
      {
        stage: "translate",
        expectedRevision: submitted.data.revision,
        expectedEditorEpoch: submitted.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.workflowStatus, "translating");
    const resubmitted = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/submit`,
      {
        stage: "translate",
        expectedRevision: cancelled.data.revision,
        expectedEditorEpoch: cancelled.data.editorEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(resubmitted.status, 200);
    const proofreadClaimed = await request<WorkResponse>(
      memberA.browser,
      "POST",
      `/api/works/${collaborative.id}/stages/claim`,
      {
        stage: "proofread",
        expectedRevision: resubmitted.data.revision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(proofreadClaimed.status, 200);
    assert.equal(proofreadClaimed.data.workflowStatus, "pending_proofread");
    assert.equal(
      proofreadClaimed.data.editorEpoch,
      resubmitted.data.editorEpoch,
    );
    const proofreadEdit = await request<{
      translatedText: string;
      mutation: { editorEpoch: number; workflowStatus: string };
    }>(
      memberA.browser,
      "PATCH",
      `/api/translation-entries/${createdMarker.data.entries[0].id}`,
      {
        expectedRevision: createdMarker.data.entries[0].revision,
        expectedEditorEpoch: proofreadClaimed.data.editorEpoch,
        translatedText: "校对首次改动",
      },
    );
    assert.equal(proofreadEdit.status, 200);
    assert.equal(proofreadEdit.data.mutation.workflowStatus, "proofreading");
    assert.equal(
      proofreadEdit.data.mutation.editorEpoch,
      proofreadClaimed.data.editorEpoch + 1,
    );
    const handoffVersions = await db.translationVersion.findMany({
      where: { workId: collaborative.id },
      orderBy: { versionNumber: "asc" },
      include: { entries: true },
    });
    assert.equal(handoffVersions.length, 2);
    assert.equal(handoffVersions[1].stage, "translate");
    assert.equal(
      (
        await request(
          memberA.browser,
          "POST",
          `/api/works/${collaborative.id}/stages/submission/cancel`,
          {
            stage: "translate",
            expectedRevision: proofreadClaimed.data.revision + 1,
            expectedEditorEpoch: proofreadEdit.data.mutation.editorEpoch,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      409,
    );
    for (const mode of ["single", "multi"] as const) {
      const candidate = await db.candidatePost.create({
        data: {
          authorId,
          authorExternalAccountId: accountId,
          platform: "fixture",
          externalPostId: `no-edit-${mode}-${prefix}`,
          postedAt: new Date(),
          rawJson: { fixture: true },
        },
      });
      candidateIds.push(candidate.id);
      const unchangedWork = await db.work.create({
        data: {
          authorId,
          sourceCandidatePostId: candidate.id,
          title: "检查无误无需修改",
          sourceLanguage: "ja",
          collaborationMode: mode,
          workflowStatus: "translating",
          importedById: admin.user.id,
          images: {
            create: {
              originalFileObjectId: originals[0].id,
              orderIndex: 0,
              translationRevision: 1,
              translationEntries: {
                create: {
                  orderIndex: 0,
                  markerX: 0.25,
                  markerY: 0.4,
                  markerPositionType: "inside",
                  translatedText: "检查无误的翻译",
                  creationIdempotencyKey: randomUUID(),
                  createdById: memberB.user.id,
                  updatedById: memberB.user.id,
                },
              },
            },
          },
          stageParticipants: {
            create: {
              stage: "translate",
              userId: memberB.user.id,
              participationMode: "owner",
            },
          },
        },
        include: { images: true, stageParticipants: true },
      });
      workIds.push(unchangedWork.id);
      let head: WorkResponse = { ...unchangedWork };
      if (mode === "multi") {
        const participant = unchangedWork.stageParticipants[0];
        await db.workStageAssignment.create({
          data: {
            participantId: participant.id,
            workImageId: unchangedWork.images[0].id,
            assignedById: memberB.user.id,
          },
        });
        const completed = await request<WorkResponse>(
          memberB.browser,
          "POST",
          `/api/works/${head.id}/stages/contributions/complete`,
          {
            stage: "translate",
            expectedRevision: head.revision,
            expectedEditorEpoch: head.editorEpoch,
            idempotencyKey: randomUUID(),
          },
        );
        assert.equal(completed.status, 200);
        head = completed.data;
      }
      const translated = await request<WorkResponse>(
        memberB.browser,
        "POST",
        `/api/works/${head.id}/stages/submit`,
        {
          stage: "translate",
          expectedRevision: head.revision,
          expectedEditorEpoch: head.editorEpoch,
          idempotencyKey: randomUUID(),
        },
      );
      assert.equal(translated.status, 200);
      head = translated.data;
      const submitProof = () => ({
        stage: "proofread",
        expectedRevision: head.revision,
        expectedEditorEpoch: head.editorEpoch,
        idempotencyKey: randomUUID(),
      });
      assert.equal(
        (
          await request(
            memberA.browser,
            "POST",
            `/api/works/${head.id}/stages/submit`,
            submitProof(),
          )
        ).status,
        409,
      );
      const claimed = await request<WorkResponse>(
        memberA.browser,
        "POST",
        `/api/works/${head.id}/stages/claim`,
        {
          stage: "proofread",
          expectedRevision: head.revision,
          idempotencyKey: randomUUID(),
        },
      );
      assert.equal(claimed.status, 200);
      head = claimed.data;
      const editor = await request<{
        submissionStage: string | null;
        hasUnsubmittedChanges: boolean;
        canEdit: boolean;
      }>(memberA.browser, "GET", `/api/works/${head.id}/translations`);
      assert.equal(editor.data.submissionStage, "proofread");
      assert.equal(editor.data.hasUnsubmittedChanges, false);
      assert.equal(head.workflowStatus, "pending_proofread");
      assert.equal(
        (
          await request(
            admin.browser,
            "POST",
            `/api/works/${head.id}/stages/submit`,
            submitProof(),
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            memberA.browser,
            "POST",
            `/api/works/${head.id}/stages/submit`,
            { ...submitProof(), expectedRevision: head.revision - 1 },
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            memberA.browser,
            "POST",
            `/api/works/${head.id}/stages/submit`,
            { ...submitProof(), expectedEditorEpoch: head.editorEpoch - 1 },
          )
        ).status,
        409,
      );
      await db.work.update({
        where: { id: head.id },
        data: { reviewStatus: "needs_review" },
      });
      assert.equal(
        (
          await request(
            memberA.browser,
            "POST",
            `/api/works/${head.id}/stages/submit`,
            submitProof(),
          )
        ).status,
        409,
      );
      await db.work.update({
        where: { id: head.id },
        data: { reviewStatus: "normal" },
      });
      if (mode === "multi") {
        assert.equal(
          (
            await request(
              memberA.browser,
              "POST",
              `/api/works/${head.id}/stages/submit`,
              submitProof(),
            )
          ).status,
          409,
        );
        const assigned = await request<WorkResponse>(
          memberA.browser,
          "POST",
          `/api/works/${head.id}/stages/assignments`,
          {
            stage: "proofread",
            imageIds: [unchangedWork.images[0].id],
            expectedRevision: head.revision,
            idempotencyKey: randomUUID(),
          },
        );
        assert.equal(assigned.status, 200);
        head = assigned.data;
        assert.equal(
          (
            await request(
              memberA.browser,
              "POST",
              `/api/works/${head.id}/stages/submit`,
              submitProof(),
            )
          ).status,
          409,
        );
        const completed = await request<WorkResponse>(
          memberA.browser,
          "POST",
          `/api/works/${head.id}/stages/contributions/complete`,
          {
            stage: "proofread",
            expectedRevision: head.revision,
            expectedEditorEpoch: head.editorEpoch,
            idempotencyKey: randomUUID(),
          },
        );
        assert.equal(completed.status, 200);
        head = completed.data;
        assert.equal(head.workflowStatus, "pending_proofread");
      }
      const key = randomUUID();
      const input = { ...submitProof(), idempotencyKey: key };
      const checked = await request<WorkResponse>(
        memberA.browser,
        "POST",
        `/api/works/${head.id}/stages/submit`,
        input,
      );
      assert.equal(checked.status, 200);
      assert.equal(checked.data.workflowStatus, "pending_typeset");
      assert.equal(checked.data.editorEpoch, head.editorEpoch + 1);
      const replay = await request<WorkResponse>(
        memberA.browser,
        "POST",
        `/api/works/${head.id}/stages/submit`,
        input,
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.data.revision, checked.data.revision);
      const versions = await db.translationVersion.findMany({
        where: { workId: head.id },
        orderBy: { versionNumber: "asc" },
        include: { entries: true },
      });
      assert.equal(versions.length, 2);
      assert.equal(versions[0].stage, "translate");
      assert.equal(versions[1].stage, "proofread");
      assert.equal(
        versions[1].entries[0].translatedText,
        versions[0].entries[0].translatedText,
      );
      assert.equal(versions[1].createdById, memberA.user.id);
      const credit = await db.workStageParticipant.findFirstOrThrow({
        where: { workId: head.id, stage: "proofread", userId: memberA.user.id },
      });
      assert.ok(credit.submittedAt);
      assert.equal(credit.creditNameSnapshot, memberA.user.displayName);
      assert.equal(
        (
          await request(
            memberB.browser,
            "POST",
            `/api/works/${head.id}/stages/submission/cancel`,
            {
              stage: "translate",
              expectedRevision: checked.data.revision,
              expectedEditorEpoch: checked.data.editorEpoch,
              idempotencyKey: randomUUID(),
            },
          )
        ).status,
        409,
      );
      const cancelledProof = await request<WorkResponse>(
        memberA.browser,
        "POST",
        `/api/works/${head.id}/stages/submission/cancel`,
        {
          stage: "proofread",
          expectedRevision: checked.data.revision,
          expectedEditorEpoch: checked.data.editorEpoch,
          idempotencyKey: randomUUID(),
        },
      );
      assert.equal(cancelledProof.status, 200);
      assert.equal(cancelledProof.data.workflowStatus, "proofreading");
    }
  } finally {
    await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
    await db.stageContributionSubmission.deleteMany({
      where: { participant: { workId: { in: workIds } } },
    });
    await db.workStageAssignment.deleteMany({
      where: { participant: { workId: { in: workIds } } },
    });
    await db.translationVersion.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.translationEntry.deleteMany({
      where: { workImage: { workId: { in: workIds } } },
    });
    await db.workStageParticipant.deleteMany({
      where: { workId: { in: workIds } },
    });
    await db.workImage.deleteMany({ where: { workId: { in: workIds } } });
    await db.work.deleteMany({ where: { id: { in: workIds } } });
    await db.candidatePost.deleteMany({ where: { id: { in: candidateIds } } });
    if (accountId) {
      await db.authorExternalAccount.deleteMany({ where: { id: accountId } });
    }
    if (authorId) await db.author.deleteMany({ where: { id: authorId } });
    await db.fileObject.deleteMany({ where: { createdById: { in: userIds } } });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.userLanguageCapability.deleteMany({
      where: { userId: { in: userIds } },
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
