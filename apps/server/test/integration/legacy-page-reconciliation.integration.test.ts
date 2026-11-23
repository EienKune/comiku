import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type {
  WorkflowStatus,
  WorkCollaborationMode,
} from "../../src/generated/prisma/client.js";
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Disposable TEST_DATABASE_URL required");

test("additive legacy reconciliation restores only proven ownership and rolls every synthetic fact back", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const rollback = new Error("rollback reconciliation fixture matrix");
  const sql = await readFile(
    new URL(
      "../../prisma/migrations/20261120120000_reconcile_legacy_page_ownership/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const statements = sql
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          const user = await tx.user.create({
            data: {
              username: `migration_${randomUUID()}`,
              displayName: "Synthetic owner",
              passwordHash: "not-a-login",
              roles: {
                create: [
                  { role: "translator" },
                  { role: "proofreader" },
                  { role: "typesetter" },
                ],
              },
              languageCapabilities: { create: { language: "ja" } },
            },
          });
          const other = await tx.user.create({
            data: {
              username: `migration_${randomUUID()}`,
              displayName: "Other owner",
              passwordHash: "not-a-login",
              roles: { create: { role: "translator" } },
              languageCapabilities: { create: { language: "ja" } },
            },
          });
          const author = await tx.author.create({
            data: { displayName: "Synthetic migration author" },
          });
          const file = await tx.fileObject.create({
            data: {
              objectKey: `migration/${randomUUID()}`,
              bucketScope: "source",
              kind: "fixture",
              contentType: "image/png",
              size: 1n,
              checksum: "0".repeat(64),
            },
          });
          async function work(
            label: string,
            mode: WorkCollaborationMode = "multi",
            status: WorkflowStatus = "pending_translate",
            pageCount = 1,
          ) {
            const post = await tx.candidatePost.create({
              data: {
                authorId: author.id,
                platform: "fixture",
                externalPostId: randomUUID(),
                postedAt: new Date(),
                rawJson: { fixture: true },
              },
            });
            const row = await tx.work.create({
              data: {
                authorId: author.id,
                sourceCandidatePostId: post.id,
                importedById: user.id,
                title: label,
                sourceLanguage: "ja",
                collaborationMode: mode,
                workflowStatus: status,
                collaborationMigrationIssue:
                  status === "published"
                    ? null
                    : "Legacy collaboration or completed-stage facts require ownership review",
                images: {
                  create: Array.from(
                    { length: pageCount },
                    (_, orderIndex) => ({
                      originalFileObjectId: file.id,
                      orderIndex,
                    }),
                  ),
                },
              },
              include: { images: { orderBy: { orderIndex: "asc" } } },
            });
            if (status !== "published")
              await tx.workPageAssignment.createMany({
                data: row.images.flatMap((image) =>
                  (["translate", "typeset"] as const).map((stage) => ({
                    workId: row.id,
                    workImageId: image.id,
                    stage,
                  })),
                ),
              });
            return row;
          }
          const empty = await work("pristine multi");
          const unique = await work(
            "unique current multi",
            "multi",
            "translating",
            2,
          );
          const uniqueOwners = await Promise.all(
            [user, other].map((person) =>
              tx.workStageParticipant.create({
                data: {
                  workId: unique.id,
                  userId: person.id,
                  stage: "translate",
                  participationMode: "collaborator",
                },
              }),
            ),
          );
          for (let index = 0; index < 2; index++)
            await tx.workStageAssignment.create({
              data: {
                participantId: uniqueOwners[index].id,
                workImageId: unique.images[index].id,
                assignedById: user.id,
              },
            });
          const draft = await tx.translationEntry.create({
            data: {
              workImageId: unique.images[0].id,
              orderIndex: 0,
              markerX: 0.2,
              markerY: 0.3,
              markerPositionType: "inside",
              translatedText: "Preserved unique owner draft",
              creationIdempotencyKey: randomUUID(),
              createdById: user.id,
              updatedById: user.id,
            },
          });
          const overlap = await work("ambiguous overlap");
          for (const person of [user, other]) {
            const participant = await tx.workStageParticipant.create({
              data: {
                workId: overlap.id,
                userId: person.id,
                stage: "translate",
                participationMode: "collaborator",
              },
            });
            await tx.workStageAssignment.create({
              data: {
                participantId: participant.id,
                workImageId: overlap.images[0].id,
                assignedById: user.id,
              },
            });
          }
          const formal = await work(
            "proven single formal",
            "single",
            "pending_proofread",
          );
          const submittedAt = new Date();
          const single = await tx.workStageParticipant.create({
            data: {
              workId: formal.id,
              userId: user.id,
              stage: "translate",
              participationMode: "owner",
              submittedAt,
            },
          });
          const version = await tx.translationVersion.create({
            data: {
              workId: formal.id,
              versionNumber: 1,
              kind: "translate_submission",
              stage: "translate",
              workRevision: 1,
              editorEpoch: 1,
              createdById: user.id,
              contributorUserIds: [user.id],
              entries: {
                create: {
                  workImageId: formal.images[0].id,
                  orderIndex: 0,
                  markerX: 0.2,
                  markerY: 0.3,
                  markerPositionType: "inside",
                  translatedText: "Immutable formal translation",
                },
              },
            },
            include: { entries: true },
          });
          await tx.workEvent.create({
            data: {
              workId: formal.id,
              actorId: user.id,
              action: "stage_submitted",
              detail: {
                stage: "translate",
                participantIds: [single.id],
                translationVersionId: version.id,
              },
            },
          });
          const missing = await work(
            "unproven completed single",
            "single",
            "pending_proofread",
          );
          await tx.workStageParticipant.create({
            data: {
              workId: missing.id,
              userId: user.id,
              stage: "translate",
              participationMode: "owner",
              submittedAt,
            },
          });
          const published = await work(
            "historical published snapshot",
            "single",
            "published",
          );
          const output = await tx.typesetImageVersion.create({
            data: {
              workId: published.id,
              versionNumber: 1,
              idempotencyKey: randomUUID(),
              uploadedById: user.id,
              images: {
                create: {
                  workImageId: published.images[0].id,
                  fileObjectId: file.id,
                  sourceName: "fixture.png",
                  width: 1,
                  height: 1,
                  orderIndex: 0,
                },
              },
            },
          });
          const publication = await tx.publishRecord.create({
            data: {
              workId: published.id,
              typesetVersionId: output.id,
              templateNameSnapshot: "Synthetic",
              templateRevision: 0,
              templateContentSnapshot: "",
              generatedTextSnapshot: "Published immutable",
              translationCreditsSnapshot: ["Historic translator"],
              proofreadCreditsSnapshot: ["Historic proofreader"],
              typesetCreditsSnapshot: ["Historic typesetter"],
              idempotencyKey: randomUUID(),
              publishedById: user.id,
            },
          });
          const cleared = await work(
            "cleared current draft retains start history",
          );
          const oldStart = new Date("2026-10-01T00:00:00Z");
          await tx.workEvent.create({
            data: {
              workId: cleared.id,
              actorId: user.id,
              action: "stage_started",
              createdAt: oldStart,
              detail: { stage: "translate" },
            },
          });
          const noPages = await work(
            "missing originals",
            "multi",
            "pending_translate",
            0,
          );
          const originalIds = [
            empty,
            unique,
            overlap,
            formal,
            missing,
            published,
            cleared,
            noPages,
          ].flatMap((w) => w.images.map((i) => i.id));
          for (const statement of statements)
            await tx.$executeRawUnsafe(statement);
          const emptyAfter = await tx.work.findUniqueOrThrow({
            where: { id: empty.id },
          });
          assert.equal(emptyAfter.collaborationMigrationIssue, null);
          assert.equal(emptyAfter.productionStartedAt, null);
          assert.equal(
            await tx.workPageAssignment.count({
              where: { workId: empty.id, participantId: { not: null } },
            }),
            0,
          );
          const uniqueAfter = await tx.work.findUniqueOrThrow({
            where: { id: unique.id },
          });
          assert.equal(uniqueAfter.collaborationMigrationIssue, null);
          const migrated = await tx.workPageAssignment.findMany({
            where: { workId: unique.id, stage: "translate" },
            orderBy: { workImage: { orderIndex: "asc" } },
          });
          assert.deepEqual(
            migrated.map((p) => p.participantId),
            uniqueOwners.map((p) => p.id),
          );
          assert.ok(
            migrated.every(
              (p) =>
                p.generation === 1 &&
                p.submittedAt === null &&
                p.submittedRevision === null &&
                p.submittedGeneration === null,
            ),
            "legacy multi assignments never synthesize delivery",
          );
          assert.equal(
            (
              await tx.translationEntry.findUniqueOrThrow({
                where: { id: draft.id },
              })
            ).translatedText,
            draft.translatedText,
          );
          const held = await tx.work.findUniqueOrThrow({
            where: { id: overlap.id },
          });
          assert.match(held.collaborationMigrationIssue ?? "", /重叠负责人/);
          assert.equal(
            await tx.workPageAssignment.count({
              where: { workId: overlap.id, participantId: { not: null } },
            }),
            0,
          );
          const formalAfter = await tx.work.findUniqueOrThrow({
            where: { id: formal.id },
          });
          assert.equal(formalAfter.collaborationMigrationIssue, null);
          const restored = await tx.workPageAssignment.findUniqueOrThrow({
            where: {
              workImageId_stage: {
                workImageId: formal.images[0].id,
                stage: "translate",
              },
            },
          });
          assert.equal(restored.participantId, single.id);
          assert.equal(
            restored.submittedAt?.toISOString(),
            submittedAt.toISOString(),
          );
          assert.equal(restored.submittedRevision, restored.draftRevision);
          assert.equal(restored.submittedGeneration, restored.generation);
          assert.deepEqual(
            await tx.translationVersion.findUniqueOrThrow({
              where: { id: version.id },
              include: { entries: true },
            }),
            version,
          );
          assert.match(
            (await tx.work.findUniqueOrThrow({ where: { id: missing.id } }))
              .collaborationMigrationIssue ?? "",
            /正式快照/,
          );
          assert.deepEqual(
            await tx.publishRecord.findUniqueOrThrow({
              where: { id: publication.id },
            }),
            publication,
          );
          assert.equal(
            await tx.workPageAssignment.count({
              where: { workId: published.id },
            }),
            0,
          );
          const clearedAfter = await tx.work.findUniqueOrThrow({
            where: { id: cleared.id },
          });
          assert.equal(clearedAfter.collaborationMigrationIssue, null);
          assert.equal(
            clearedAfter.productionStartedAt?.toISOString(),
            oldStart.toISOString(),
          );
          assert.equal(
            await tx.translationEntry.count({
              where: { workImage: { workId: cleared.id } },
            }),
            0,
          );
          assert.match(
            (await tx.work.findUniqueOrThrow({ where: { id: noPages.id } }))
              .collaborationMigrationIssue ?? "",
            /缺少有效原稿页/,
          );
          assert.equal(
            await tx.workImage.count({ where: { id: { in: originalIds } } }),
            originalIds.length,
            "original identities are untouched",
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
