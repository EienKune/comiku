import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type {
  Role,
  LanguageCapability,
  WorkflowStatus,
  WorkStage,
  SourceLanguage,
} from "../../src/generated/prisma/client.js";
import {
  WorkQueryDto,
  WorkView,
  WorkPhase,
} from "../../src/works/works.dto.js";
import { WorksService } from "../../src/works/works.service.js";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("dual views enforce stage/language qualifications before counts and priority cursor pagination", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const rollback = new Error("rollback dual view fixtures");
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          const service = new WorksService(
            tx as never,
            {} as never,
            {} as never,
          );
          async function member(
            roles: Role[],
            languages: LanguageCapability[] = [],
          ) {
            return tx.user.create({
              data: {
                username: `view_${randomUUID()}`,
                displayName: "fixture",
                passwordHash: "not-for-login",
                mustChangePassword: false,
                roles: { create: roles.map((role) => ({ role })) },
                languageCapabilities: {
                  create: languages.map((language) => ({ language })),
                },
              },
            });
          }
          const proof = await member(["proofreader"], ["ja"]);
          const both = await member(
            ["translator", "proofreader"],
            ["ja", "ko"],
          );
          const typesetter = await member(["typesetter"]);
          const admin = await member(["admin"], ["ja", "ko"]);
          const operator = await member(["operator"]);
          const source = await member(["source"]);
          const author = await tx.author.create({
            data: { displayName: "Dual view author" },
          });
          async function work(
            status: WorkflowStatus,
            language: SourceLanguage = "ja",
            owner?: { id: string; stage: WorkStage; submitted?: boolean },
            fields: {
              reviewStatus?: "normal" | "blocked" | "needs_review";
              collaborationMode?: "single" | "multi";
            } = {},
          ) {
            const candidate = await tx.candidatePost.create({
              data: {
                authorId: author.id,
                platform: "fixture",
                externalPostId: randomUUID(),
                postedAt: new Date(),
                rawJson: {},
              },
            });
            return tx.work.create({
              data: {
                authorId: author.id,
                sourceCandidatePostId: candidate.id,
                importedById: source.id,
                title: "Shared view",
                workflowStatus: status,
                sourceLanguage: language,
                ...fields,
                ...(owner
                  ? {
                      stageParticipants: {
                        create: {
                          userId: owner.id,
                          stage: owner.stage,
                          participationMode: "owner",
                          submittedAt: owner.submitted ? new Date() : null,
                        },
                      },
                    }
                  : {}),
              },
            });
          }
          const ready = [];
          for (let i = 0; i < 25; i++)
            ready.push(await work("pending_proofread"));
          const future = [];
          for (let i = 0; i < 5; i++)
            future.push(
              await work("pending_translate", "ja", {
                id: source.id,
                stage: "translate",
              }),
            );
          const korean = await work("pending_proofread", "ko");
          const english = await work("pending_proofread", "en");
          const conflict = await work("pending_proofread", "ja", {
            id: both.id,
            stage: "translate",
            submitted: true,
          });
          const multi = await work(
            "pending_proofread",
            "ja",
            { id: both.id, stage: "translate", submitted: true },
            { collaborationMode: "multi" },
          );
          const occupied = await work(
            "pending_proofread",
            "ja",
            { id: source.id, stage: "proofread" },
            { collaborationMode: "multi" },
          );
          const abnormal = await work("pending_proofread", "ja", undefined, {
            reviewStatus: "needs_review",
          });
          const archived = await work("archived");
          const published = await work("published");
          const skipped = await work("pending_typeset");
          const version = await tx.translationVersion.create({
            data: {
              workId: skipped.id,
              versionNumber: 1,
              kind: "proofread_submission",
              stage: "proofread",
              workRevision: 0,
              editorEpoch: 1,
              createdById: both.id,
              proofreadSkipped: true,
            },
          });
          await tx.work.update({
            where: { id: skipped.id },
            data: { proofreadSkippedVersionId: version.id },
          });
          const publishJa = await work("pending_publish");
          const publishKo = await work("pending_publish", "ko");
          await work("pending_publish", "en", undefined, {
            reviewStatus: "blocked",
          });
          const list = (actor = proof.id, query: Partial<WorkQueryDto> = {}) =>
            service.list(
              actor,
              Object.assign(new WorkQueryDto(), { authorId: author.id }, query),
            );
          const all = await list(source.id, { limit: 100 });
          assert.ok(all.items.some((item) => item.id === korean.id));
          assert.ok(all.items.some((item) => item.id === published.id));
          assert.ok(!all.items.some((item) => item.id === archived.id));
          assert.deepEqual(all.claimCounts, []);
          assert.equal(all.publishTotal, 0);
          const first = await list(proof.id, {
            view: WorkView.recommended,
            claimStage: "proofread",
            limit: 24,
          });
          assert.equal(first.items.length, 24);
          assert.equal(first.total, 33);
          assert.equal(
            first.claimCounts.find((count) => count.stage === "proofread")
              ?.count,
            33,
          );
          assert.deepEqual(
            first.claimCounts.map((count) => count.stage),
            ["proofread"],
          );
          assert.ok(
            first.items.every(
              (item) =>
                item.personalTasks?.length === 1 &&
                item.personalTasks[0].stage === "proofread" &&
                item.personalTasks[0].readyToStart,
            ),
          );
          const ids = first.items.map((item) => item.id);
          let cursor = first.nextCursor;
          while (cursor) {
            const page = await list(proof.id, {
              view: WorkView.recommended,
              claimStage: "proofread",
              limit: 3,
              cursor,
            });
            ids.push(...page.items.map((item) => item.id));
            cursor = page.nextCursor;
          }
          assert.equal(new Set(ids).size, 33);
          for (const excluded of [
            korean,
            occupied,
            abnormal,
            archived,
            published,
            skipped,
          ])
            assert.ok(!ids.includes(excluded.id));
          assert.deepEqual(
            ids.slice(-5),
            future.toReversed().map((item) => item.id),
          );
          const ja = await list(proof.id, {
            view: WorkView.recommended,
            claimStage: "proofread",
            sourceLanguage: "ja",
            limit: 100,
          });
          assert.equal(ja.total, 32);
          const ko = await list(proof.id, {
            view: WorkView.recommended,
            claimStage: "proofread",
            sourceLanguage: "ko",
          });
          assert.equal(ko.total, 0);
          assert.equal(ko.claimCounts[0].count, 0);
          const dual = await list(both.id, {
            view: WorkView.recommended,
            claimStage: "proofread",
            limit: 100,
          });
          assert.ok(!dual.items.some((item) => item.id === conflict.id));
          assert.ok(dual.items.some((item) => item.id === multi.id));
          assert.ok(dual.items.some((item) => item.id === korean.id));
          const enTranslation = await work("pending_translate", "en");
          const en = await list(typesetter.id, {
            view: WorkView.recommended,
            claimStage: "translate",
            limit: 100,
          });
          assert.deepEqual(
            en.items.map((item) => item.id),
            [enTranslation.id],
          );
          assert.deepEqual(
            en.claimCounts.map((count) => count.stage),
            ["translate", "typeset"],
          );
          assert.equal(
            (
              await list(typesetter.id, {
                view: WorkView.recommended,
                claimStage: "translate",
                sourceLanguage: "ja",
              })
            ).total,
            0,
          );
          assert.equal(
            (
              await list(typesetter.id, {
                view: WorkView.recommended,
                claimStage: "proofread",
              })
            ).total,
            0,
          );
          const typeset = await list(typesetter.id, {
            view: WorkView.recommended,
            claimStage: "typeset",
            limit: 100,
          });
          assert.ok(typeset.items.some((item) => item.id === korean.id));
          assert.equal(
            (
              await list(admin.id, {
                view: WorkView.recommended,
                claimStage: "translate",
              })
            ).total,
            0,
          );
          assert.deepEqual((await list(admin.id)).claimCounts, []);
          assert.deepEqual(
            (await list(operator.id, { view: WorkView.publish })).items.map(
              (item) => item.id,
            ),
            [publishKo.id, publishJa.id],
          );
          assert.equal(
            (await list(admin.id, { view: WorkView.publish })).publishTotal,
            2,
          );
          assert.equal(
            (await list(source.id, { view: WorkView.publish })).total,
            0,
          );
          assert.equal(
            (
              await list(proof.id, {
                view: WorkView.recommended,
                claimStage: "proofread",
                search: `#${english.workNumber}`,
              })
            ).total,
            1,
          );
          const readingKo = await list(proof.id, {
            phase: WorkPhase.proofread,
            sourceLanguage: "ko",
          });
          assert.equal(readingKo.total, 1);
          await assert.rejects(
            list(proof.id, {
              view: WorkView.recommended,
              claimStage: "proofread",
              cursor: abnormal.id,
            }),
            ConflictException,
          );
          await assert.rejects(
            list(proof.id, { claimStage: "proofread" }),
            BadRequestException,
          );
          await tx.userRole.deleteMany({ where: { userId: proof.id } });
          assert.equal(
            (
              await list(proof.id, {
                view: WorkView.recommended,
                claimStage: "proofread",
              })
            ).total,
            0,
          );
          throw rollback;
        },
        { timeout: 30000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});
