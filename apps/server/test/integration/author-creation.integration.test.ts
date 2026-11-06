import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ProfileProofs } from "../../src/authors/profile-proof.js";
import { AuthorsService } from "../../src/authors/authors.service.js";
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

test("author creation atomically binds accounts and actor-scoped retries recover a committed result", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
  );
  const prefix = `creation_${randomUUID()}`;
  const avatarIds: string[] = [];
  const source = await db.user.create({
    data: {
      username: prefix,
      displayName: prefix,
      passwordHash: "fixture",
      mustChangePassword: false,
      roles: { create: { role: "source" } },
    },
  });
  const other = await db.user.create({
    data: {
      username: `${prefix}_other`,
      displayName: prefix,
      passwordHash: "fixture",
      mustChangePassword: false,
      roles: { create: { role: "source" } },
    },
  });
  const xIdentity = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const registry = new ContentSourceRegistry().register({
    platform: "x",
    adapterKey: "creation_profile_fixture",
    priority: 1,
    metered: false,
    available: true,
    supportedFirstSyncModes: ["none", "last_24_hours"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    checkAccount: async (account) => account,
    resolveProfileByHandle: async (handle) => ({
      externalUserId: xIdentity,
      handle,
      displayName: "Synthetic artist",
    }),
    fetchPage: async () => {
      throw new Error("Creation never fetches source pages");
    },
  });
  const service = new AuthorsService(
    db,
    registry,
    {} as never,
    {} as never,
    {
      platforms: {
        profileNetwork: async <T>(_actorId: string, run: () => Promise<T>) =>
          run(),
      },
    } as never,
  );
  try {
    const profile = await service.resolveXProfile(source.id, "create_fixture");
    const existing = await db.author.create({
      data: {
        displayName: prefix,
        externalAccounts: {
          create: {
            platform: "pixiv",
            externalUserId: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
            fetchEnabled: false,
          },
        },
      },
      include: { externalAccounts: true },
    });
    const input = {
      displayName: prefix,
      sourceLanguage: "ja" as const,
      authorizationStatus: "authorized" as const,
      tagNames: [],
      idempotencyKey: randomUUID(),
      accounts: [
        {
          platform: "x",
          externalUserId: profile.externalUserId,
          handle: profile.handle,
          profileProof: profile.profileProof,
          fetchEnabled: true,
          firstSyncMode: "last_24_hours" as const,
        },
        {
          platform: "pixiv",
          externalUserId: existing.externalAccounts[0].externalUserId,
          fetchEnabled: false,
          firstSyncMode: "none" as const,
        },
      ],
    };
    await assert.rejects(service.create(input, source.id), ConflictException);
    assert.equal(
      await db.author.count({ where: { displayName: prefix } }),
      1,
      "a failed account insert must roll back its author",
    );
    assert.equal(
      await db.authorExternalAccount.count({
        where: { platform: "x", externalUserId: xIdentity },
      }),
      0,
      "earlier account inserts roll back too",
    );
    const uniqueInput = {
      ...input,
      accounts: [
        input.accounts[0],
        {
          ...input.accounts[1],
          externalUserId: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
        },
      ],
    };
    const results = await Promise.all([
      service.create(uniqueInput, source.id),
      service.create(uniqueInput, source.id),
    ]);
    assert.equal(
      results[0].id,
      results[1].id,
      "concurrent retries return the same author",
    );
    assert.equal(results[0].externalAccounts.length, 2);
    assert.equal(
      (
        await service.create(
          {
            ...uniqueInput,
            accounts: uniqueInput.accounts.map((account) => ({
              ...account,
              profileProof: "expired-transport-proof",
            })),
          },
          source.id,
        )
      ).id,
      results[0].id,
    );
    // The caller deliberately discards its first response, exactly as a lost HTTP response does.
    const recovered = await service.getCreationResult(
      source.id,
      input.idempotencyKey,
    );
    assert.equal(recovered?.id, results[0].id);
    assert.equal(
      await service.getCreationResult(other.id, input.idempotencyKey),
      null,
    );
    const otherResult = await service.create(
      { ...uniqueInput, accounts: [] },
      other.id,
    );
    assert.notEqual(otherResult.id, results[0].id);
    await assert.rejects(
      service.create(
        { ...uniqueInput, displayName: `${prefix}_changed` },
        source.id,
      ),
      ConflictException,
    );
    assert.equal(await db.author.count({ where: { displayName: prefix } }), 3);
    await assert.rejects(
      service.create(
        {
          ...uniqueInput,
          idempotencyKey: randomUUID(),
          accounts: [uniqueInput.accounts[1], uniqueInput.accounts[1]],
        },
        source.id,
      ),
      /每个平台/,
    );
    assert.equal(await db.author.count({ where: { displayName: prefix } }), 3);
    // Both accounts are saved, but the explicitly selected trusted Pixiv avatar
    // becomes the author's own avatar ahead of the normal X-account fallback.
    const proofs = new ProfileProofs();
    const chosenAccounts = [];
    for (const platform of ["x", "pixiv"] as const) {
      const file = await db.fileObject.create({
        data: {
          objectKey: `${prefix}/${platform}.png`,
          bucketScope: "private",
          kind: "source_profile_avatar",
          contentType: "image/png",
          size: 1n,
          checksum: "a".repeat(64),
        },
      });
      avatarIds.push(file.id);
      const externalUserId = BigInt(
        `0x${randomUUID().replaceAll("-", "").slice(0, 15)}`,
      ).toString();
      const handle = platform === "x" ? "selected" : null;
      chosenAccounts.push({
        platform,
        externalUserId,
        handle,
        avatarFileObjectId: file.id,
        profileProof: proofs.issue(
          {
            platform,
            externalUserId,
            handle,
            avatarFileObjectId: file.id,
            adapterKey: `${platform}_fixture`,
            syncedAt: new Date().toISOString(),
          },
          source.id,
        ),
        fetchEnabled: false,
        firstSyncMode: "none" as const,
      });
    }
    const chosenInput = {
      ...uniqueInput,
      displayName: `${prefix}_selected`,
      idempotencyKey: randomUUID(),
      accounts: chosenAccounts,
      profileSourcePlatform: "pixiv" as const,
    };
    const beforeChosen = await db.author.count({
      where: { displayName: { startsWith: prefix } },
    });
    for (const invalidAccounts of [
      [],
      [
        {
          ...chosenAccounts[1]!,
          profileProof: undefined,
          avatarFileObjectId: null,
        },
      ],
      [{ ...chosenAccounts[1]!, avatarFileObjectId: avatarIds[0] }],
    ]) {
      await assert.rejects(
        service.create(
          {
            ...chosenInput,
            idempotencyKey: randomUUID(),
            accounts: invalidAccounts,
          },
          source.id,
        ),
      );
      assert.equal(
        await db.author.count({
          where: { displayName: { startsWith: prefix } },
        }),
        beforeChosen,
      );
    }
    const chosen = await service.create(chosenInput, source.id);
    assert.equal(chosen.externalAccounts.length, 2);
    assert.equal(chosen.displayName, chosenInput.displayName);
    assert.equal(
      (await db.author.findUniqueOrThrow({ where: { id: chosen.id } }))
        .avatarFileObjectId,
      avatarIds[1],
    );
    const replay = await service.create(
      {
        ...chosenInput,
        accounts: chosenAccounts.map((account) => ({
          ...account,
          profileProof: "expired-transport-proof",
        })),
      },
      source.id,
    );
    assert.equal(replay.id, chosen.id);
    await assert.rejects(
      service.create({ ...chosenInput, profileSourcePlatform: "x" }, source.id),
      ConflictException,
    );
    await db.userRole.deleteMany({ where: { userId: source.id } });
    await assert.rejects(
      service.create(uniqueInput, source.id),
      ForbiddenException,
    );
    await assert.rejects(
      service.getCreationResult(source.id, input.idempotencyKey),
      ForbiddenException,
    );
  } finally {
    await db.authorCreationRequest?.deleteMany({
      where: { actorId: { in: [source.id, other.id] } },
    });
    const ids = (
      await db.author.findMany({
        where: { displayName: { startsWith: prefix } },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await db.sourceAdapterState.deleteMany({
      where: { externalAccount: { authorId: { in: ids } } },
    });
    await db.authorExternalAccount.deleteMany({
      where: { authorId: { in: ids } },
    });
    await db.author.deleteMany({ where: { id: { in: ids } } });
    await db.fileObject.deleteMany({ where: { id: { in: avatarIds } } });
    await db.userRole.deleteMany({
      where: { userId: { in: [source.id, other.id] } },
    });
    await db.user.deleteMany({ where: { id: { in: [source.id, other.id] } } });
    await db.$disconnect();
  }
});
