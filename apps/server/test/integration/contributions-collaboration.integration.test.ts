import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { createApplication } from "../../src/application.js";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { ContributionsService } from "../../src/dashboard/contributions.service.js";
import { ContributionQueryDto } from "../../src/dashboard/contributions.dto.js";
import { WorksService } from "../../src/works/works.service.js";
import {
  cancelTypesetPagesTx,
  submitTypesetPagesTx,
} from "../../src/typesetting/typeset-page-workflow.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

for (const stage of ["translate", "typeset"] as const)
  test(`${stage} collaboration uses effective formal rounds across asynchronous submissions, withdrawal and resubmission`, async () => {
    const app = await createApplication(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
    );
    const db = app.get(PrismaService),
      service = app.get(ContributionsService),
      works = app.get(WorksService);
    const userIds: string[] = [];
    let authorId = "",
      postId = "",
      fileId = "",
      workId = "";
    try {
      await app.init();
      for (const displayName of ["First owner", "Second owner", "Non-owner"])
        userIds.push(
          (
            await db.user.create({
              data: {
                username: `contribution_round_${randomUUID()}`,
                displayName,
                passwordHash: "synthetic-disabled-password",
                mustChangePassword: false,
                roles: {
                  create: {
                    role: stage === "translate" ? "translator" : "typesetter",
                  },
                },
                languageCapabilities: { create: { language: "ja" } },
              },
            })
          ).id,
        );
      authorId = (
        await db.author.create({ data: { displayName: "Synthetic rounds" } })
      ).id;
      postId = (
        await db.candidatePost.create({
          data: {
            authorId,
            platform: "synthetic",
            externalPostId: randomUUID(),
            postedAt: new Date(),
            rawJson: {},
          },
        })
      ).id;
      fileId = (
        await db.fileObject.create({
          data: {
            objectKey: `synthetic-contribution/${randomUUID()}`,
            bucketScope: "works",
            kind: "fixture",
            contentType: "image/png",
            checksum: "0".repeat(64),
            size: 1n,
          },
        })
      ).id;
      const work = await db.work.create({
        data: {
          authorId,
          sourceCandidatePostId: postId,
          importedById: userIds[0],
          collaborationMode: "multi",
          workflowStatus: stage === "translate" ? "translating" : "typesetting",
          typesetHandoffStartedAt: stage === "typeset" ? new Date() : null,
          images: {
            create: [0, 1].map((orderIndex) => ({
              orderIndex,
              originalFileObjectId: fileId,
            })),
          },
          stageParticipants: {
            create: userIds.map((userId) => ({
              userId,
              stage,
              participationMode: "collaborator",
            })),
          },
        },
        include: {
          images: { orderBy: { orderIndex: "asc" } },
          stageParticipants: true,
        },
      });
      workId = work.id;
      const owners = userIds
        .slice(0, 2)
        .map((id) => work.stageParticipants.find((p) => p.userId === id)!);
      await db.workPageAssignment.createMany({
        data: work.images.map((image, index) => ({
          workId,
          workImageId: image.id,
          participantId: owners[index].id,
          stage,
          generation: 1,
        })),
      });
      if (stage === "typeset")
        await db.workTypesetDraft.createMany({
          data: work.images.map((image, index) => ({
            workId,
            workImageId: image.id,
            participantId: owners[index].id,
            assignmentGeneration: 1,
            fileObjectId: fileId,
            sourceName: `${index + 1}.png`,
            width: 1,
            height: 1,
            orderIndex: index,
          })),
        });
      const submit = async (index: number) => {
        const current = await db.work.findUniqueOrThrow({
          where: { id: workId },
        });
        const pending = await db.workPageAssignment.findMany({
          where: {
            workId,
            stage,
            participantId: owners[index].id,
            submittedAt: null,
          },
        });
        const input = {
          expectedRevision: current.revision,
          expectedEditorEpoch: current.editorEpoch,
          idempotencyKey: randomUUID(),
        };
        await db.$transaction((tx) =>
          stage === "translate"
            ? works.submitStageTx(tx, userIds[index], workId, {
                ...input,
                stage,
                pageHeads: pending.map((page) => ({
                  imageId: page.workImageId,
                  generation: page.generation,
                  draftRevision: page.draftRevision,
                })),
              })
            : submitTypesetPagesTx(tx, userIds[index], workId, input),
        );
      };
      const cancel = async (index: number) => {
        const current = await db.work.findUniqueOrThrow({
          where: { id: workId },
        });
        const input = {
          stage,
          expectedRevision: current.revision,
          expectedEditorEpoch: current.editorEpoch,
          idempotencyKey: randomUUID(),
        };
        if (stage === "translate")
          await works.cancelStageSubmission(userIds[index], workId, input);
        else
          await db.$transaction((tx) =>
            cancelTypesetPagesTx(tx, userIds[index], workId, input),
          );
      };
      const achieved = async (index: number) => {
        const result = await service.summary(
          userIds[index],
          Object.assign(new ContributionQueryDto(), { period: "all" }),
        );
        return result.achievements.find((item) => item.id === "collaboration")!
          .achieved;
      };
      const checkOwners = async (expected: boolean, message: string) => {
        assert.equal(await achieved(0), expected, `${message}: first owner`);
        assert.equal(await achieved(1), expected, `${message}: second owner`);
        assert.equal(await achieved(2), false, `${message}: non-owner`);
      };
      await submit(0);
      await checkOwners(false, "partial delivery has no formal round");
      await setTimeout(20);
      await submit(1);
      const submitted = await db.workStageParticipant.findMany({
        where: { id: { in: owners.map((p) => p.id) } },
      });
      assert.notEqual(
        submitted[0].submittedAt!.getTime(),
        submitted[1].submittedAt!.getTime(),
      );
      await checkOwners(
        true,
        "asynchronous final delivery credits both owners",
      );
      await cancel(0);
      await checkOwners(
        false,
        "withdrawal leaves only one effective round member",
      );
      await submit(0);
      await checkOwners(true, "resubmission completes a new effective round");
      await cancel(0);
      await cancel(1);
      await submit(0);
      await checkOwners(
        false,
        "old complete rounds cannot credit a new partial round",
      );
      await submit(1);
      await checkOwners(true, "later formal round restores collaboration");
      await cancel(0);
      const extra = await db.workImage.create({
        data: { workId, orderIndex: 2, originalFileObjectId: fileId },
      });
      const extraAssignment = await db.workPageAssignment.create({
        data: { workId, stage, workImageId: extra.id, generation: 1 },
      });
      await submit(0);
      await checkOwners(
        false,
        "old joint credits do not cover a later partial submission with both members still submitted",
      );
      await db.workPageAssignment.update({
        where: { id: extraAssignment.id },
        data: { participantId: owners[0].id },
      });
      if (stage === "typeset")
        await db.workTypesetDraft.create({
          data: {
            workId,
            workImageId: extra.id,
            participantId: owners[0].id,
            assignmentGeneration: 1,
            fileObjectId: fileId,
            sourceName: "3.png",
            width: 1,
            height: 1,
            orderIndex: 2,
          },
        });
      await submit(0);
      await checkOwners(
        true,
        "a formal round covering the latest submissions restores collaboration",
      );
      await db.workStageParticipant.update({
        where: { id: owners[0].id },
        data: { leftAt: new Date() },
      });
      await db.work.update({
        where: { id: workId },
        data: { workflowStatus: "archived" },
      });
      await checkOwners(
        true,
        "leaving and archiving retain formal historical credits",
      );
    } finally {
      try {
        if (workId) {
          const where = { workId };
          await db.workEvent.deleteMany({ where });
          await db.stageContributionSubmission.deleteMany({
            where: { participant: where },
          });
          await db.workTypesetDraft.deleteMany({ where });
          await db.work.update({
            where: { id: workId },
            data: { currentTypesetVersionId: null },
          });
          await db.typesetImageVersion.deleteMany({ where });
          await db.translationVersion.deleteMany({ where });
          await db.workPageAssignment.deleteMany({ where });
          await db.workStageParticipant.deleteMany({ where });
          await db.workImage.deleteMany({ where });
          await db.work.delete({ where: { id: workId } });
        }
        if (postId) await db.candidatePost.delete({ where: { id: postId } });
        if (authorId) await db.author.delete({ where: { id: authorId } });
        if (fileId) await db.fileObject.delete({ where: { id: fileId } });
        await db.userLanguageCapability.deleteMany({
          where: { userId: { in: userIds } },
        });
        await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
        await db.user.deleteMany({ where: { id: { in: userIds } } });
      } finally {
        await app.close();
      }
    }
  });
