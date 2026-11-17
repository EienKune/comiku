import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ConflictException } from "@nestjs/common";
import { AuthorsService } from "../../src/authors/authors.service.js";
import { AuthorAccountFilter } from "../../src/authors/authors.dto.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Use a disposable _test database.");
const database = () =>
  new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
const numeric = () =>
  BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString();
const serviceFor = (db: PrismaService) =>
  new AuthorsService(
    db,
    new ContentSourceRegistry(),
    {} as never,
    {} as never,
    {} as never,
  );

test("multi-account migration drops only platform cardinality and preserves archived identity and source references", async () => {
  const db = database();
  const rollback = new Error("rollback multi-account migration fixture");
  const migration = await readFile(
    new URL(
      "../../prisma/migrations/20261116120000_author_multiple_platform_accounts/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          // Reconstruct the old constraint in the disposable transaction; no account cleanup is replayed.
          await tx.$executeRawUnsafe(
            "CREATE UNIQUE INDEX IF NOT EXISTS author_external_accounts_active_author_platform_key ON author_external_accounts (author_id, platform) WHERE deleted_at IS NULL",
          );
          const author = await tx.author.create({
            data: { displayName: "Multi-account migration fixture" },
          });
          const first = await tx.authorExternalAccount.create({
            data: {
              authorId: author.id,
              platform: "x",
              externalUserId: numeric(),
            },
          });
          const archived = await tx.authorExternalAccount.create({
            data: {
              authorId: author.id,
              platform: "x",
              externalUserId: numeric(),
              fetchEnabled: false,
              deletedAt: new Date(),
              metadataJson: {
                uniquenessCleanup: { retainedAccountId: first.id },
              },
              adapterStates: {
                create: {
                  adapterKey: "fixture",
                  enabled: false,
                  health: "disabled",
                },
              },
            },
            include: { adapterStates: true },
          });
          const candidate = await tx.candidatePost.create({
            data: {
              authorId: author.id,
              authorExternalAccountId: archived.id,
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
          assert.deepEqual(
            await tx.authorExternalAccount.findUniqueOrThrow({
              where: { id: archived.id },
              include: { adapterStates: true },
            }),
            archived,
          );
          assert.equal(
            (
              await tx.candidatePost.findUniqueOrThrow({
                where: { id: candidate.id },
              })
            ).authorExternalAccountId,
            archived.id,
          );
          await tx.authorExternalAccount.create({
            data: {
              authorId: author.id,
              platform: "x",
              externalUserId: numeric(),
            },
          });
          assert.equal(
            await tx.authorExternalAccount.count({
              where: { authorId: author.id, deletedAt: null },
            }),
            2,
          );
          await tx.$executeRawUnsafe("SAVEPOINT global_identity_check");
          await assert.rejects(
            tx.authorExternalAccount.create({
              data: {
                authorId: author.id,
                platform: "x",
                externalUserId: archived.externalUserId,
              },
            }),
          );
          await tx.$executeRawUnsafe(
            "ROLLBACK TO SAVEPOINT global_identity_check",
          );
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

test("author create, add, archive and restore preserve all same-platform identities with global uniqueness", async () => {
  const db = database();
  const service = serviceFor(db);
  const prefix = `multi_${randomUUID()}`;
  const actor = await db.user.create({
    data: {
      username: prefix,
      displayName: prefix,
      passwordHash: "fixture",
      mustChangePassword: false,
      roles: { create: { role: "source" } },
    },
  });
  const ids: string[] = [];
  try {
    const input = {
      displayName: prefix,
      sourceLanguage: "ja" as const,
      authorizationStatus: "pending" as const,
      existingTags: [],
      newTagNames: [],
      idempotencyKey: randomUUID(),
      accounts: [numeric(), numeric()].map((externalUserId) => ({
        platform: "pixiv",
        externalUserId,
        fetchEnabled: false,
        firstSyncMode: "none" as const,
      })),
    };
    const author = await service.create(input, actor.id);
    ids.push(author.id);
    assert.equal(author.externalAccounts.length, 2);
    assert.equal((await service.create(input, actor.id)).id, author.id);
    const other = await db.author.create({
      data: { displayName: `${prefix}_other` },
    });
    ids.push(other.id);
    const newAccount = {
      platform: "pixiv",
      externalUserId: numeric(),
      fetchEnabled: false,
      firstSyncMode: "none" as const,
    };
    // A racing duplicate is still one stable identity, while another identity can coexist.
    const attempts = await Promise.allSettled([
      service.createAccount(author.id, newAccount),
      service.createAccount(author.id, newAccount),
    ]);
    assert.equal(
      attempts.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const rejected = attempts.find((value) => value.status === "rejected");
    assert(
      rejected?.status === "rejected" &&
        rejected.reason instanceof ConflictException,
    );
    const accounts = await service.listAccounts(author.id);
    assert.equal(accounts.length, 3);
    const archived = accounts[0];
    await service.archiveAccount(
      author.id,
      archived.id,
      archived.revision,
      actor.id,
    );
    const historical = await service.listSourceAccounts(author.id);
    assert.equal(historical.length, 3);
    const old = historical.find((value) => value.id === archived.id)!;
    assert(old.deletedAt);
    assert.equal(old.fetchEnabled, false);
    assert.deepEqual(Object.keys(old).sort(), [
      "avatarAvailable",
      "deletedAt",
      "displayNameSnapshot",
      "externalUserId",
      "fetchEnabled",
      "handle",
      "id",
      "platform",
      "profileUrl",
    ]);
    await assert.rejects(
      service.createAccount(other.id, {
        ...newAccount,
        externalUserId: archived.externalUserId,
      }),
      ConflictException,
    );
    const restored = await service.restoreAccount(
      author.id,
      archived.id,
      archived.revision + 1,
      actor.id,
    );
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.fetchEnabled, false);
    assert.equal((await service.listAccounts(author.id)).length, 3);
    await assert.rejects(
      service.restoreAccount(
        author.id,
        archived.id,
        archived.revision + 1,
        actor.id,
      ),
      ConflictException,
    );
  } finally {
    await db.authorCreationRequest.deleteMany({ where: { actorId: actor.id } });
    await db.authorExternalAccount.deleteMany({
      where: { authorId: { in: ids } },
    });
    await db.author.deleteMany({ where: { id: { in: ids } } });
    await db.userRole.deleteMany({ where: { userId: actor.id } });
    await db.user.delete({ where: { id: actor.id } });
    await db.$disconnect();
  }
});

test("multi-account platform states mean any enabled, all active disabled, or no active links", async () => {
  const db = database();
  const service = serviceFor(db);
  const prefix = `state_${randomUUID()}`;
  const ids: string[] = [];
  try {
    for (const [index, values] of [
      [true, false],
      [false, false],
      [],
    ].entries()) {
      const author = await db.author.create({
        data: { displayName: `${prefix}_${index}` },
      });
      ids.push(author.id);
      for (const platform of ["x", "pixiv"]) {
        for (const fetchEnabled of values)
          await db.authorExternalAccount.create({
            data: {
              authorId: author.id,
              platform,
              externalUserId: numeric(),
              handle: platform === "x" ? `${prefix}_alternate_${index}` : null,
              fetchEnabled,
            },
          });
        await db.authorExternalAccount.create({
          data: {
            authorId: author.id,
            platform,
            externalUserId: numeric(),
            fetchEnabled: true,
            deletedAt: new Date(),
          },
        });
      }
    }
    for (const property of ["xState", "pixivState"] as const) {
      for (const [state, expected] of [
        [AuthorAccountFilter.enabled, [ids[0]]],
        [AuthorAccountFilter.disabled, [ids[1]]],
        [AuthorAccountFilter.unlinked, [ids[2]]],
        [AuthorAccountFilter.linked, [ids[0], ids[1]]],
      ] as const) {
        const actual: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await service.list({
            search: prefix,
            [property]: state,
            limit: 1,
            cursor,
          });
          assert.equal(page.total, expected.length);
          actual.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.deepEqual(actual, expected, `${property}=${state}`);
      }
    }
    const accountSearch = await service.list({
      search: `${prefix}_alternate_0`,
    });
    assert(accountSearch.items.some((item) => item.id === ids[0]));
  } finally {
    await db.authorExternalAccount.deleteMany({
      where: { authorId: { in: ids } },
    });
    await db.author.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});

test("same-time accounts have stable identity ordering and author avatar fallback stays explicit then X then chronological", async () => {
  const db = database();
  const prefix = `avatar_order_${randomUUID()}`;
  const avatarIds = Array.from({ length: 5 }, () => randomUUID());
  const [firstX, secondX] = [randomUUID(), randomUUID()].sort();
  const otherId = randomUUID(),
    pixivId = randomUUID();
  const author = await db.author.create({ data: { displayName: prefix } });
  const service = new AuthorsService(
    db,
    new ContentSourceRegistry(),
    {
      signedReadUrl: async (id: string) => ({ url: id, expiresInSeconds: 60 }),
    } as never,
    {} as never,
    {} as never,
  );
  try {
    await db.fileObject.createMany({
      data: avatarIds.map((id, index) => ({
        id,
        objectKey: `${prefix}/${index}.png`,
        bucketScope: "private",
        kind: "source_profile_avatar",
        contentType: "image/png",
        size: 1n,
        checksum: "a".repeat(64),
      })),
    });
    await db.authorExternalAccount.createMany({
      data: [
        {
          id: secondX,
          authorId: author.id,
          platform: "x",
          externalUserId: numeric(),
          avatarFileObjectId: avatarIds[1],
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: firstX,
          authorId: author.id,
          platform: "x",
          externalUserId: numeric(),
          avatarFileObjectId: avatarIds[0],
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: pixivId,
          authorId: author.id,
          platform: "pixiv",
          externalUserId: numeric(),
          avatarFileObjectId: avatarIds[2],
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
        {
          id: otherId,
          authorId: author.id,
          platform: "other",
          externalUserId: numeric(),
          avatarFileObjectId: avatarIds[3],
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    for (const result of [
      await service.get(author.id),
      await service.getManaged(author.id),
    ])
      assert.deepEqual(
        result.externalAccounts.map((value) => value.id),
        [otherId, firstX, secondX, pixivId],
      );
    assert.equal((await service.avatarUrl(author.id)).url, avatarIds[0]);
    await db.author.update({
      where: { id: author.id },
      data: { avatarFileObjectId: avatarIds[4] },
    });
    assert.equal((await service.avatarUrl(author.id)).url, avatarIds[4]);
    await db.author.update({
      where: { id: author.id },
      data: { avatarFileObjectId: null },
    });
    await db.authorExternalAccount.updateMany({
      where: { authorId: author.id, platform: "x" },
      data: { deletedAt: new Date(), fetchEnabled: false },
    });
    assert.equal((await service.avatarUrl(author.id)).url, avatarIds[3]);
    assert.deepEqual(
      (await service.listSourceAccounts(author.id)).map((value) => value.id),
      [otherId, firstX, secondX, pixivId],
    );
  } finally {
    await db.authorExternalAccount.deleteMany({
      where: { authorId: author.id },
    });
    await db.author.delete({ where: { id: author.id } });
    await db.fileObject.deleteMany({ where: { id: { in: avatarIds } } });
    await db.$disconnect();
  }
});
