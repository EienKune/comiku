import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { ContributionsService } from "../../src/dashboard/contributions.service.js";
import {
  ContributionDetailsQueryDto,
  ContributionQueryDto,
} from "../../src/dashboard/contributions.dto.js";
import { hashPassword } from "../../src/users/password.js";
import { WorksService } from "../../src/works/works.service.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("effective contributions, unique works, first publication, historical identities and server authorization stay reconcilable", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const db = app.get(PrismaService),
    service = app.get(ContributionsService);
  const userIds: string[] = [],
    workIds: string[] = [],
    postIds: string[] = [],
    fileIds: string[] = [];
  const now = new Date("2026-11-18T04:00:00Z"),
    first = new Date("2026-10-31T16:00:00Z"),
    previous = new Date(first.getTime() - 1),
    next = new Date("2026-11-30T16:00:00Z");
  let authorId = "";
  const password = "synthetic-contribution-password";
  const member = async (label: string, admin = false) => {
    const result = await db.user.create({
      data: {
        username: `contrib_${randomUUID()}`,
        displayName: label,
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
        roles: { create: { role: admin ? "admin" : "translator" } },
        languageCapabilities: { create: { language: "ja" } },
      },
    });
    userIds.push(result.id);
    return result;
  };
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const admin = await member("Synthetic admin", true),
      a = await member("Synthetic A"),
      b = await member("Synthetic B"),
      actor = await member("Submit actor");
    const author = await db.author.create({
      data: { displayName: "Synthetic contribution author" },
    });
    authorId = author.id;
    const original = await db.fileObject.create({
      data: {
        objectKey: `contribution-original/${randomUUID()}`,
        bucketScope: "source",
        kind: "fixture",
        contentType: "image/png",
        size: 1n,
        checksum: "0".repeat(64),
      },
    });
    fileIds.push(original.id);

    const work = async (title: string, archived = false) => {
      const post = await db.candidatePost.create({
        data: {
          authorId,
          platform: "synthetic",
          externalPostId: randomUUID(),
          postedAt: now,
          rawJson: {},
        },
      });
      postIds.push(post.id);
      const result = await db.work.create({
        data: {
          authorId,
          sourceCandidatePostId: post.id,
          importedById: admin.id,
          title,
          images: {
            create: { originalFileObjectId: original.id, orderIndex: 0 },
          },
          workflowStatus: archived ? "archived" : "pending_proofread",
        },
      });
      workIds.push(result.id);
      return result;
    };
    const credit = (
      workId: string,
      userId: string,
      stage: "translate" | "proofread" | "typeset" | "publish",
      submittedAt: Date | null,
      leftAt: Date | null = null,
    ) =>
      db.workStageParticipant.create({
        data: {
          workId,
          userId,
          stage,
          submittedAt,
          leftAt,
          participationMode: "collaborator",
          joinedAt: previous,
        },
      });
    const multi = await work("Same work, multiple roles and credits");
    const aTranslate = await credit(multi.id, a.id, "translate", first, now);
    const bTranslate = await credit(multi.id, b.id, "translate", first);
    // Reconciled legacy multi work can have page ownership without per-member
    // submission receipts; its original simultaneous formal credits stay valid.
    await db.work.update({
      where: { id: multi.id },
      data: { collaborationMode: "multi" },
    });
    const legacyImage = await db.workImage.findFirstOrThrow({
      where: { workId: multi.id },
    });
    await db.workPageAssignment.create({
      data: {
        workId: multi.id,
        workImageId: legacyImage.id,
        stage: "translate",
        participantId: bTranslate.id,
      },
    });
    await credit(multi.id, a.id, "translate", first, now); // Duplicate historical row never adds a second credit.
    await credit(multi.id, a.id, "typeset", first);
    await credit(multi.id, actor.id, "translate", null, now);
    await credit(multi.id, a.id, "proofread", null, now);
    await db.workEvent.create({
      data: {
        workId: multi.id,
        actorId: actor.id,
        action: "stage_submitted",
        detail: {
          stage: "translate",
          participantIds: [aTranslate.id, bTranslate.id],
          credits: [{ userId: a.id }, { userId: b.id }],
        },
      },
    });
    const old = await work("Previous Shanghai month"),
      future = await work("Next Shanghai month");
    await credit(old.id, a.id, "proofread", previous);
    await credit(future.id, a.id, "proofread", next);
    const republished = await work("First publication owns the month"),
      published = await work("Old contribution published this month");
    await credit(republished.id, a.id, "translate", previous);
    await credit(published.id, a.id, "translate", previous);
    for (const [w, dates] of [
      [republished, [previous, first]],
      [published, [first, now]],
    ] as const) {
      const version = await db.typesetImageVersion.create({
        data: {
          workId: w.id,
          versionNumber: 1,
          idempotencyKey: randomUUID(),
          uploadedById: actor.id,
        },
      });
      for (const publishedAt of dates)
        await db.publishRecord.create({
          data: {
            workId: w.id,
            typesetVersionId: version.id,
            templateNameSnapshot: "Synthetic",
            templateRevision: 0,
            templateContentSnapshot: "",
            generatedTextSnapshot: "",
            idempotencyKey: randomUUID(),
            publishedById: actor.id,
            publishedAt,
            translationCreditsSnapshot: ["not-a-user-id"],
          },
        });
    }
    const task = await work("Old unfinished claim"),
      archivedTask = await work("Archived retained claim", true),
      archived = await work("Archived completed credit", true);
    await credit(task.id, a.id, "typeset", null);
    await credit(archivedTask.id, a.id, "translate", null);
    await credit(archived.id, a.id, "translate", first);
    await credit(archived.id, a.id, "publish", first); // Legacy publish participation is not a production role.
    const query = Object.assign(new ContributionQueryDto(), { userId: a.id });
    const summary = await service.summary(admin.id, query, now);
    assert.deepEqual(summary.counts, {
      translate: 2,
      proofread: 0,
      typeset: 1,
      works: 2,
      published: 1,
      tasks: 2,
    });
    assert.equal(
      summary.achievements.find((item) => item.id === "collaboration")
        ?.achieved,
      true,
    );
    assert.equal(
      summary.achievements.find((item) => item.id === "translate-10")?.progress,
      4,
    );
    for (const metric of [
      "translate",
      "proofread",
      "typeset",
      "works",
      "published",
      "tasks",
    ] as const) {
      const details = await service.details(
        admin.id,
        Object.assign(new ContributionDetailsQueryDto(), query, {
          metric,
          limit: 1,
        }),
        now,
      );
      assert.equal(details.total, summary.counts[metric], metric);
      assert.ok(details.items.length <= 1);
      if (details.total > 1) {
        const second = await service.details(
          admin.id,
          Object.assign(new ContributionDetailsQueryDto(), query, {
            metric,
            limit: 1,
            offset: 1,
          }),
          now,
        );
        assert.notEqual(details.items[0].id, second.items[0].id);
      }
    }
    const team = await service.summary(
      admin.id,
      Object.assign(new ContributionQueryDto(), { scope: "team" }),
      now,
    );
    assert.equal(team.counts.translate, 3);
    assert.equal(team.counts.works, 2);
    assert.equal(team.counts.published, 1);
    assert.equal(
      (await service.summary(actor.id, new ContributionQueryDto(), now)).counts
        .translate,
      0,
    );
    assert.equal(
      (await service.summary(actor.id, new ContributionQueryDto(), now)).counts
        .published,
      0,
    );
    await db.user.update({
      where: { id: a.id },
      data: {
        displayName: "Renamed historic member",
        isActive: false,
        roles: { deleteMany: {} },
      },
    });
    assert.deepEqual(
      (await service.summary(admin.id, query, now)).counts,
      summary.counts,
    );
    const named = await service.details(
      admin.id,
      Object.assign(new ContributionDetailsQueryDto(), query, {
        metric: "works",
      }),
      now,
    );
    assert.ok(
      named.items.every((item) =>
        item.contributions.every(
          (c) =>
            c.userId === a.id && c.displayName === "Renamed historic member",
        ),
      ),
    );
    // Cancellation invalidates formal credit even though the immutable submit event survives.
    await db.workStageParticipant.updateMany({
      where: { workId: multi.id, stage: "translate" },
      data: { submittedAt: null },
    });
    const cancelled = await service.summary(
      admin.id,
      Object.assign(new ContributionQueryDto(), { userId: b.id }),
      now,
    );
    assert.equal(cancelled.counts.translate, 0);
    assert.ok(cancelled.achievements.every((item) => !item.achieved));
    // A new effective round moves the month and restores exactly one credit per member.
    await db.workStageParticipant.updateMany({
      where: { workId: multi.id, stage: "translate", userId: b.id },
      data: { submittedAt: next },
    });
    const november = await service.summary(
      admin.id,
      Object.assign(new ContributionQueryDto(), { userId: b.id }),
      now,
    );
    const december = await service.summary(
      admin.id,
      Object.assign(new ContributionQueryDto(), { userId: b.id }),
      next,
    );
    assert.equal(november.counts.translate, 0);
    assert.equal(december.counts.translate, 1);
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: b.username, password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const path of [
      "summary?scope=team",
      `summary?userId=${a.id}`,
      `details?metric=works&userId=${a.id}`,
    ]) {
      const response = await fetch(base + "/api/contributions/" + path, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 403, path);
    }
    const own = await fetch(
      base + "/api/contributions/details?metric=works&limit=51",
      { headers: { Cookie: cookie } },
    );
    assert.equal(own.status, 400);
    // A non-owner cannot submit another contributor's pages or acquire credit.
    // The actual owner submits/cancels/re-submits their exact current page heads.
    const actual = await work("Actual submission transaction");
    await db.work.update({
      where: { id: actual.id },
      data: { workflowStatus: "translating", collaborationMode: "multi" },
    });
    const contributor = await credit(actual.id, b.id, "translate", null);
    const submitActor = await credit(
      actual.id,
      actor.id,
      "translate",
      null,
      new Date(),
    );
    const image = await db.workImage.findFirstOrThrow({
      where: { workId: actual.id },
    });
    await db.workStageAssignment.create({
      data: {
        participantId: contributor.id,
        workImageId: image.id,
        assignedById: admin.id,
      },
    });
    await db.stageContributionSubmission.create({
      data: {
        participantId: contributor.id,
        createdById: b.id,
        idempotencyKey: randomUUID(),
        pages: { create: { workImageId: image.id, imageRevision: 0 } },
      },
    });
    await db.workPageAssignment.create({
      data: {
        workId: actual.id,
        workImageId: image.id,
        stage: "translate",
        participantId: contributor.id,
        generation: 1,
      },
    });
    const submission = {
      stage: "translate" as const,
      pageHeads: [{ imageId: image.id, generation: 1, draftRevision: 0 }],
      expectedRevision: 0,
      expectedEditorEpoch: 0,
      idempotencyKey: randomUUID(),
    };
    const works = app.get(WorksService);
    await assert.rejects(
      () =>
        db.$transaction((tx) =>
          works.submitStageTx(tx, actor.id, actual.id, submission),
        ),
      /认领本人翻译页/,
    );
    await db.$transaction((tx) =>
      works.submitStageTx(tx, b.id, actual.id, submission),
    );
    const formal = await db.workStageParticipant.findUniqueOrThrow({
      where: { id: contributor.id },
    });
    assert.ok(formal.submittedAt);
    assert.ok(
      (
        await db.workStageParticipant.findUniqueOrThrow({
          where: { id: submitActor.id },
        })
      ).leftAt,
    );
    const actorSummary = await service.summary(
      actor.id,
      Object.assign(new ContributionQueryDto(), { period: "all" }),
    );
    assert.equal(actorSummary.counts.translate, 0);
    assert.equal(actorSummary.counts.tasks, 0);
    await db.$transaction((tx) =>
      works.submitStageTx(tx, b.id, actual.id, submission),
    );
    assert.equal(
      (
        await db.workStageParticipant.findUniqueOrThrow({
          where: { id: contributor.id },
        })
      ).submittedAt?.toISOString(),
      formal.submittedAt.toISOString(),
    );
    const bBefore = await service.summary(
      b.id,
      Object.assign(new ContributionQueryDto(), { period: "all" }),
    );
    assert.equal(bBefore.counts.translate, 2);
    await works.cancelStageSubmission(b.id, actual.id, {
      stage: "translate",
      expectedRevision: 1,
      expectedEditorEpoch: 1,
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      (
        await service.summary(
          b.id,
          Object.assign(new ContributionQueryDto(), { period: "all" }),
        )
      ).counts.translate,
      1,
    );
    await assert.rejects(
      () =>
        works.joinStage(actor.id, actual.id, {
          stage: "translate",
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        }),
      /空闲页/,
    );
    assert.equal(
      await db.workStageParticipant.count({
        where: { workId: actual.id, userId: actor.id },
      }),
      1,
    );
    await db.$transaction((tx) =>
      works.submitStageTx(tx, b.id, actual.id, {
        stage: "translate",
        pageHeads: [{ imageId: image.id, generation: 1, draftRevision: 0 }],
        expectedRevision: 2,
        expectedEditorEpoch: 2,
        idempotencyKey: randomUUID(),
      }),
    );
    assert.equal(
      (
        await service.summary(
          b.id,
          Object.assign(new ContributionQueryDto(), { period: "all" }),
        )
      ).counts.translate,
      2,
    );
    const rejoinedActor = await service.summary(
      actor.id,
      Object.assign(new ContributionQueryDto(), { period: "all" }),
    );
    assert.equal(rejoinedActor.counts.translate, 0);
    assert.equal(rejoinedActor.counts.tasks, 0);
    await db.userRole.deleteMany({ where: { userId: actor.id } });
    const rolelessLogin = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: actor.username, password }),
    });
    const rolelessCookie = rolelessLogin.headers
      .get("set-cookie")!
      .split(";")[0];
    for (const path of ["summary", "details?metric=works"])
      assert.equal(
        (
          await fetch(base + "/api/contributions/" + path, {
            headers: { Cookie: rolelessCookie },
          })
        ).status,
        403,
      );
  } finally {
    try {
      const whereWork = { workId: { in: workIds } };
      await db.publishRecord.deleteMany({ where: whereWork });
      await db.workEvent.deleteMany({ where: whereWork });
      await db.stageContributionPage.deleteMany({
        where: { submission: { participant: whereWork } },
      });
      await db.stageContributionSubmission.deleteMany({
        where: { participant: whereWork },
      });
      await db.workStageAssignment.deleteMany({
        where: { participant: whereWork },
      });
      await db.translationVersion.deleteMany({ where: whereWork });
      await db.workPageAssignment.deleteMany({ where: whereWork });
      await db.workStageParticipant.deleteMany({ where: whereWork });
      await db.typesetImageVersion.deleteMany({ where: whereWork });
      await db.workImage.deleteMany({ where: whereWork });
      await db.work.deleteMany({ where: { id: { in: workIds } } });
      await db.candidatePost.deleteMany({ where: { id: { in: postIds } } });
      await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
      if (authorId) await db.author.delete({ where: { id: authorId } });
      await db.accountAudit.deleteMany({
        where: {
          OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
        },
      });
      await db.userLanguageCapability.deleteMany({
        where: { userId: { in: userIds } },
      });
      await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app.close();
    }
  }
});
