import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorsService } from "../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
function fixture() {
  const registry = new ContentSourceRegistry();
  registry.register({
    platform: "x",
    adapterKey: "x_fixture",
    available: true,
    priority: 1,
    metered: false,
    supportedFirstSyncModes: ["none", "last_24_hours"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    fetchPage: async () => ({ items: [], complete: true }),
    checkAccount: async (a) => ({
      externalUserId: a.externalUserId,
      handle: "latest",
    }),
    resolveProfileByHandle: async (h) => ({
      externalUserId: "42",
      handle: h,
      avatarUrl: "https://pbs.twimg.com/profile_images/42/a.jpg",
    }),
  });
  let current = {
    id: "account",
    authorId: "author",
    platform: "x",
    externalUserId: "42",
    handle: "old",
    revision: 0,
    metadataJson: {},
    fetchEnabled: false,
    firstSyncMode: "none",
    deletedAt: null,
    avatarFileObjectId: null,
    adapterStates: [],
  };
  const db = {
    author: { findFirst: async () => ({ id: "author" }) },
    authorExternalAccount: {
      findFirst: async ({
        where,
      }: {
        where: { externalUserId?: string; id?: string };
      }) => (where.externalUserId || !where.id ? null : current),
      findUniqueOrThrow: async () => current,
      create: async ({ data }: { data: Record<string, unknown> }) =>
        (current = { ...current, ...data, adapterStates: [] }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...current, ...data, revision: 1 };
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const sourceFetch = {
    platforms: {
      profileNetwork: async (_actor: string, fn: () => Promise<unknown>) =>
        fn(),
    },
  };
  const args = [
    db,
    registry,
    {},
    {
      download: async () => {
        throw new Error("optional avatar failed");
      },
    },
    sourceFetch,
  ] as unknown as ConstructorParameters<typeof AuthorsService>;
  const service = new AuthorsService(...args);
  return { service, row: () => current };
}
test("new X binding rejects naked client identity and timestamps", async () => {
  const { service } = fixture();
  await assert.rejects(
    service.createAccount(
      "author",
      {
        platform: "x",
        externalUserId: "42",
        handle: "artist",
        profileSyncedAt: new Date().toISOString(),
        fetchEnabled: false,
        firstSyncMode: "none",
      },
      "actor",
    ),
    /同步|凭证/,
  );
});
test("valid proof binds identity and actor, while avatar failure does not block profile resolution", async () => {
  const { service } = fixture();
  const profile = await service.resolveXProfile("actor", "artist", "author");
  assert.equal(profile.externalUserId, "42");
  assert.equal(profile.avatarFileObjectId, null);
  await assert.rejects(
    service.createAccount(
      "author",
      {
        platform: "x",
        externalUserId: "43",
        handle: profile.handle,
        profileProof: profile.profileProof,
        fetchEnabled: false,
        firstSyncMode: "none",
      },
      "actor",
    ),
  );
  const account = await service.createAccount(
    "author",
    {
      platform: "x",
      externalUserId: "42",
      handle: profile.handle,
      profileProof: profile.profileProof,
      fetchEnabled: false,
      firstSyncMode: "none",
    },
    "actor",
  );
  assert.equal(account.handle, "artist");
});
test("editing handle or enabling X collection requires proof but pausing and metadata maintenance remain available", async () => {
  const { service, row } = fixture();
  await assert.rejects(
    service.updateAccount(
      "author",
      "account",
      {
        handle: "other",
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: 0,
      },
      "actor",
    ),
  );
  await assert.rejects(
    service.updateAccount(
      "author",
      "account",
      {
        fetchEnabled: true,
        firstSyncMode: "last_24_hours",
        expectedRevision: 0,
      },
      "actor",
    ),
  );
  assert.equal(row().handle, "old");
  const refreshed = await service.resolveXProfile(
    "actor",
    "old",
    "author",
    "account",
  );
  assert.equal(refreshed.handle, "latest");
  const saved = await service.updateAccount(
    "author",
    "account",
    {
      handle: refreshed.handle,
      profileProof: refreshed.profileProof,
      fetchEnabled: true,
      firstSyncMode: "last_24_hours",
      expectedRevision: 0,
    },
    "actor",
  );
  assert.equal(saved.externalUserId, "42");
  assert.equal(saved.handle, "latest");
});
