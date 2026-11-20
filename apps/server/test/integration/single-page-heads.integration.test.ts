import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictException } from "@nestjs/common";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { MemoryObjectStorage } from "../../src/files/memory-object-storage.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { TranslationsService } from "../../src/translations/translations.service.js";
import { WorksService } from "../../src/works/works.service.js";
import { translationPageHeads } from "./page-heads.js";
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable TEST_DATABASE_URL required");

test("single-person submit and legacy complete reject missing, tampered and stale exact page heads", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const rollback = new Error("rollback single exact-head fixtures");
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          const facade = new Proxy(tx, {
            get(target, key) {
              return key === "$transaction"
                ? (action: (client: Prisma.TransactionClient) => unknown) =>
                    action(tx)
                : Reflect.get(target, key);
            },
          }) as unknown as PrismaService;
          const files = new FileObjectsService(
            facade,
            new MemoryObjectStorage(),
            new JobsService(facade),
          );
          const translations = new TranslationsService(facade, files),
            works = new WorksService(facade, files, translations);
          const actor = await tx.user.create({
            data: {
              username: `single_heads_${randomUUID()}`,
              displayName: "Synthetic translator",
              passwordHash: "non-login-fixture",
              roles: { create: { role: "translator" } },
              languageCapabilities: { create: { language: "ja" } },
            },
          });
          const author = await tx.author.create({
            data: { displayName: "Synthetic exact-head author" },
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
          const file = await tx.fileObject.create({
            data: {
              objectKey: `single-heads/${randomUUID()}`,
              bucketScope: "source",
              kind: "fixture",
              contentType: "image/png",
              size: 1n,
              checksum: "0".repeat(64),
            },
          });
          const work = await tx.work.create({
            data: {
              authorId: author.id,
              sourceCandidatePostId: candidate.id,
              importedById: actor.id,
              sourceLanguage: "ja",
              images: {
                create: { originalFileObjectId: file.id, orderIndex: 0 },
              },
            },
            include: { images: true },
          });
          let head = await works.claimStage(actor.id, work.id, {
            stage: "translate",
            expectedRevision: 0,
            idempotencyKey: randomUUID(),
          });
          const input = () => ({
            stage: "translate" as const,
            expectedRevision: head.revision,
            expectedEditorEpoch: head.editorEpoch,
            idempotencyKey: randomUUID(),
          });
          const exactHeadError = (error: unknown) =>
            error instanceof ConflictException &&
            (error.getResponse() as { code?: string }).code ===
              "SUBMISSION_PAGE_HEADS_STALE";
          await assert.rejects(
            () => works.submitStage(actor.id, work.id, input()),
            exactHeadError,
          );
          await assert.rejects(
            () => works.completeStageContribution(actor.id, work.id, input()),
            exactHeadError,
          );
          const initialHeads = await translationPageHeads(
            tx,
            work.id,
            actor.id,
          );
          await assert.rejects(
            () =>
              works.submitStage(actor.id, work.id, {
                ...input(),
                pageHeads: initialHeads.map((p) => ({
                  ...p,
                  generation: p.generation + 1,
                })),
              }),
            exactHeadError,
          );
          await assert.rejects(
            () =>
              works.submitStage(actor.id, work.id, {
                ...input(),
                pageHeads: [...initialHeads, ...initialHeads],
              }),
            exactHeadError,
          );
          const created = await translations.createEntry(
            actor.id,
            work.images[0].id,
            {
              markerX: 0.2,
              markerY: 0.3,
              markerPositionType: "inside",
              expectedImageRevision: 0,
              expectedEditorEpoch: head.editorEpoch,
              idempotencyKey: randomUUID(),
            },
          );
          head = await works.get(work.id, actor.id);
          const oldHeads = await translationPageHeads(tx, work.id, actor.id),
            oldWorkRevision = head.revision;
          await translations.updateEntry(actor.id, created.entries[0].id, {
            translatedText: "Edited in another tab",
            expectedRevision: created.entries[0].revision,
            expectedEditorEpoch: head.editorEpoch,
          });
          head = await works.get(work.id, actor.id);
          assert.equal(
            head.revision,
            oldWorkRevision,
            "entry save can change exact content without work revision",
          );
          await assert.rejects(
            () =>
              works.submitStage(actor.id, work.id, {
                ...input(),
                pageHeads: oldHeads,
              }),
            exactHeadError,
          );
          await assert.rejects(
            () =>
              works.completeStageContribution(actor.id, work.id, {
                ...input(),
                pageHeads: oldHeads,
              }),
            exactHeadError,
          );
          assert.equal(
            await tx.translationVersion.count({ where: { workId: work.id } }),
            0,
          );
          assert.equal(
            await tx.workPageAssignment.count({
              where: { workId: work.id, submittedAt: { not: null } },
            }),
            0,
          );
          head = await works.completeStageContribution(actor.id, work.id, {
            ...input(),
            pageHeads: await translationPageHeads(tx, work.id, actor.id),
          });
          assert.equal(
            head.workflowStatus,
            "pending_proofread",
            "compatibility complete is the same single submit",
          );
          head = await works.cancelStageSubmission(actor.id, work.id, input());
          head = await works.submitStage(actor.id, work.id, {
            ...input(),
            pageHeads: await translationPageHeads(tx, work.id, actor.id),
          });
          assert.equal(head.workflowStatus, "pending_proofread");
          assert.equal(
            await tx.translationVersion.count({ where: { workId: work.id } }),
            2,
          );
          throw rollback;
        },
        { timeout: 20000 },
      ),
      (error) => {
        if (error !== rollback) throw error;
        return true;
      },
    );
  } finally {
    await db.$disconnect();
  }
});
