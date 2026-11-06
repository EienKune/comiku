import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { CreateAuthorAccountDto } from "../src/authors/authors.dto.js";
import { AuthorsService } from "../src/authors/authors.service.js";
import { ProfileProofs } from "../src/authors/profile-proof.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
const base = {
  displayName: "Manually edited name",
  sourceLanguage: "ja" as const,
  authorizationStatus: "authorized" as const,
  tagNames: [],
};
function fixture() {
  const proofs = new ProfileProofs();
  const accounts: CreateAuthorAccountDto[] = (["x", "pixiv"] as const).map(
    (platform) => ({
      platform,
      externalUserId: "42",
      handle: platform === "x" ? "artist" : null,
      avatarFileObjectId: `${platform}-avatar`,
      profileProof: proofs.issue(
        {
          platform,
          externalUserId: "42",
          handle: platform === "x" ? "artist" : null,
          avatarFileObjectId: `${platform}-avatar`,
          adapterKey: `${platform}_fixture`,
          syncedAt: new Date().toISOString(),
        },
        "actor",
      ),
      fetchEnabled: false,
      firstSyncMode: "none" as const,
    }),
  );
  const now = new Date();
  let writes = 0;
  const row: Record<string, unknown> = {
    id: "author",
    ...base,
    revision: 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    externalAccounts: [],
  };
  const db = {
    $queryRaw: async () => [],
    user: { count: async () => 1 },
    author: {
      create: async ({ data }: { data: object }) => {
        writes++;
        Object.assign(row, data);
        return row;
      },
      findUniqueOrThrow: async () => ({
        ...row,
        tags: [],
        externalAccounts: [],
      }),
    },
    fileObject: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        ["x-avatar", "pixiv-avatar"].includes(where.id)
          ? { id: where.id }
          : null,
    },
    authorExternalAccount: {
      create: async () => {
        writes++;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const registry = new ContentSourceRegistry().register({
    platform: "x",
    adapterKey: "x_fixture",
    priority: 1,
    available: true,
    metered: false,
    supportedFirstSyncModes: ["none"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    checkAccount: async (a) => a,
    fetchPage: async () => ({ items: [], complete: true }),
  });
  const service = new AuthorsService(
    db as never,
    registry,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, accounts, row, writes: () => writes };
}
test("selected Pixiv trusted profile supplies the author avatar while both platform accounts survive", async () => {
  const f = fixture();
  const saved = await f.service.create(
    { ...base, accounts: f.accounts, profileSourcePlatform: "pixiv" },
    "actor",
  );
  assert.equal(saved.displayName, base.displayName);
  assert.equal(f.row.avatarFileObjectId, "pixiv-avatar");
  assert.equal(f.writes(), 3);
});
test("selected author profile requires a matching proved account before writes", async () => {
  for (const mode of [
    "missing",
    "unproved",
    "forged",
    "wrong-platform",
  ] as const) {
    const f = fixture();
    const account = {
      ...f.accounts[1]!,
      ...(mode === "unproved"
        ? { profileProof: undefined, avatarFileObjectId: null }
        : mode === "forged"
          ? { avatarFileObjectId: "x-avatar" }
          : mode === "wrong-platform"
            ? { profileProof: f.accounts[0]!.profileProof }
            : {}),
    };
    await assert.rejects(
      f.service.create(
        {
          ...base,
          profileSourcePlatform: "pixiv",
          accounts: mode === "missing" ? [] : [account],
        },
        "actor",
      ),
    );
    assert.equal(f.writes(), 0);
  }
});
test("profile source affects creation intent only when explicitly supplied", () => {
  const f = fixture();
  const hash = (input: object) =>
    (
      f.service as unknown as { creationPayloadHash(input: object): string }
    ).creationPayloadHash(input);
  const input = { ...base, accounts: f.accounts };
  assert.equal(
    hash(input),
    hash({ ...input, profileSourcePlatform: undefined }),
  );
  assert.notEqual(
    hash(input),
    hash({ ...input, profileSourcePlatform: "pixiv" }),
  );
  assert.notEqual(
    hash({ ...input, profileSourcePlatform: "x" }),
    hash({ ...input, profileSourcePlatform: "pixiv" }),
  );
});

test("selected valid profile may have a null optional avatar", async () => {
  const f = fixture();
  f.accounts[1] = {
    ...f.accounts[1]!,
    avatarFileObjectId: null,
    profileProof: new ProfileProofs().issue(
      {
        platform: "pixiv",
        externalUserId: "42",
        handle: null,
        avatarFileObjectId: null,
        adapterKey: "pixiv_fixture",
        syncedAt: new Date().toISOString(),
      },
      "actor",
    ),
  };
  await f.service.create(
    { ...base, accounts: f.accounts, profileSourcePlatform: "pixiv" },
    "actor",
  );
  assert.equal(f.row.avatarFileObjectId, null);
});
