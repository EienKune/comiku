import { JobsService } from "../../src/jobs/jobs.service.js";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import {
  type Prisma,
  type Role,
  type SourceLanguage,
} from "../../src/generated/prisma/client.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { MemoryObjectStorage } from "../../src/files/memory-object-storage.js";
import { TranslationsService } from "../../src/translations/translations.service.js";
import { WorksService } from "../../src/works/works.service.js";
import { PublishingService } from "../../src/publishing/publishing.service.js";
import { UsersService } from "../../src/users/users.service.js";
import { hashPassword } from "../../src/users/password.js";
import { WorkQueryDto, WorkView } from "../../src/works/works.dto.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must select a disposable _test database.");

test("proofread exemption preserves versions, explicit claim consent, qualification and handoff boundaries", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const rollback = new Error("rollback exemption fixtures");
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
          const users = new UsersService(facade, files);
          const password = "exemption-fixture-password";
          const passwordHash = await hashPassword(password);
          async function member(roles: Role[], exemption = false) {
            return tx.user.create({
              data: {
                username: `exemption_${randomUUID()}`,
                displayName: roles.join("/"),
                passwordHash,
                mustChangePassword: false,
                canSkipProofreading: exemption,
                roles: { create: roles.map((role) => ({ role })) },
                languageCapabilities: {
                  create: [{ language: "ja" }, { language: "ko" }],
                },
              },
            });
          }
          const translator = await member(["translator"], true);
          const other = await member(
            ["translator", "proofreader", "typesetter"],
            true,
          );
          const typesetter = await member(["typesetter"]);
          const admin = await member(["admin"], true);
          const session = await tx.authSession.create({
            data: {
              userId: admin.id,
              tokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
              expiresAt: new Date(Date.now() + 3600000),
            },
          });
          const adminActor = { userId: admin.id, sessionId: session.id };
          const managed = await users.manage(adminActor, translator.id, {
            displayName: "翻译昵称",
            roles: ["translator"],
            languageCapabilities: ["ja", "ko"],
            isActive: true,
            canSkipProofreading: false,
            expectedRevision: 0,
            currentPassword: password,
          });
          assert.equal(managed.canSkipProofreading, false);
          assert.equal(
            (
              await tx.accountAudit.findFirstOrThrow({
                where: { targetId: translator.id, action: "account.managed" },
              })
            ).detail instanceof Object,
            true,
          );
          await users.manage(adminActor, translator.id, {
            displayName: "翻译昵称",
            roles: ["translator"],
            languageCapabilities: ["ja", "ko"],
            isActive: true,
            canSkipProofreading: true,
            expectedRevision: managed.revision,
            currentPassword: password,
          });
          await assert.rejects(
            users.manage(
              { userId: translator.id, sessionId: session.id },
              translator.id,
              {
                displayName: "x",
                roles: ["translator"],
                isActive: true,
                canSkipProofreading: true,
                expectedRevision: 2,
                currentPassword: password,
              },
            ),
          );
          const author = await tx.author.create({
            data: { displayName: "免校测试作者" },
          });
          const image = await files.store({
            body: new Uint8Array([137, 80, 78, 71]),
            contentType: "image/png",
            bucketScope: "private",
            kind: "fixture",
            createdById: translator.id,
          });
          async function create(
            language: SourceLanguage = "ko",
            multi = false,
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
            const work = await tx.work.create({
              data: {
                authorId: author.id,
                sourceCandidatePostId: candidate.id,
                sourceLanguage: language,
                title: "免校作品",
                importedById: translator.id,
                collaborationMode: multi ? "multi" : "single",
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
            return work;
          }
          async function claim(
            actor: string,
            workId: string,
            stage: "translate" | "proofread" | "typeset",
            join = false,
          ) {
            const work = await works.get(workId, actor);
            return join
              ? works.joinStage(actor, workId, {
                  stage,
                  expectedRevision: work.revision,
                  idempotencyKey: randomUUID(),
                })
              : works.claimStage(actor, workId, {
                  stage,
                  expectedRevision: work.revision,
                  idempotencyKey: randomUUID(),
                });
          }
          async function add(actor: string, workId: string, imageId: string) {
            const head = await translations.getEditor(actor, workId);
            const draft = await translations.createEntry(actor, imageId, {
              markerX: 0.123,
              markerY: 0.456,
              markerPositionType: "inside",
              expectedImageRevision: head.images[0].translationRevision,
              expectedEditorEpoch: head.editorEpoch,
              idempotencyKey: randomUUID(),
            });
            const entry = draft.entries.at(-1)!;
            await translations.updateEntry(actor, entry.id, {
              translatedText: "译文",
              expectedRevision: entry.revision,
              expectedEditorEpoch: draft.mutation!.editorEpoch,
            });
          }
          async function submit(
            actor: string,
            workId: string,
            stage: "translate" | "proofread" | "typeset",
          ) {
            const work = await works.get(workId);
            return works.submitStage(actor, workId, {
              stage,
              expectedRevision: work.revision,
              expectedEditorEpoch: work.editorEpoch,
              idempotencyKey: randomUUID(),
            });
          }
          async function skipInput(workId: string) {
            const head = await works.get(workId, translator.id);
            return {
              expectedRevision: head.revision,
              expectedEditorEpoch: head.editorEpoch,
              idempotencyKey: randomUUID(),
              confirmCancelClaims: false,
              proofreadParticipantIds: head.participants
                .filter(
                  (p) => p.stage === "proofread" && !p.leftAt && !p.submittedAt,
                )
                .map((p) => p.id),
            };
          }
          async function cancel(workId: string) {
            const head = await works.get(workId);
            return works.cancelStageSubmission(translator.id, workId, {
              stage: "translate",
              expectedRevision: head.revision,
              expectedEditorEpoch: head.editorEpoch,
              idempotencyKey: randomUUID(),
            });
          }

          const first = await create();
          await claim(translator.id, first.id, "translate");
          await add(translator.id, first.id, first.images[0].id);
          await submit(translator.id, first.id, "translate");
          assert.equal(
            (await works.get(first.id, translator.id)).canSkipProofreading,
            true,
          );
          assert.equal(
            (await translations.getEditor(translator.id, first.id)).canEdit,
            false,
          );
          await assert.rejects(
            works.skipProofreading(
              admin.id,
              first.id,
              await skipInput(first.id),
            ),
            /资格/,
          );
          await assert.rejects(
            works.skipProofreading(
              other.id,
              first.id,
              await skipInput(first.id),
            ),
            /原提交人/,
          );
          const stale = await skipInput(first.id);
          await claim(other.id, first.id, "proofread");
          await assert.rejects(
            works.skipProofreading(translator.id, first.id, stale),
            /更新/,
          );
          const withClaim = await skipInput(first.id);
          await assert.rejects(
            works.skipProofreading(translator.id, first.id, withClaim),
            /确认取消/,
          );
          await tx.workCreditAlias.create({
            data: {
              workId: first.id,
              userId: other.id,
              stage: "proofread",
              creditName: "临时校对名",
            },
          });
          await claim(other.id, first.id, "typeset");
          await tx.workCreditAlias.create({
            data: {
              workId: first.id,
              userId: other.id,
              stage: "typeset",
              creditName: "保留嵌字署名",
            },
          });
          withClaim.expectedRevision = (await works.get(first.id)).revision;
          withClaim.confirmCancelClaims = true;
          const skipped = await works.skipProofreading(
            translator.id,
            first.id,
            withClaim,
          );
          assert.equal(skipped.workflowStatus, "pending_typeset");
          assert.equal(skipped.proofreadingSkipped, true);
          const skipVersion = await tx.translationVersion.findUniqueOrThrow({
            where: {
              id: (await tx.work.findUniqueOrThrow({ where: { id: first.id } }))
                .proofreadSkippedVersionId!,
            },
            include: {
              entries: true,
              sourceTranslationVersion: { include: { entries: true } },
            },
          });
          assert.equal(
            skipVersion.entries[0].translatedText,
            skipVersion.sourceTranslationVersion!.entries[0].translatedText,
          );
          assert.equal(skipVersion.proofreadSkipped, true);
          assert.equal(
            skipped.participants.find((p) => p.stage === "proofread")!
              .submittedAt,
            null,
          );
          assert.ok(
            skipped.participants.find((p) => p.stage === "proofread")!.leftAt,
          );
          assert.equal(
            await tx.workCreditAlias.count({
              where: { workId: first.id, userId: other.id, stage: "proofread" },
            }),
            0,
          );
          assert.equal(
            (
              await tx.workCreditAlias.findUniqueOrThrow({
                where: {
                  workId_userId_stage: {
                    workId: first.id,
                    userId: other.id,
                    stage: "typeset",
                  },
                },
              })
            ).creditName,
            "保留嵌字署名",
          );
          await works.leaveStage(other.id, first.id, {
            stage: "typeset",
            expectedRevision: (await works.get(first.id)).revision,
            idempotencyKey: randomUUID(),
          });
          await works.skipProofreading(translator.id, first.id, withClaim);
          assert.equal(
            await tx.workEvent.count({
              where: { workId: first.id, action: "proofreading_skipped" },
            }),
            1,
          );
          await assert.rejects(claim(other.id, first.id, "proofread"));
          assert.equal(
            (
              await works.list(
                other.id,
                Object.assign(new WorkQueryDto(), {
                  authorId: author.id,
                  unassignedStage: "proofread",
                }),
              )
            ).items.some((w) => w.id === first.id),
            false,
          );
          assert.equal(
            (
              await works.list(
                other.id,
                Object.assign(new WorkQueryDto(), {
                  authorId: author.id,
                  view: WorkView.recommended,
                }),
              )
            ).items
              .find((w) => w.id === first.id)
              ?.personalTasks?.some((task) => task.stage === "proofread") ??
              false,
            false,
          );
          assert.equal(
            (await translations.getEditor(translator.id, first.id))
              .cancelableSubmissionStage,
            "translate",
          );
          await tx.user.update({
            where: { id: translator.id },
            data: { canSkipProofreading: false },
          });
          const cancelled = await cancel(first.id);
          assert.equal(cancelled.workflowStatus, "translating");
          assert.equal(cancelled.proofreadingSkipped, false);
          assert.equal(
            (await translations.getEditor(translator.id, first.id)).images[0]
              .entries[0].translatedText,
            "译文",
          );
          await submit(translator.id, first.id, "translate");
          await assert.rejects(
            works.skipProofreading(
              translator.id,
              first.id,
              await skipInput(first.id),
            ),
            /资格/,
          );
          await tx.user.update({
            where: { id: translator.id },
            data: { canSkipProofreading: true },
          });
          const beforeHandoff = await works.skipProofreading(
            translator.id,
            first.id,
            await skipInput(first.id),
          );
          await claim(typesetter.id, first.id, "typeset");
          await translations.beginTypesetHandoff(typesetter.id, first.id, {
            material: "unified_handoff",
            fileId: image.id,
          });
          await assert.rejects(cancel(first.id), /下游已开始|下载/);
          const handing = await works.get(first.id);
          await works.leaveStage(typesetter.id, first.id, {
            stage: "typeset",
            expectedRevision: handing.revision,
            idempotencyKey: randomUUID(),
          });
          assert.equal(
            (await works.get(first.id)).workflowStatus,
            "pending_typeset",
          );
          assert.equal(
            (await translations.getEditor(translator.id, first.id))
              .cancelableSubmissionStage,
            null,
          );
          await assert.rejects(cancel(first.id), /下载/);
          await assert.rejects(
            translations.updateEntry(
              translator.id,
              skipVersion.entries[0].sourceEntryId!,
              {
                translatedText: "旧设备覆盖",
                expectedRevision: 1,
                expectedEditorEpoch: beforeHandoff.editorEpoch,
              },
            ),
            /新.*版本|确认本地/,
          );

          await claim(typesetter.id, first.id, "typeset");
          await translations.beginTypesetHandoff(typesetter.id, first.id, {
            material: "unified_handoff",
            fileId: image.id,
          });
          const resultVersion = await tx.typesetImageVersion.create({
            data: {
              workId: first.id,
              versionNumber: 1,
              idempotencyKey: randomUUID(),
              uploadedById: typesetter.id,
              images: {
                create: {
                  fileObjectId: image.id,
                  sourceName: "1-001成图.png",
                  orderIndex: 0,
                  width: 1,
                  height: 1,
                },
              },
            },
          });
          await tx.work.update({
            where: { id: first.id },
            data: { currentTypesetVersionId: resultVersion.id },
          });
          await submit(typesetter.id, first.id, "typeset");
          const publication = await publishing.view(typesetter.id, first.id);
          assert.deepEqual(publication.proofreadCredits, []);
          assert.doesNotMatch(publication.generatedText, /^校对：/m);
          assert.match(publication.generatedText, /翻译：翻译昵称/);
          assert.match(publication.generatedText, /嵌字：/);
          const beforePublish = await works.get(first.id);
          await publishing.confirm(admin.id, first.id, {
            expectedRevision: beforePublish.revision,
            idempotencyKey: randomUUID(),
          });
          const published = await tx.publishRecord.findFirstOrThrow({
            where: { workId: first.id },
          });
          assert.deepEqual(published.proofreadCreditsSnapshot, []);
          assert.doesNotMatch(published.generatedTextSnapshot, /^校对：/m);
          const publishEvent = await tx.workEvent.findFirstOrThrow({
            where: { workId: first.id, action: "publish_confirmed" },
          });
          assert.ok(
            (publishEvent.detail as { proofreadSkippedVersionId: string })
              .proofreadSkippedVersionId,
          );

          const activeProof = await create("ja");
          await claim(translator.id, activeProof.id, "translate");
          await add(translator.id, activeProof.id, activeProof.images[0].id);
          await submit(translator.id, activeProof.id, "translate");
          await claim(other.id, activeProof.id, "proofread");
          await add(other.id, activeProof.id, activeProof.images[0].id);
          await assert.rejects(
            works.skipProofreading(
              translator.id,
              activeProof.id,
              await skipInput(activeProof.id),
            ),
            /尚未开始/,
          );
          await submit(other.id, activeProof.id, "proofread");
          await assert.rejects(
            works.skipProofreading(
              translator.id,
              activeProof.id,
              await skipInput(activeProof.id),
            ),
            /尚未开始/,
          );

          const multi = await create("en", true);
          await claim(translator.id, multi.id, "translate");
          await claim(other.id, multi.id, "translate", true);
          await add(translator.id, multi.id, multi.images[0].id);
          await add(other.id, multi.id, multi.images[0].id);
          const multiHead = await works.get(multi.id);
          await works.leaveStage(other.id, multi.id, {
            stage: "translate",
            expectedRevision: multiHead.revision,
            idempotencyKey: randomUUID(),
          });
          await tx.work.update({
            where: { id: multi.id },
            data: { collaborationMode: "single" },
          });
          await submit(translator.id, multi.id, "translate");
          await assert.rejects(
            works.skipProofreading(
              translator.id,
              multi.id,
              await skipInput(multi.id),
            ),
            /多人翻译/,
          );
          const blocked = await create("en");
          await claim(translator.id, blocked.id, "translate");
          await add(translator.id, blocked.id, blocked.images[0].id);
          await submit(translator.id, blocked.id, "translate");
          await tx.work.update({
            where: { id: blocked.id },
            data: { reviewStatus: "needs_review" },
          });
          await assert.rejects(
            works.skipProofreading(
              translator.id,
              blocked.id,
              await skipInput(blocked.id),
            ),
            /审核/,
          );
          throw rollback;
        },
        { timeout: 45000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});

test("concurrent proofreading first write and skip serialize without discarding accepted proofreading", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const files = new FileObjectsService(
    db,
    new MemoryObjectStorage(),
    new JobsService(db),
  );
  const translations = new TranslationsService(db, files);
  const works = new WorksService(db, files, translations);
  const userIds: string[] = [],
    workIds: string[] = [],
    candidateIds: string[] = [];
  let authorId = "";
  try {
    const translator = await db.user.create({
      data: {
        username: `race_${randomUUID()}`,
        displayName: "race translator",
        passwordHash: "fixture",
        mustChangePassword: false,
        canSkipProofreading: true,
        roles: { create: { role: "translator" } },
      },
    });
    userIds.push(translator.id);
    const proofreader = await db.user.create({
      data: {
        username: `race_${randomUUID()}`,
        displayName: "race proofreader",
        passwordHash: "fixture",
        mustChangePassword: false,
        roles: { create: { role: "proofreader" } },
      },
    });
    userIds.push(proofreader.id);
    const author = await db.author.create({
      data: { displayName: "Race fixture author", sourceLanguage: "en" },
    });
    authorId = author.id;
    const image = await files.store({
      body: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
      bucketScope: "private",
      kind: "race-fixture",
      createdById: translator.id,
    });
    for (let iteration = 0; iteration < 2; iteration++) {
      const candidate = await db.candidatePost.create({
        data: {
          authorId,
          platform: "fixture",
          externalPostId: randomUUID(),
          postedAt: new Date(),
          rawJson: {},
        },
      });
      candidateIds.push(candidate.id);
      const work = await db.work.create({
        data: {
          authorId,
          sourceCandidatePostId: candidate.id,
          sourceLanguage: "en",
          importedById: translator.id,
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
      workIds.push(work.id);
      await works.claimStage(translator.id, work.id, {
        stage: "translate",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      const draft = await translations.createEntry(
        translator.id,
        work.images[0].id,
        {
          markerX: 0.1,
          markerY: 0.2,
          markerPositionType: "inside",
          expectedImageRevision: 0,
          expectedEditorEpoch: 0,
          idempotencyKey: randomUUID(),
        },
      );
      const head = await works.get(work.id);
      const submitted = await works.submitStage(translator.id, work.id, {
        stage: "translate",
        expectedRevision: head.revision,
        expectedEditorEpoch: head.editorEpoch,
        idempotencyKey: randomUUID(),
      });
      const claimed = await works.claimStage(proofreader.id, work.id, {
        stage: "proofread",
        expectedRevision: submitted.revision,
        idempotencyKey: randomUUID(),
      });
      const skip = () =>
        works.skipProofreading(translator.id, work.id, {
          expectedRevision: claimed.revision,
          expectedEditorEpoch: claimed.editorEpoch,
          idempotencyKey: randomUUID(),
          confirmCancelClaims: true,
          proofreadParticipantIds: claimed.participants
            .filter((p) => p.stage === "proofread" && !p.leftAt)
            .map((p) => p.id),
        });
      const proof = () =>
        translations.updateEntry(proofreader.id, draft.entries[0].id, {
          expectedRevision: 0,
          expectedEditorEpoch: claimed.editorEpoch,
          translatedText: "accepted proofreading",
        });
      const results = await Promise.allSettled(
        iteration ? [skip(), proof()] : [proof(), skip()],
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const current = await works.get(work.id);
      const entry = await db.translationEntry.findUniqueOrThrow({
        where: { id: draft.entries[0].id },
      });
      if (current.proofreadingSkipped) {
        assert.equal(current.workflowStatus, "pending_typeset");
        assert.equal(entry.translatedText, "");
      } else {
        assert.equal(current.workflowStatus, "proofreading");
        assert.equal(entry.translatedText, "accepted proofreading");
        assert.equal(
          await db.workEvent.count({
            where: { workId: work.id, action: "proofreading_skipped" },
          }),
          0,
        );
      }
    }
  } finally {
    await db.work.updateMany({
      where: { id: { in: workIds } },
      data: { proofreadSkippedVersionId: null },
    });
    await db.translationVersion.updateMany({
      where: { workId: { in: workIds } },
      data: { sourceTranslationVersionId: null },
    });
    await db.workEvent.deleteMany({ where: { workId: { in: workIds } } });
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
    if (authorId) await db.author.delete({ where: { id: authorId } });
    await db.fileObject.deleteMany({ where: { createdById: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
});
