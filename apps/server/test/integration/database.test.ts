import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must explicitly select a disposable database ending in _test.",
  );
}

test("migrated PostgreSQL supports Nest lifecycle, user persistence, uniqueness and rollback", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const prisma = app.get(PrismaService);
  const username = `fixture_${randomUUID()}`;
  const fixture = {
    username,
    passwordHash: "non-login-test-fixture",
    displayName: "Test fixture",
  };
  const rollback = new Error("intentional fixture rollback");
  try {
    await app.listen(0, "127.0.0.1");
    const response = await fetch(`${await app.getUrl()}/api/health/ready`);
    assert.equal(response.status, 200);
    await response.body?.cancel();
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: fixture });
        assert.equal(user.isActive, true);
        assert.ok(user.createdAt instanceof Date);
        assert.equal(
          (await tx.user.findUniqueOrThrow({ where: { username } })).id,
          user.id,
        );
        const author = await tx.author.create({
          data: { displayName: "Translation fixture author" },
        });
        const externalAccount = await tx.authorExternalAccount.create({
          data: {
            authorId: author.id,
            platform: "fixture",
            externalUserId: randomUUID(),
          },
        });
        const candidate = await tx.candidatePost.create({
          data: {
            authorId: author.id,
            authorExternalAccountId: externalAccount.id,
            platform: "fixture",
            externalPostId: randomUUID(),
            externalPostUrl: "https://fixture.invalid/translation",
            postedAt: new Date(),
            rawJson: { fixture: true },
          },
        });
        const file = await tx.fileObject.create({
          data: {
            objectKey: `test/${randomUUID()}`,
            bucketScope: "source",
            kind: "translation-fixture",
            contentType: "image/png",
            size: 10n,
            checksum: "0".repeat(64),
            createdById: user.id,
          },
        });
        const work = await tx.work.create({
          data: {
            authorId: author.id,
            sourceCandidatePostId: candidate.id,
            sourcePostUrl: candidate.externalPostUrl,
            title: "Translation fixture",
            importedById: user.id,
            images: {
              create: {
                originalFileObjectId: file.id,
                orderIndex: 0,
                width: 1000,
                height: 800,
              },
            },
          },
          include: { images: true },
        });
        const secondCandidate = await tx.candidatePost.create({
          data: {
            authorId: author.id,
            authorExternalAccountId: externalAccount.id,
            platform: "fixture",
            externalPostId: randomUUID(),
            postedAt: new Date(),
            rawJson: { fixture: true },
          },
        });
        const secondWork = await tx.work.create({
          data: {
            authorId: author.id,
            sourceCandidatePostId: secondCandidate.id,
            title: null,
            importedById: user.id,
          },
        });
        await tx.work.delete({ where: { id: secondWork.id } });
        const thirdCandidate = await tx.candidatePost.create({
          data: {
            authorId: author.id,
            authorExternalAccountId: externalAccount.id,
            platform: "fixture",
            externalPostId: randomUUID(),
            postedAt: new Date(),
            rawJson: { fixture: true },
          },
        });
        const thirdWork = await tx.work.create({
          data: {
            authorId: author.id,
            sourceCandidatePostId: thirdCandidate.id,
            title: null,
            importedById: user.id,
          },
        });
        assert.ok(secondWork.workNumber > work.workNumber);
        assert.ok(thirdWork.workNumber > secondWork.workNumber);
        const entry = await tx.translationEntry.create({
          data: {
            workImageId: work.images[0].id,
            orderIndex: 0,
            markerX: 0.25,
            markerY: 0.375,
            markerPositionType: "inside",
            translatedText: "初始译文",
            creationIdempotencyKey: randomUUID(),
            createdById: user.id,
            updatedById: user.id,
          },
        });
        const version = await tx.translationVersion.create({
          data: {
            workId: work.id,
            versionNumber: 1,
            kind: "translate_submission",
            workRevision: work.revision,
            editorEpoch: 1,
            createdById: user.id,
            entries: {
              create: {
                workImageId: work.images[0].id,
                sourceEntryId: entry.id,
                orderIndex: entry.orderIndex,
                markerX: entry.markerX,
                markerY: entry.markerY,
                markerPositionType: entry.markerPositionType,
                translatedText: entry.translatedText,
              },
            },
          },
          include: { entries: true },
        });
        await tx.labelPlusFile.create({
          data: {
            workId: work.id,
            fileObjectId: file.id,
            direction: "import",
            formatVersion: "1,0",
            fileName: "fixture.txt",
            imageCount: 1,
            markerCount: 1,
            parseWarnings: [],
            idempotencyKey: randomUUID(),
            createdById: user.id,
          },
        });
        await tx.translationEntry.update({
          where: { id: entry.id },
          data: {
            translatedText: "后续草稿",
            revision: { increment: 1 },
          },
        });
        assert.equal(version.entries[0].translatedText, "初始译文");
        assert.equal(
          (
            await tx.translationVersionEntry.findUniqueOrThrow({
              where: { id: version.entries[0].id },
            })
          ).translatedText,
          "初始译文",
        );
        throw rollback;
      }),
      (error: unknown) => error === rollback,
    );
    assert.equal(await prisma.user.count({ where: { username } }), 0);

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.user.create({ data: fixture });
        await tx.user.create({ data: fixture });
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002",
    );
    assert.equal(await prisma.user.count({ where: { username } }), 0);
  } finally {
    await app.close();
  }
});
