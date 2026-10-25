import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import type { Prisma, WorkStage } from "../../src/generated/prisma/client.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { MemoryObjectStorage } from "../../src/files/memory-object-storage.js";
import { JobsService } from "../../src/jobs/jobs.service.js";
import { TranslationsService } from "../../src/translations/translations.service.js";
import { WorksService } from "../../src/works/works.service.js";
import { PublishingService } from "../../src/publishing/publishing.service.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must select a disposable _test database.");

test("one member's translation and typesetting credits remain independent through editing, withdrawal, submission and publication", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  const rollback = new Error("rollback role credit fixtures");
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
          const translations = new TranslationsService(facade, files);
          const works = new WorksService(facade, files, translations);
          const publishing = new PublishingService(facade, files);
          const member = await tx.user.create({
            data: {
              username: `credits_${randomUUID()}`,
              displayName: "默认昵称",
              passwordHash: "non-login-fixture",
              mustChangePassword: false,
              roles: {
                create: [
                  { role: "translator" },
                  { role: "typesetter" },
                  { role: "operator" },
                ],
              },
              languageCapabilities: { create: { language: "ja" } },
            },
          });
          const author = await tx.author.create({
            data: { displayName: "署名测试作者" },
          });
          const candidate = await tx.candidatePost.create({
            data: {
              authorId: author.id,
              platform: "fixture",
              externalPostId: randomUUID(),
              postedAt: new Date(),
              rawJson: {},
            },
          });
          const image = await files.store({
            body: new Uint8Array([137, 80, 78, 71]),
            contentType: "image/png",
            bucketScope: "private",
            kind: "fixture",
            createdById: member.id,
          });
          const work = await tx.work.create({
            data: {
              authorId: author.id,
              sourceCandidatePostId: candidate.id,
              title: "职责署名",
              importedById: member.id,
              images: {
                create: {
                  originalFileObjectId: image.id,
                  orderIndex: 0,
                  width: 1,
                  height: 1,
                },
              },
            },
            include: { images: true },
          });
          const head = () => works.get(work.id, member.id);
          const claim = async (
            stage: Exclude<WorkStage, "publish">,
            creditName?: string,
          ) =>
            works.claimStage(member.id, work.id, {
              stage,
              creditName,
              expectedRevision: (await head()).revision,
              idempotencyKey: randomUUID(),
            });
          const credit = async (
            stage: Exclude<WorkStage, "publish">,
            creditName: string | null,
          ) =>
            works.updateStageCredit(member.id, work.id, {
              stage,
              creditName,
              expectedRevision: (await head()).revision,
              idempotencyKey: randomUUID(),
            });
          const assertCredits = async (
            translate: string | null,
            typeset: string | null,
          ) => {
            const participants = (await head()).participants.filter(
              (p) => !p.leftAt,
            );
            assert.equal(
              participants.find((p) => p.stage === "translate")?.workCreditName,
              translate,
            );
            assert.equal(
              participants.find((p) => p.stage === "typeset")?.workCreditName,
              typeset,
            );
          };
          await claim("translate", "译者别名");
          await claim("typeset", "嵌字别名");
          await assertCredits("译者别名", "嵌字别名");
          await credit("translate", "新译者");
          await credit("typeset", null);
          await assertCredits("新译者", null);
          await credit("typeset", "新嵌字");
          await credit("translate", null);
          await assertCredits(null, "新嵌字");
          await credit("translate", "提交时译者");
          await works.leaveStage(member.id, work.id, {
            stage: "typeset",
            expectedRevision: (await head()).revision,
            idempotencyKey: randomUUID(),
          });
          await claim("typeset");
          await assertCredits("提交时译者", null);
          await credit("typeset", "提交时嵌字");
          const editor = await translations.getEditor(member.id, work.id);
          const draft = await translations.createEntry(
            member.id,
            work.images[0].id,
            {
              markerX: 0.1,
              markerY: 0.2,
              markerPositionType: "inside",
              expectedImageRevision: editor.images[0].translationRevision,
              expectedEditorEpoch: editor.editorEpoch,
              idempotencyKey: randomUUID(),
            },
          );
          await translations.updateEntry(member.id, draft.entries[0].id, {
            translatedText: "测试译文",
            expectedRevision: draft.entries[0].revision,
            expectedEditorEpoch: draft.mutation!.editorEpoch,
          });
          const beforeSubmit = await head();
          await works.submitStage(member.id, work.id, {
            stage: "translate",
            expectedRevision: beforeSubmit.revision,
            expectedEditorEpoch: beforeSubmit.editorEpoch,
            idempotencyKey: randomUUID(),
          });
          await credit("translate", "发布时译者");
          assert.equal(
            (await head()).participants.find((p) => p.stage === "translate")!
              .creditNameSnapshot,
            "提交时译者",
          );

          // Seed downstream completion to isolate publication credit selection from package I/O.
          const version = await tx.typesetImageVersion.create({
            data: {
              workId: work.id,
              uploadedById: member.id,
              versionNumber: 1,
              idempotencyKey: randomUUID(),
              images: {
                create: {
                  fileObjectId: image.id,
                  sourceName: "fixture.png",
                  orderIndex: 0,
                  width: 1,
                  height: 1,
                },
              },
            },
          });
          for (const stage of ["proofread", "typeset"] as const) {
            await tx.workEvent.create({
              data: {
                workId: work.id,
                actorId: member.id,
                action: "stage_submitted",
                detail: {
                  stage,
                  credits: [
                    {
                      userId: stage === "typeset" ? member.id : randomUUID(),
                      creditName: stage === "typeset" ? "提交时嵌字" : "校对员",
                    },
                  ],
                },
              },
            });
          }
          await tx.work.update({
            where: { id: work.id },
            data: {
              workflowStatus: "pending_publish",
              currentTypesetVersionId: version.id,
            },
          });
          await credit("typeset", "发布时嵌字");
          const preview = await publishing.view(member.id, work.id);
          assert.deepEqual(preview.translationCredits, ["发布时译者"]);
          assert.deepEqual(preview.typesetCredits, ["发布时嵌字"]);
          const published = await publishing.confirm(member.id, work.id, {
            expectedRevision: preview.workRevision,
            idempotencyKey: randomUUID(),
          });
          await assert.rejects(
            credit("translate", "不能覆盖发布"),
            /发布或归档/,
          );
          await tx.user.update({
            where: { id: member.id },
            data: { displayName: "后续昵称" },
          });
          const frozen = await publishing.view(member.id, work.id);
          assert.equal(frozen.generatedText, published.generatedText);
          assert.deepEqual(frozen.translationCredits, ["发布时译者"]);
          assert.deepEqual(frozen.typesetCredits, ["发布时嵌字"]);
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

test("legacy shared credit migration copies remaining roles, including submitted ones, and drops withdrawn-only aliases", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  const rollback = new Error("rollback migration fixture");
  const sql = await readFile(
    new URL(
      "../../prisma/migrations/20261015000100_scope_work_credit_aliases_by_stage/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        // Temporary tables shadow only these names in this transaction; public data is untouched.
        await tx.$executeRawUnsafe(
          "CREATE TEMP TABLE work_credit_aliases (work_id uuid, user_id uuid, credit_name varchar(100), updated_at timestamptz, CONSTRAINT work_credit_aliases_pkey PRIMARY KEY (work_id, user_id)) ON COMMIT DROP",
        );
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE work_stage_participants (work_id uuid, user_id uuid, stage "WorkStage", submitted_at timestamptz, left_at timestamptz) ON COMMIT DROP',
        );
        const workId = randomUUID(),
          member = randomUUID(),
          departed = randomUUID();
        await tx.$executeRaw`INSERT INTO work_credit_aliases VALUES (${workId}::uuid, ${member}::uuid, '共享旧名', now()), (${workId}::uuid, ${departed}::uuid, '已退出', now())`;
        await tx.$executeRaw`INSERT INTO work_stage_participants VALUES (${workId}::uuid, ${member}::uuid, 'translate', now(), NULL), (${workId}::uuid, ${member}::uuid, 'typeset', NULL, NULL), (${workId}::uuid, ${member}::uuid, 'proofread', NULL, now()), (${workId}::uuid, ${departed}::uuid, 'typeset', NULL, now())`;
        for (const statement of sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .filter((part) => part.trim()))
          await tx.$executeRawUnsafe(statement);
        const aliases = await tx.$queryRaw<
          { stage: string; credit_name: string }[]
        >`SELECT stage, credit_name FROM work_credit_aliases ORDER BY stage`;
        assert.deepEqual(aliases, [
          { stage: "translate", credit_name: "共享旧名" },
          { stage: "typeset", credit_name: "共享旧名" },
        ]);
        throw rollback;
      }),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});
