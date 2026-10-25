import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { ReviewsService } from "../../src/reviews/reviews.service.js";
import { TranslationsService } from "../../src/translations/translations.service.js";
import { TypesettingService } from "../../src/typesetting/typesetting.service.js";
import { captureRevisionText } from "../../src/workflow/revision-policy.js";
import { permissionsFor } from "../../src/common/access.js";
import type {
  Prisma,
  WorkflowStatus,
} from "../../src/generated/prisma/client.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Disposable _test database required");
const mutation = (expectedRevision: number, expectedEditorEpoch?: number) => ({
  expectedRevision,
  expectedEditorEpoch,
  idempotencyKey: randomUUID(),
});

async function fixture(tx: Prisma.TransactionClient | PrismaService) {
  async function user(role: "admin" | "translator" | "typesetter") {
    return tx.user.create({
      data: {
        username: `review3_${randomUUID()}`,
        displayName: role,
        passwordHash: "non-login-fixture",
        mustChangePassword: false,
        roles: { create: { role } },
        languageCapabilities: { create: { language: "ja" } },
      },
    });
  }
  const admin = await user("admin"),
    applicant = await user("translator"),
    other = await user("typesetter");
  const author = await tx.author.create({
    data: { displayName: "Content review fixture" },
  });
  const candidate = await tx.candidatePost.create({
    data: {
      authorId: author.id,
      platform: "fixture",
      externalPostId: randomUUID(),
      postedAt: new Date(),
      rawJson: { fixture: true },
    },
  });
  const work = await tx.work.create({
    data: {
      authorId: author.id,
      sourceCandidatePostId: candidate.id,
      importedById: admin.id,
      title: "Preserve progress",
      workflowStatus: "translating",
      translationContributorIds: [applicant.id],
      stageParticipants: {
        create: [
          {
            userId: applicant.id,
            stage: "translate",
            participationMode: "owner",
          },
          { userId: other.id, stage: "typeset", participationMode: "owner" },
        ],
      },
    },
  });
  return { admin, applicant, other, author, candidate, work };
}
async function rollbackTest(
  run: (tx: Prisma.TransactionClient, client: PrismaService) => Promise<void>,
) {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  const rollback = Error("rollback review3 fixture");
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          const client = new Proxy(tx, {
            get(target, key) {
              return key === "$transaction"
                ? (fn: (t: Prisma.TransactionClient) => unknown) => fn(tx)
                : Reflect.get(target, key);
            },
          }) as unknown as PrismaService;
          await run(tx, client);
          throw rollback;
        },
        { timeout: 30000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
}

test("withdrawal is applicant-only, auditable, epoch-aware and actor-bound idempotent", async () =>
  rollbackTest(async (tx, client) => {
    const { admin, applicant, other, work } = await fixture(tx),
      reviews = new ReviewsService(client);
    const openInput = {
      ...mutation(0, 0),
      reason: "Original work may violate group rules",
    };
    await assert.rejects(
      reviews.open(applicant.id, work.id, { ...openInput, reason: " " }),
      BadRequestException,
    );
    const opened = await reviews.open(applicant.id, work.id, openInput);
    assert.equal(
      (await reviews.open(applicant.id, work.id, openInput)).id,
      opened.id,
    );
    assert.equal(
      (await reviews.get(opened.id, applicant.id)).canWithdraw,
      true,
    );
    assert.equal((await reviews.get(opened.id, admin.id)).canWithdraw, false);
    await assert.rejects(
      reviews.withdraw(other.id, opened.id, mutation(1, 1)),
      ForbiddenException,
    );
    await assert.rejects(
      reviews.withdraw(admin.id, opened.id, mutation(1, 1)),
      ForbiddenException,
    );
    await assert.rejects(
      reviews.withdraw(applicant.id, opened.id, mutation(1, 0)),
      ConflictException,
    );
    const input = mutation(1, 1),
      result = await reviews.withdraw(applicant.id, opened.id, input);
    assert.equal(result.resolution, "withdrawn");
    assert.equal(result.canWithdraw, false);
    assert.equal(result.editorEpoch, 2);
    assert.equal(result.workflowStatus, "translating");
    assert.equal(result.reviewStatus, "normal");
    assert.equal(
      (await reviews.withdraw(applicant.id, opened.id, input)).workRevision,
      2,
    );
    await assert.rejects(
      reviews.withdraw(applicant.id, opened.id, mutation(2, 2)),
      ConflictException,
    );
    await assert.rejects(
      reviews.resolve(admin.id, opened.id, {
        ...input,
        resolution: "continue_production",
      }),
      ConflictException,
    );
    assert.equal(
      await tx.workEvent.count({
        where: { workId: work.id, action: "review_withdrawn" },
      }),
      1,
    );
    assert.equal(
      (
        await new TranslationsService(client, {} as never).getEditor(
          applicant.id,
          work.id,
        )
      ).canEdit,
      true,
    );
    assert.equal(
      permissionsFor(["reviewer"], false).includes("reviews:resolve"),
      false,
    );
  }));

test("continue, discard and restore preserve all production fields and ownership in each stage", async () =>
  rollbackTest(async (tx, client) => {
    const { admin, applicant, other, work } = await fixture(tx),
      reviews = new ReviewsService(client);
    const handoff = new Date("2026-10-01T01:00:00Z");
    const originalParticipant = await tx.workStageParticipant.findFirstOrThrow({
      where: { workId: work.id, userId: applicant.id },
    });
    await tx.workCreditAlias.create({
      data: {
        stage: "translate",
        workId: work.id,
        userId: applicant.id,
        creditName: "临时署名",
      },
    });
    await tx.workStageParticipant.update({
      where: { id: originalParticipant.id },
      data: { submittedAt: handoff },
    });
    const version = await tx.translationVersion.create({
      data: {
        workId: work.id,
        versionNumber: 1,
        kind: "proofread_submission",
        stage: "proofread",
        workRevision: 0,
        editorEpoch: 1,
        createdById: applicant.id,
      },
    });
    const rendered = await tx.typesetImageVersion.create({
      data: {
        workId: work.id,
        versionNumber: 1,
        uploadedById: other.id,
        sourceTranslationVersionId: version.id,
        idempotencyKey: randomUUID(),
      },
    });
    const file = await tx.fileObject.create({
      data: {
        objectKey: `fixture/${randomUUID()}`,
        bucketScope: "works",
        kind: "typeset-handoff-package",
        contentType: "application/zip",
        size: 4,
        checksum: "0".repeat(64),
      },
    });
    const pack = await tx.typesetHandoffPackage.create({
      data: {
        workId: work.id,
        fileObjectId: file.id,
        kind: "unified_handoff",
        fileName: `${work.workNumber}_嵌字包.zip`,
        imageCount: 1,
        workRevision: 0,
        editorEpoch: 0,
        idempotencyKey: randomUUID(),
        createdById: other.id,
        translationVersionId: version.id,
      },
    });
    await tx.workEvent.create({
      data: {
        workId: work.id,
        actorId: other.id,
        action: "typeset_handoff_started",
        detail: { fileId: pack.id },
      },
    });
    const typesetting = new TypesettingService(
      client,
      { read: async () => ({ body: Buffer.from("test") }) } as never,
      new TranslationsService(client, {} as never),
    );
    for (const phase of [
      "translating",
      "proofreading",
      "typesetting",
      "pending_publish",
    ] satisfies WorkflowStatus[]) {
      await tx.work.update({
        where: { id: work.id },
        data: {
          workflowStatus: phase,
          currentTypesetVersionId: rendered.id,
          typesetHandoffStartedAt:
            phase === "typesetting" || phase === "pending_publish"
              ? handoff
              : null,
        },
      });
      const before = await tx.work.findUniqueOrThrow({
        where: { id: work.id },
      });
      const people = await tx.workStageParticipant.findMany({
        where: { workId: work.id },
        orderBy: { id: "asc" },
      });
      const alias = await tx.workCreditAlias.findMany({
        where: { workId: work.id },
      });
      let opened = await reviews.open(applicant.id, work.id, {
        ...mutation(before.revision, before.editorEpoch),
        reason: "是否符合组内规定",
      });
      const restored = await reviews.resolve(admin.id, opened.id, {
        ...mutation(opened.workRevision, opened.editorEpoch),
        resolution: "continue_production",
      });
      const after = await tx.work.findUniqueOrThrow({ where: { id: work.id } });
      const business = (record: typeof before) =>
        Object.fromEntries(
          Object.entries(record).filter(
            ([key]) => !["revision", "editorEpoch", "updatedAt"].includes(key),
          ),
        );
      assert.deepEqual(business(after), business(before));
      assert.deepEqual(
        await tx.workStageParticipant.findMany({
          where: { workId: work.id },
          orderBy: { id: "asc" },
        }),
        people,
      );
      assert.deepEqual(
        await tx.workCreditAlias.findMany({ where: { workId: work.id } }),
        alias,
      );
      assert.equal(
        await tx.translationVersion.count({ where: { workId: work.id } }),
        1,
      );
      assert.equal(
        await tx.workReviewRevision.count({ where: { workId: work.id } }),
        0,
      );
      assert.equal(after.typesetReviewRequired, false);
      assert.equal(after.requiredHandoffVersionId, null);
      if (phase === "typesetting") {
        const downloaded = await typesetting.readHandoffPackage(
          other.id,
          work.id,
          pack.id,
        );
        assert.equal(downloaded.body.toString(), "test");
        assert.equal(
          await tx.workEvent.count({
            where: { workId: work.id, action: "typeset_handoff_started" },
          }),
          1,
        );
        const unused = await tx.typesetHandoffPackage.create({
          data: {
            workId: work.id,
            fileObjectId: file.id,
            kind: "unified_handoff",
            fileName: "unused.zip",
            imageCount: 1,
            workRevision: 0,
            editorEpoch: 0,
            idempotencyKey: randomUUID(),
            createdById: other.id,
            translationVersionId: version.id,
          },
        });
        await assert.rejects(
          typesetting.readHandoffPackage(other.id, work.id, unused.id),
          ConflictException,
        );
      }
      opened = await reviews.open(applicant.id, work.id, {
        ...mutation(restored.workRevision, restored.editorEpoch),
        reason: "再确认",
      });
      await assert.rejects(
        reviews.resolve(admin.id, opened.id, {
          ...mutation(opened.workRevision),
          resolution: "discard",
        }),
        BadRequestException,
      );
      const discarded = await reviews.resolve(admin.id, opened.id, {
        ...mutation(opened.workRevision, opened.editorEpoch),
        resolution: "discard",
        confirmDiscard: true,
      });
      assert.equal(discarded.canRestore, true);
      const back = await reviews.resolve(admin.id, opened.id, {
        ...mutation(discarded.workRevision, discarded.editorEpoch),
        resolution: "restore_production",
      });
      assert.equal(back.workflowStatus, phase);
      assert.equal(back.resolution, "discard");
      assert.equal(back.canRestore, false);
      assert.deepEqual(
        business(await tx.work.findUniqueOrThrow({ where: { id: work.id } })),
        business(before),
      );
      await assert.rejects(
        reviews.resolve(admin.id, opened.id, {
          ...mutation(back.workRevision, back.editorEpoch),
          resolution: "restore_production",
        }),
        ConflictException,
      );
    }
  }));

test("retired revision commands cannot grant edit rights; unchanged legacy contexts close without deleting history", async () =>
  rollbackTest(async (tx, client) => {
    const { admin, applicant, work } = await fixture(tx),
      reviews = new ReviewsService(client);
    await assert.rejects(
      reviews.open(applicant.id, work.id, {
        ...mutation(0),
        reason: "old",
        purpose: "content_revision",
      }),
      BadRequestException,
    );
    const opened = await reviews.open(applicant.id, work.id, {
      ...mutation(0),
      reason: "legacy pending case",
    });
    await assert.rejects(
      reviews.resolve(admin.id, opened.id, {
        ...mutation(1),
        resolution: "approve_revision",
      }),
      BadRequestException,
    );
    await assert.rejects(
      reviews.resolve(admin.id, opened.id, {
        ...mutation(1),
        resolution: "continue_production",
        targetWorkflowStatus: "pending_translate",
      }),
      BadRequestException,
    );
    const context = await tx.workReviewRevision.create({
      data: {
        workId: work.id,
        reviewCaseId: opened.id,
        targetStage: "translate",
        currentStage: "translate",
        returnWorkflowStatus: "translating",
        baseline: {},
        initialText: await captureRevisionText(tx, work.id),
        originalCollaborationMode: "single",
        approvedById: admin.id,
        participants: { create: { userId: applicant.id, stage: "translate" } },
      },
    });
    await tx.workReviewCase.update({
      where: { id: opened.id },
      data: { purpose: "content_revision", resolution: "approve_revision" },
    });
    assert.equal(
      (await reviews.get(opened.id, applicant.id)).canWithdraw,
      false,
    );
    await assert.rejects(
      reviews.withdraw(applicant.id, opened.id, mutation(1)),
      ConflictException,
    );
    assert.equal(
      (
        await new TranslationsService(client, {} as never).getEditor(
          applicant.id,
          work.id,
        )
      ).canEdit,
      false,
    );
    await reviews.resolve(admin.id, opened.id, {
      ...mutation(1),
      resolution: "continue_production",
    });
    assert.equal(
      (
        await tx.workReviewRevision.findUniqueOrThrow({
          where: { id: context.id },
        })
      ).status,
      "completed",
    );
    assert.equal(
      await tx.reviewRevisionParticipant.count({
        where: { revisionId: context.id },
      }),
      1,
    );
    assert.equal(await tx.workEvent.count({ where: { workId: work.id } }), 2);
  }));

test("modified legacy text is preserved and cannot be silently resumed", async () =>
  rollbackTest(async (tx, client) => {
    const { admin, applicant, work } = await fixture(tx),
      reviews = new ReviewsService(client);
    const opened = await reviews.open(applicant.id, work.id, {
      ...mutation(0),
      reason: "legacy changed case",
    });
    await tx.workReviewRevision.create({
      data: {
        workId: work.id,
        reviewCaseId: opened.id,
        targetStage: "translate",
        currentStage: "translate",
        returnWorkflowStatus: "translating",
        baseline: {},
        initialText: [{ imageId: randomUUID(), entries: [] }],
        originalCollaborationMode: "single",
        approvedById: admin.id,
      },
    });
    await assert.rejects(
      reviews.resolve(admin.id, opened.id, {
        ...mutation(1),
        resolution: "continue_production",
      }),
      ConflictException,
    );
    assert.equal((await reviews.get(opened.id)).status, "open");
    assert.equal(
      (await tx.work.findUniqueOrThrow({ where: { id: work.id } }))
        .reviewStatus,
      "needs_review",
    );
  }));

test("withdraw and admin decision race under real PostgreSQL locks with exactly one auditable winner", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  let data: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    data = await db.$transaction((tx) => fixture(tx));
    const { admin, applicant, work } = data,
      reviews = new ReviewsService(db);
    for (const resolution of ["continue_production", "discard"] as const) {
      const head = await db.work.findUniqueOrThrow({ where: { id: work.id } });
      const opened = await reviews.open(applicant.id, work.id, {
        ...mutation(head.revision, head.editorEpoch),
        reason: "Concurrent decision",
      });
      const results = await Promise.allSettled([
        reviews.withdraw(
          applicant.id,
          opened.id,
          mutation(opened.workRevision, opened.editorEpoch),
        ),
        reviews.resolve(admin.id, opened.id, {
          ...mutation(opened.workRevision, opened.editorEpoch),
          resolution,
          confirmDiscard: true,
        }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const loser = results.find((r) => r.status === "rejected");
      assert(
        loser?.status === "rejected" &&
          loser.reason instanceof ConflictException,
      );
      const final = await reviews.get(opened.id);
      assert.equal(final.status, "resolved");
      assert.equal(
        await db.workEvent.count({
          where: {
            workId: work.id,
            action: { in: ["review_withdrawn", "review_resumed", "archived"] },
            createdAt: { gte: new Date(opened.createdAt) },
          },
        }),
        1,
      );
      if (final.canRestore)
        await reviews.resolve(admin.id, final.id, {
          ...mutation(final.workRevision, final.editorEpoch),
          resolution: "restore_production",
        });
    }
  } finally {
    if (data) {
      const { admin, applicant, other, author, candidate, work } = data;
      await db.$transaction(async (tx) => {
        await tx.work.update({
          where: { id: work.id },
          data: { discardedReviewCaseId: null },
        });
        await tx.workEvent.deleteMany({ where: { workId: work.id } });
        await tx.workReviewCase.deleteMany({ where: { workId: work.id } });
        await tx.workStageParticipant.deleteMany({
          where: { workId: work.id },
        });
        await tx.work.delete({ where: { id: work.id } });
        await tx.candidatePost.delete({ where: { id: candidate.id } });
        await tx.author.delete({ where: { id: author.id } });
        const ids = [admin.id, applicant.id, other.id];
        await tx.userRole.deleteMany({ where: { userId: { in: ids } } });
        await tx.userLanguageCapability.deleteMany({
          where: { userId: { in: ids } },
        });
        await tx.user.deleteMany({ where: { id: { in: ids } } });
      });
    }
    await db.$disconnect();
  }
});
