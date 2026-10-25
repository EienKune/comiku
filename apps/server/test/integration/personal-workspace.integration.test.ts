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
import {
  type Role,
  type WorkflowStatus,
  type WorkStage,
} from "../../src/generated/prisma/client.js";
import {
  WorkQueryDto,
  WorkView,
  WorkPhase,
} from "../../src/works/works.dto.js";
import { WorksService } from "../../src/works/works.service.js";
import { TypesettingService } from "../../src/typesetting/typesetting.service.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must select a disposable _test database.");

test("personal discovery filters before pagination, preserves stage history and rechecks qualifications", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const rollback = new Error("intentional personal workspace fixture rollback");
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          const user = await tx.user.create({
            data: {
              username: `personal_${randomUUID()}`,
              displayName: "Personal fixture",
              passwordHash: "non-login-fixture",
              roles: {
                create: (
                  ["translator", "proofreader", "typesetter"] as Role[]
                ).map((role) => ({ role })),
              },
              languageCapabilities: { create: { language: "ja" } },
            },
          });
          const admin = await tx.user.create({
            data: {
              username: `admin_${randomUUID()}`,
              displayName: "Admin fixture",
              passwordHash: "non-login-fixture",
              roles: { create: { role: "admin" } },
              languageCapabilities: { create: { language: "ja" } },
            },
          });
          const other = await tx.user.create({
            data: {
              username: `other_${randomUUID()}`,
              displayName: "Other fixture",
              passwordHash: "non-login-fixture",
            },
          });
          const author = await tx.author.create({
            data: { displayName: "Personal fixture author" },
          });
          const service = new WorksService(
            tx as never,
            {} as never,
            {} as never,
          );
          function list(
            view?: WorkView,
            fields: Partial<WorkQueryDto> = {},
            actor = user.id,
          ) {
            return service.list(
              actor,
              Object.assign(
                new WorkQueryDto(),
                { authorId: author.id, view },
                fields,
              ),
            );
          }
          async function work(
            status: WorkflowStatus,
            stage?: WorkStage,
            options: {
              submitted?: boolean;
              left?: boolean;
              language?: "ja" | "ko" | "en";
              review?: "normal" | "needs_review" | "blocked";
              other?: boolean;
              multi?: boolean;
            } = {},
          ) {
            const candidate = await tx.candidatePost.create({
              data: {
                authorId: author.id,
                platform: "fixture",
                externalPostId: randomUUID(),
                postedAt: new Date(),
                rawJson: { fixture: true },
              },
            });
            return tx.work.create({
              data: {
                authorId: author.id,
                sourceCandidatePostId: candidate.id,
                importedById: user.id,
                title: "Personal task",
                workflowStatus: status,
                sourceLanguage: options.language ?? "ja",
                reviewStatus: options.review ?? "normal",
                collaborationMode: options.multi ? "multi" : "single",
                ...(stage
                  ? {
                      stageParticipants: {
                        create: {
                          userId: options.other ? other.id : user.id,
                          stage,
                          participationMode: "owner",
                          submittedAt: options.submitted ? new Date() : null,
                          leftAt: options.left ? new Date() : null,
                        },
                      },
                    }
                  : {}),
              },
              include: { stageParticipants: true },
            });
          }
          const todos = [];
          for (let index = 0; index < 26; index++)
            todos.push(
              await work(
                index % 2 ? "translating" : "pending_translate",
                "translate",
              ),
            );
          const proof = await work("pending_proofread", "proofread");
          const typeset = await work("pending_typeset", "typeset");
          const blocked = await work("typesetting", "typeset", {
            review: "blocked",
          });
          const multi = await work("translating", "translate", { multi: true });
          const file = await tx.fileObject.create({
            data: {
              objectKey: `test/${randomUUID()}`,
              bucketScope: "source",
              kind: "fixture",
              contentType: "image/png",
              size: 24n,
              checksum: "0".repeat(64),
              createdById: user.id,
            },
          });
          const image = await tx.workImage.create({
            data: {
              workId: multi.id,
              originalFileObjectId: file.id,
              orderIndex: 0,
            },
          });
          const typesetting = new TypesettingService(
            tx as never,
            {} as never,
            {} as never,
          );
          const allTypeset = [typeset, blocked];
          for (let index = 0; index < 26; index++)
            allTypeset.push(await work("pending_typeset", "typeset"));
          for (const row of allTypeset)
            await tx.workImage.create({
              data: {
                workId: row.id,
                originalFileObjectId: file.id,
                orderIndex: 0,
              },
            });
          const manifest = await typesetting.handoffManifest(user.id);
          assert.equal(manifest.items.length, 28);
          assert.equal(
            manifest.items.find((item) => item.workId === blocked.id)
              ?.canDownload,
            false,
          );
          assert.equal(
            (await tx.work.findUniqueOrThrow({ where: { id: typeset.id } }))
              .typesetHandoffStartedAt,
            null,
          );
          assert.equal(
            await tx.workEvent.count({
              where: { workId: { in: allTypeset.map((row) => row.id) } },
            }),
            0,
          );
          await assert.rejects(
            typesetting.handoffManifest(admin.id),
            ForbiddenException,
          );
          await tx.workStageParticipant.updateMany({
            where: { workId: { in: allTypeset.slice(2).map((row) => row.id) } },
            data: { leftAt: new Date() },
          });
          await tx.work.updateMany({
            where: { id: { in: allTypeset.slice(2).map((row) => row.id) } },
            data: { workflowStatus: "archived" },
          });
          const participantId = multi.stageParticipants[0].id;
          await tx.workStageAssignment.create({
            data: {
              participantId,
              workImageId: image.id,
              assignedById: user.id,
            },
          });
          await tx.stageContributionSubmission.create({
            data: {
              participantId,
              createdById: user.id,
              idempotencyKey: randomUUID(),
              pages: { create: { workImageId: image.id, imageRevision: 0 } },
            },
          });
          const future = await work("translating", "typeset");
          const submitted = await work("pending_proofread", "translate", {
            submitted: true,
          });
          const left = await work("translating", "translate", { left: true });
          const wrongLanguage = await work("translating", "translate", {
            language: "ko",
          });
          const published = await work("published", "typeset");
          await work("archived", "typeset");
          const first = await list(WorkView.todo);
          assert.equal(first.total, 30);
          assert.equal(first.todoTotal, 30);
          assert.equal(first.items.length, 24);
          assert.equal(first.items[0].id, multi.id);
          assert.equal(
            first.items[0].personalTasks?.[0].contributionCurrent,
            true,
          );
          const second = await list(WorkView.todo, {
            cursor: first.nextCursor!,
          });
          assert.equal(second.items.length, 6);
          assert.equal(second.nextCursor, null);
          const ids = [...first.items, ...second.items].map(({ id }) => id);
          assert.equal(new Set(ids).size, 30);
          for (const excluded of [
            future,
            submitted,
            left,
            wrongLanguage,
            published,
          ])
            assert.ok(!ids.includes(excluded.id));
          for (const included of [proof, typeset, blocked])
            assert.ok(ids.includes(included.id));
          assert.ok(
            first.phaseCounts.reduce((sum, item) => sum + item.count, 0) >
              first.todoTotal,
          );
          await tx.workImage.update({
            where: { id: image.id },
            data: { translationRevision: 1 },
          });
          assert.equal(
            (await list(WorkView.todo)).items[0].personalTasks?.[0]
              .contributionCurrent,
            false,
          );

          const ready = await work("pending_proofread");
          const occupiedMulti = await work("pending_proofread", "proofread", {
            other: true,
            multi: true,
          });
          const waiting = await work("pending_translate", "translate", {
            other: true,
          });
          await work("pending_translate", undefined, {
            review: "needs_review",
          });
          const recommendations = await list(WorkView.recommended, {
            limit: 100,
          });
          assert.ok(
            !recommendations.items.some(
              ({ id }) =>
                id === occupiedMulti.id &&
                recommendations.items
                  .find((item) => item.id === id)
                  ?.personalTasks?.some(({ stage }) => stage === "proofread"),
            ),
          );
          assert.ok(
            recommendations.items
              .find(({ id }) => id === ready.id)
              ?.personalTasks?.some(
                ({ stage, readyToStart }) =>
                  stage === "proofread" && readyToStart,
              ),
          );
          assert.ok(
            recommendations.items
              .find(({ id }) => id === waiting.id)
              ?.personalTasks?.every(({ readyToStart }) => !readyToStart),
          );
          assert.ok(
            !recommendations.items
              .find(({ id }) => id === submitted.id)
              ?.personalTasks?.some(({ stage }) => stage === "proofread"),
          );
          const lastReadyIndex = recommendations.items.findLastIndex((item) =>
            item.personalTasks?.some(({ readyToStart }) => readyToStart),
          );
          assert.ok(
            recommendations.items
              .slice(lastReadyIndex + 1)
              .every((item) =>
                item.personalTasks?.every(({ readyToStart }) => !readyToStart),
              ),
          );
          const recommendationIds = [];
          let cursor: string | undefined;
          do {
            const page = await list(WorkView.recommended, { limit: 3, cursor });
            recommendationIds.push(...page.items.map(({ id }) => id));
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          assert.deepEqual(
            recommendationIds,
            recommendations.items.map(({ id }) => id),
          );
          await assert.rejects(
            list(WorkView.todo, { cursor: future.id }),
            ConflictException,
          );
          assert.equal((await list(WorkView.todo, {}, admin.id)).total, 0);
          assert.equal(
            (await list(WorkView.recommended, {}, admin.id)).total,
            0,
          );
          await assert.rejects(
            service.claimStage(admin.id, ready.id, {
              stage: "proofread",
              expectedRevision: ready.revision,
              idempotencyKey: randomUUID(),
            }),
            ForbiddenException,
          );
          await tx.userLanguageCapability.deleteMany({
            where: { userId: user.id },
          });
          assert.equal((await list(WorkView.todo)).total, 2);
          const english = await work("pending_translate", "translate", {
            language: "en",
          });
          assert.ok(
            (await list(WorkView.todo)).items.some(
              ({ id }) => id === english.id,
            ),
          );
          await tx.userRole.deleteMany({
            where: { userId: user.id, role: "typesetter" },
          });
          assert.equal((await list(WorkView.todo)).total, 1);
          await tx.user.update({
            where: { id: user.id },
            data: { isActive: false },
          });
          assert.equal((await list(WorkView.todo)).total, 0);
          assert.equal((await list(WorkView.recommended)).total, 0);
          const phase = await list(undefined, {
            phase: WorkPhase.translation,
            limit: 2,
          });
          assert.equal(phase.items.length, 2);
          assert.ok(
            phase.items.every(({ workflowStatus }) =>
              ["pending_translate", "translating"].includes(workflowStatus),
            ),
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
