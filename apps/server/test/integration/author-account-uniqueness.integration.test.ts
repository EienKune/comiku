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
import { AuthorsService } from "../../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { ConflictException } from "@nestjs/common";
loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");

test("the forward migration archives duplicate identities, keeps source references, stops leases and enforces partial uniqueness", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const rollback = new Error("rollback uniqueness migration fixtures");
  const migration = await readFile(
    new URL(
      "../../prisma/migrations/20261003160000_unique_active_author_platform/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          // Transactional DDL affects only this disposable test database and is fully rolled back.
          await tx.$executeRawUnsafe(
            "DROP INDEX author_external_accounts_active_author_platform_key",
          );
          const author = await tx.author.create({
            data: { displayName: "Uniqueness migration fixture" },
          });
          const first = await tx.authorExternalAccount.create({
            data: {
              authorId: author.id,
              platform: "x",
              externalUserId: randomUUID(),
              createdAt: new Date("2026-01-01"),
            },
          });
          const duplicate = await tx.authorExternalAccount.create({
            data: {
              authorId: author.id,
              platform: "x",
              externalUserId: randomUUID(),
              createdAt: new Date("2026-02-01"),
              adapterStates: {
                create: {
                  adapterKey: "fixture",
                  fetchLeaseId: randomUUID(),
                  fetchLeaseUntil: new Date(Date.now() + 60000),
                },
              },
            },
          });
          const candidate = await tx.candidatePost.create({
            data: {
              authorId: author.id,
              authorExternalAccountId: duplicate.id,
              platform: "x",
              externalPostId: randomUUID(),
              postedAt: new Date(),
              rawJson: {},
            },
          });
          for (const statement of migration
            .split(";")
            .map((value) => value.trim())
            .filter(Boolean))
            await tx.$executeRawUnsafe(statement);
          const kept = await tx.authorExternalAccount.findUniqueOrThrow({
            where: { id: first.id },
          });
          const old = await tx.authorExternalAccount.findUniqueOrThrow({
            where: { id: duplicate.id },
            include: { adapterStates: true },
          });
          assert.equal(kept.deletedAt, null);
          assert.ok(old.deletedAt);
          assert.equal(old.fetchEnabled, false);
          assert.equal(old.adapterStates[0].enabled, false);
          assert.equal(old.adapterStates[0].fetchLeaseId, null);
          assert.equal(
            (
              old.metadataJson as {
                uniquenessCleanup: { retainedAccountId: string };
              }
            ).uniquenessCleanup.retainedAccountId,
            first.id,
          );
          assert.equal(
            (
              await tx.candidatePost.findUniqueOrThrow({
                where: { id: candidate.id },
              })
            ).authorExternalAccountId,
            duplicate.id,
          );
          // SAVEPOINT lets PostgreSQL recover from the expected unique constraint failure.
          await tx.$executeRawUnsafe("SAVEPOINT uniqueness_check");
          await assert.rejects(
            tx.authorExternalAccount.create({
              data: {
                authorId: author.id,
                platform: "x",
                externalUserId: randomUUID(),
              },
            }),
          );
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT uniqueness_check");
          await tx.authorExternalAccount.create({
            data: {
              authorId: author.id,
              platform: "pixiv",
              externalUserId: randomUUID(),
            },
          });
          throw rollback;
        },
        { timeout: 15000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});

test("same-author X synchronization is allowed while identity changes preserve all stored state by rejecting the edit", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const author = await db.author.create({
    data: { displayName: "Account replacement fixture" },
  });
  const other = await db.author.create({
    data: { displayName: "Account conflict fixture" },
  });
  const oldIdentity = BigInt(
    "0x" + randomUUID().replaceAll("-", "").slice(0, 15),
  ).toString();
  const newIdentity = BigInt(
    "0x" + randomUUID().replaceAll("-", "").slice(0, 15),
  ).toString();
  const actorId = randomUUID();
  let candidateId: string | undefined;
  const sources = new ContentSourceRegistry().register({
    platform: "x",
    adapterKey: "fixture_profile",
    priority: 1,
    metered: false,
    available: true,
    supportedFirstSyncModes: ["none", "last_24_hours"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    checkAccount: async (identity) => identity,
    resolveProfileByHandle: async (handle) => ({
      externalUserId: handle === "another" ? newIdentity : oldIdentity,
      handle,
      displayName: "同步昵称",
    }),
    fetchPage: async () => ({ items: [], complete: true }),
  });
  const service = new AuthorsService(
    db,
    sources,
    {} as never,
    {} as never,
    {
      platforms: {
        profileNetwork: async (_actor: string, run: () => Promise<unknown>) =>
          run(),
      },
    } as never,
  );
  try {
    const profile = await service.resolveXProfile(actorId, "artist", author.id);
    const original = await service.createAccount(
      author.id,
      {
        profileProof: profile.profileProof,
        platform: "x",
        externalUserId: oldIdentity,
        handle: "artist",
        fetchEnabled: true,
        firstSyncMode: "none",
      },
      actorId,
    );
    await assert.rejects(
      service.resolveXProfile(randomUUID(), "artist"),
      ConflictException,
    );
    assert.equal(
      (await service.resolveXProfile(randomUUID(), "artist", author.id))
        .externalUserId,
      oldIdentity,
    );
    const candidate = await db.candidatePost.create({
      data: {
        authorId: author.id,
        authorExternalAccountId: original.id,
        platform: "x",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    candidateId = candidate.id;
    await db.sourceAdapterState.updateMany({
      where: { externalAccountId: original.id },
      data: {
        cursorJson: { oldCursor: true },
        highWaterExternalId: "old",
        fetchLeaseId: randomUUID(),
      },
    });
    const coverage = new Date("2026-10-20T00:00:00.000Z");
    const unfinished = {
      version: 1,
      sourceId: oldIdentity,
      firstSyncMode: "none",
      startTime: null,
      endTime: "2026-10-21T00:00:00.000Z",
    };
    await db.sourceAccountScanState.create({
      data: {
        accountId: original.id,
        discoveredThroughAt: coverage,
        windowJson: unfinished,
        epoch: 9,
      },
    });
    const otherProfile = await service.resolveXProfile(
      actorId,
      "another",
      other.id,
    );
    const otherAccount = await service.createAccount(
      other.id,
      {
        profileProof: otherProfile.profileProof,
        platform: "x",
        externalUserId: newIdentity,
        handle: "another",
        fetchEnabled: false,
        firstSyncMode: "none",
      },
      actorId,
    );
    // A failed replacement must roll back both unbinding and lease changes.
    await assert.rejects(
      service.updateAccount(author.id, original.id, {
        externalUserId: newIdentity,
        handle: "another",
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: original.revision,
      }),
      ConflictException,
    );
    assert.equal((await service.listAccounts(author.id))[0].id, original.id);
    assert.ok(
      (
        await db.sourceAdapterState.findFirstOrThrow({
          where: { externalAccountId: original.id },
        })
      ).fetchLeaseId,
    );
    await service.archiveAccount(
      other.id,
      otherAccount.id,
      otherAccount.revision,
    );
    // Global identity remains reserved by recoverable history, not reassigned to another author.
    await assert.rejects(
      service.updateAccount(author.id, original.id, {
        externalUserId: newIdentity,
        handle: "another",
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: original.revision,
      }),
      ConflictException,
    );
    const snapshot = async () => ({
      account: await db.authorExternalAccount.findUniqueOrThrow({
        where: { id: original.id },
        include: { adapterStates: true },
      }),
      scan: await db.sourceAccountScanState.findUniqueOrThrow({
        where: { accountId: original.id },
      }),
      candidate: await db.candidatePost.findUniqueOrThrow({
        where: { id: candidate.id },
      }),
      accounts: await db.authorExternalAccount.count({
        where: { authorId: author.id },
      }),
    });
    const before = await snapshot();
    await assert.rejects(
      service.updateAccount(author.id, original.id, {
        externalUserId: randomUUID(),
        handle: "replacement",
        displayNameSnapshot: "Another person",
        fetchEnabled: true,
        firstSyncMode: "last_24_hours",
        expectedRevision: original.revision,
      }),
      ConflictException,
    );
    assert.deepEqual(await snapshot(), before);
    const renamed = await service.resolveXProfile(
      actorId,
      "artist_renamed",
      author.id,
    );
    const edited = await service.updateAccount(
      author.id,
      original.id,
      {
        profileProof: renamed.profileProof,
        externalUserId: oldIdentity,
        handle: "artist_renamed",
        displayNameSnapshot: "Same artist",
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: original.revision,
      },
      actorId,
    );
    assert.equal(edited.id, original.id);
    assert.equal(edited.externalUserId, oldIdentity);
    assert.equal(edited.handle, "artist_renamed");
    assert.equal(edited.displayNameSnapshot, "Same artist");
    assert.equal(edited.fetchEnabled, false);
    const after = await snapshot();
    assert.deepEqual(after.account.adapterStates, before.account.adapterStates);
    assert.deepEqual(after.scan, before.scan);
    assert.deepEqual(after.candidate, before.candidate);
  } finally {
    if (candidateId)
      await db.candidatePost.delete({ where: { id: candidateId } });
    await db.authorExternalAccount.deleteMany({
      where: { authorId: { in: [author.id, other.id] } },
    });
    await db.author.deleteMany({
      where: { id: { in: [author.id, other.id] } },
    });
    await db.$disconnect();
  }
});
