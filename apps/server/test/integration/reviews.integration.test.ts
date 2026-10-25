import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { ReviewsService } from "../../src/reviews/reviews.service.js";
import { WorksService } from "../../src/works/works.service.js";
import { TranslationsService } from "../../src/translations/translations.service.js";
import { TypesettingService } from "../../src/typesetting/typesetting.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("production review pauses every mutation, preserves results through continue/discard/restore and invalidates epochs", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  const rollback = new Error("review fixture rollback");
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          const client = new Proxy(tx, {
            get(target, property) {
              if (property === "$transaction")
                return (fn: (tx: Prisma.TransactionClient) => unknown) =>
                  fn(tx);
              return Reflect.get(target, property);
            },
          }) as unknown as PrismaService;
          async function user(
            role: "admin" | "translator" | "reviewer" | "typesetter",
          ) {
            return tx.user.create({
              data: {
                username: `review_${randomUUID()}`,
                displayName: role,
                passwordHash: "non-login-fixture",
                mustChangePassword: false,
                roles: { create: { role } },
                languageCapabilities: { create: { language: "ja" } },
              },
            });
          }
          const admin = await user("admin"),
            translator = await user("translator"),
            reviewer = await user("reviewer"),
            typesetter = await user("typesetter");
          const author = await tx.author.create({
            data: { displayName: "Review fixture" },
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
              title: "Review fixture",
              workflowStatus: "translating",
              stageParticipants: {
                create: [
                  {
                    userId: translator.id,
                    stage: "translate",
                    participationMode: "owner",
                  },
                  {
                    userId: typesetter.id,
                    stage: "typeset",
                    participationMode: "owner",
                  },
                ],
              },
            },
          });
          const file = await tx.fileObject.create({
            data: {
              objectKey: `test/${randomUUID()}`,
              bucketScope: "works",
              kind: "fixture",
              contentType: "image/png",
              size: 24,
              checksum: "0".repeat(64),
            },
          });
          const image = await tx.workImage.create({
            data: {
              workId: work.id,
              originalFileObjectId: file.id,
              orderIndex: 0,
            },
          });
          const marker = await tx.translationEntry.create({
            data: {
              workImageId: image.id,
              orderIndex: 0,
              markerX: 0.5,
              markerY: 0.5,
              markerPositionType: "inside",
              translatedText: "保留的成果",
              creationIdempotencyKey: randomUUID(),
              createdById: translator.id,
              updatedById: translator.id,
            },
          });
          const translations = new TranslationsService(client, {} as never);
          const works = new WorksService(client, {} as never, translations);
          const typeset = new TypesettingService(
            client,
            {} as never,
            translations,
          );
          const reviews = new ReviewsService(client);
          const mutation = (revision: number) => ({
            expectedRevision: revision,
            idempotencyKey: randomUUID(),
          });
          const opened = await reviews.open(translator.id, work.id, {
            ...mutation(0),
            purpose: "production_decision",
            reason: "是否继续",
            expectedEditorEpoch: 0,
          });
          assert.equal(opened.editorEpoch, 1);
          assert.equal(
            (await translations.getEditor(translator.id, work.id)).canEdit,
            false,
          );
          assert.equal(
            (await translations.getEditor(translator.id, work.id))
              .joinableStage,
            null,
          );
          for (const attempt of [
            () =>
              works.update(admin.id, work.id, {
                ...mutation(1),
                title: "不允许",
              }),
            () =>
              works.updateCollaboration(admin.id, work.id, {
                ...mutation(1),
                collaborationMode: "multi",
              }),
            () =>
              works.updateStageCredit(translator.id, work.id, {
                ...mutation(1),
                stage: "translate",
                creditName: "新署名",
              }),
            () =>
              works.leaveStage(translator.id, work.id, {
                ...mutation(1),
                stage: "translate",
              }),
            () =>
              works.claimStage(reviewer.id, work.id, {
                ...mutation(1),
                stage: "typeset",
              }),
            () => works.archive(admin.id, work.id, mutation(1)),
            () =>
              translations.updateEntry(translator.id, marker.id, {
                expectedRevision: 0,
                expectedEditorEpoch: 1,
                translatedText: "不允许",
              }),
            () =>
              translations.createEntry(translator.id, image.id, {
                expectedImageRevision: 0,
                expectedEditorEpoch: 1,
                idempotencyKey: randomUUID(),
                markerX: 0.2,
                markerY: 0.3,
                markerPositionType: "inside",
              }),
            () =>
              translations.beginTypesetHandoff(typesetter.id, work.id, {
                material: "unified_handoff",
                fileId: randomUUID(),
              }),
            () =>
              typeset.createHandoffPackage(admin.id, work.id, {
                ...mutation(1),
                expectedEditorEpoch: 1,
              }),
          ])
            await assert.rejects(
              attempt,
              (error) =>
                error instanceof ConflictException ||
                error instanceof ForbiddenException,
            );
          assert.equal(
            (
              await tx.translationEntry.findUniqueOrThrow({
                where: { id: marker.id },
              })
            ).translatedText,
            "保留的成果",
          );
          await assert.rejects(
            reviews.open(translator.id, work.id, {
              ...mutation(1),
              purpose: "production_decision",
              reason: "第二事项",
            }),
            ConflictException,
          );
          await assert.rejects(
            reviews.resolve(reviewer.id, opened.id, {
              ...mutation(1),
              resolution: "continue_production",
            }),
            ForbiddenException,
          );
          const continued = await reviews.resolve(admin.id, opened.id, {
            ...mutation(1),
            resolution: "continue_production",
          });
          assert.equal(continued.workflowStatus, "translating");
          assert.equal(continued.editorEpoch, 2);
          assert.equal(
            await tx.workStageParticipant.count({
              where: { workId: work.id, leftAt: null },
            }),
            2,
          );
          const next = await reviews.open(translator.id, work.id, {
            ...mutation(2),
            purpose: "production_decision",
            reason: "舍弃复查",
            expectedEditorEpoch: 2,
          });
          const discardInput = {
            ...mutation(next.workRevision),
            resolution: "discard" as const,
            confirmDiscard: true,
            note: "确认舍弃",
          };
          const discarded = await reviews.resolve(
            admin.id,
            next.id,
            discardInput,
          );
          assert.equal(discarded.canRestore, true);
          assert.equal(discarded.workflowStatus, "archived");
          assert.equal(
            (await reviews.resolve(admin.id, next.id, discardInput))
              .workRevision,
            discarded.workRevision,
          );
          await assert.rejects(
            works.restore(admin.id, work.id, mutation(discarded.workRevision)),
            ConflictException,
          );
          await assert.rejects(
            reviews.resolve(reviewer.id, next.id, {
              ...mutation(discarded.workRevision),
              resolution: "restore_production",
              note: "恢复",
            }),
            ForbiddenException,
          );
          const restored = await reviews.resolve(admin.id, next.id, {
            ...mutation(discarded.workRevision),
            resolution: "restore_production",
            note: "确认恢复",
          });
          assert.equal(restored.workflowStatus, "translating");
          assert.equal(restored.canRestore, false);
          assert.equal(
            (await tx.work.findUniqueOrThrow({ where: { id: work.id } }))
              .workNumber,
            work.workNumber,
          );
          assert.equal(
            (
              await tx.translationEntry.findUniqueOrThrow({
                where: { id: marker.id },
              })
            ).translatedText,
            "保留的成果",
          );
          assert.equal(restored.editorEpoch, 5);
          throw rollback;
        },
        { timeout: 20000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});
