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

test("same-author X synchronization is allowed while identity replacement preserves history and resets source state", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const author = await db.author.create({
    data: { displayName: "Account replacement fixture" },
  });
  const other = await db.author.create({
    data: { displayName: "Account conflict fixture" },
  });
  const oldIdentity = randomUUID();
  const newIdentity = randomUUID();
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
      externalUserId: oldIdentity,
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
    {} as never,
  );
  try {
    const original = await service.createAccount(author.id, {
      platform: "x",
      externalUserId: oldIdentity,
      handle: "artist",
      fetchEnabled: true,
      firstSyncMode: "none",
    });
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
    const otherAccount = await service.createAccount(other.id, {
      platform: "x",
      externalUserId: newIdentity,
      handle: "another",
      fetchEnabled: false,
      firstSyncMode: "none",
    });
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
    const replaced = await service.updateAccount(author.id, original.id, {
      externalUserId: randomUUID(),
      handle: "replacement",
      fetchEnabled: true,
      firstSyncMode: "last_24_hours",
      expectedRevision: original.revision,
    });
    assert.notEqual(replaced.id, original.id);
    assert.equal(
      (
        await db.candidatePost.findUniqueOrThrow({
          where: { id: candidate.id },
        })
      ).authorExternalAccountId,
      original.id,
    );
    const old = await db.authorExternalAccount.findUniqueOrThrow({
      where: { id: original.id },
      include: { adapterStates: true },
    });
    assert.ok(old.deletedAt);
    assert.equal(old.adapterStates[0].fetchLeaseId, null);
    assert.equal(old.adapterStates[0].enabled, false);
    const fresh = await db.sourceAdapterState.findFirstOrThrow({
      where: { externalAccountId: replaced.id },
    });
    assert.deepEqual(fresh.cursorJson, {});
    assert.equal(fresh.highWaterExternalId, null);
    assert.equal(
      await db.sourceAccountScanState.findUnique({
        where: { accountId: replaced.id },
      }),
      null,
    );
    const oldScan = await db.sourceAccountScanState.findUniqueOrThrow({
      where: { accountId: original.id },
    });
    assert.equal(
      oldScan.discoveredThroughAt?.toISOString(),
      coverage.toISOString(),
    );
    assert.deepEqual(oldScan.windowJson, unfinished);
    assert.equal(oldScan.epoch, 9);
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
