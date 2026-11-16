import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorsService } from "../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";

function fixture() {
  const row = (id: string, externalUserId: string, deletedAt: Date | null) => ({
    id,
    authorId: "author",
    platform: "pixiv",
    externalUserId,
    handle: null,
    profileUrl: null,
    displayNameSnapshot: null,
    notes: null,
    avatarFileObjectId: null,
    fetchEnabled: false,
    firstSyncMode: "none",
    revision: 0,
    metadataJson: {},
    deletedAt,
    adapterStates: [],
  });
  const rows = [row("active", "42", null), row("historical", "43", new Date())];
  const db = {
    $queryRaw: async () => [],
    author: { findFirst: async () => ({ id: "author" }) },
    authorExternalAccount: {
      findFirst: async ({
        where,
      }: {
        where: { id?: string; deletedAt?: null };
      }) =>
        rows.find((item) =>
          where.id ? item.id === where.id : item.deletedAt === null,
        ),
      create: async ({
        data,
      }: {
        data: { externalUserId: string; fetchEnabled: boolean };
      }) => {
        const added = {
          ...row("new", data.externalUserId, null),
          fetchEnabled: data.fetchEnabled,
        };
        rows.push(added);
        return added;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; revision: number };
        data: { deletedAt: null; fetchEnabled: boolean };
      }) => {
        const item = rows.find(
          (item) =>
            item.id === where.id &&
            item.revision === where.revision &&
            item.deletedAt !== null,
        );
        if (!item) return { count: 0 };
        Object.assign(item, data, { revision: item.revision + 1 });
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
        rows.find((item) => item.id === where.id),
    },
    $transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(db),
  };
  return {
    rows,
    service: new AuthorsService(
      db as never,
      new ContentSourceRegistry(),
      {} as never,
      {} as never,
      {} as never,
    ),
  };
}

test("adding another account on the same platform keeps the original active identity", async () => {
  const f = fixture();
  const result = await f.service.createAccount("author", {
    platform: "pixiv",
    externalUserId: "44",
    fetchEnabled: false,
    firstSyncMode: "none",
  });
  assert.equal(result.externalUserId, "44");
  assert.deepEqual(
    f.rows
      .filter((row) => row.deletedAt === null)
      .map((row) => row.externalUserId),
    ["42", "44"],
  );
});

test("restoring a historical same-platform identity leaves collection disabled", async () => {
  const f = fixture();
  const result = await f.service.restoreAccount("author", "historical", 0);
  assert.equal(result.deletedAt, null);
  assert.equal(result.fetchEnabled, false);
  assert.equal(result.revision, 1);
  assert.deepEqual(
    f.rows
      .filter((row) => row.deletedAt === null)
      .map((row) => row.externalUserId),
    ["42", "43"],
  );
  await assert.rejects(
    f.service.restoreAccount("author", "historical", 0),
    /已更新/,
  );
});

test("author avatar uses explicit file, then X, then chronological account identity ties", async () => {
  const sameTime = new Date("2026-01-02T00:00:00.000Z");
  const rows = [
    {
      id: "x-b",
      platform: "x",
      createdAt: sameTime,
      avatarFileObjectId: "x-later-tie",
    },
    {
      id: "x-a",
      platform: "x",
      createdAt: sameTime,
      avatarFileObjectId: "x-first-tie",
    },
    {
      id: "other-b",
      platform: "other",
      createdAt: sameTime,
      avatarFileObjectId: "other-later",
    },
    {
      id: "pixiv",
      platform: "pixiv",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      avatarFileObjectId: "pixiv-earliest",
    },
  ];
  let explicit: string | null = "explicit";
  let accounts = rows;
  const db = {
    author: {
      findFirst: async ({
        include,
      }: {
        include: { externalAccounts: { orderBy: Record<string, "asc">[] } };
      }) => ({
        avatarFileObjectId: explicit,
        externalAccounts: [...accounts].sort((left, right) => {
          for (const field of include.externalAccounts.orderBy.flatMap(
            Object.keys,
          )) {
            const a = left[field as keyof typeof left],
              b = right[field as keyof typeof right];
            if (a < b) return -1;
            if (a > b) return 1;
          }
          return 0;
        }),
      }),
    },
  };
  const service = new AuthorsService(
    db as never,
    new ContentSourceRegistry(),
    { signedReadUrl: async (id: string) => ({ url: id }) } as never,
    {} as never,
    {} as never,
  );
  assert.equal((await service.avatarUrl("author")).url, "explicit");
  explicit = null;
  assert.equal((await service.avatarUrl("author")).url, "x-first-tie");
  accounts = rows.filter((row) => row.platform !== "x");
  assert.equal((await service.avatarUrl("author")).url, "pixiv-earliest");
});
