import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorsService } from "../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
function fixture(
  options: {
    platform?: "x" | "pixiv";
    returnedId?: string;
    boundUnavailable?: boolean;
    avatarFileObjectId?: string;
    avatarDownloadSucceeds?: boolean;
    conflictOnWrite?: boolean;
  } = {},
) {
  const registry = new ContentSourceRegistry();
  registry.register({
    platform: options.platform ?? "x",
    adapterKey: "x_fixture",
    available: true,
    priority: 1,
    metered: false,
    supportedFirstSyncModes: ["none", "last_24_hours"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    fetchPage: async () => ({ items: [], complete: true }),
    checkAccount: async (a) => ({
      externalUserId: options.returnedId ?? a.externalUserId,
      handle: "latest",
      avatarUrl: "https://pbs.twimg.com/profile_images/42/a.jpg",
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
    platform: options.platform ?? "x",
    externalUserId: "42",
    handle: "old",
    revision: 0,
    metadataJson: {},
    notes: "retained private note",
    fetchEnabled: false,
    firstSyncMode: "none",
    deletedAt: null,
    avatarFileObjectId: options.avatarFileObjectId ?? null,
    adapterStates: [],
  };
  const db = {
    sourceAdapterState: { updateMany: async () => ({ count: 0 }) },
    author: { findFirst: async () => ({ id: "author" }) },
    fileObject: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        [options.avatarFileObjectId, "new-avatar"].includes(where.id)
          ? { id: where.id }
          : null,
    },
    authorExternalAccount: {
      findFirst: async ({
        where,
      }: {
        where: { externalUserId?: string; id?: string };
      }) =>
        where.externalUserId || !where.id || options.boundUnavailable
          ? null
          : current,
      findUniqueOrThrow: async () => current,
      create: async ({ data }: { data: Record<string, unknown> }) =>
        (current = { ...current, ...data, adapterStates: [] }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.conflictOnWrite) return { count: 0 };
        current = { ...current, ...data, revision: 1 };
        return { count: 1 };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const scopes: string[] = [];
  let networkCalls = 0;
  const sourceFetch = {
    platforms: {
      profileNetwork: async (
        _actor: string,
        fn: () => Promise<unknown>,
        platform = "x",
      ) => {
        scopes.push(platform);
        networkCalls++;
        return fn();
      },
    },
  };
  const args = [
    db,
    registry,
    {
      store: async () => ({ id: "new-avatar" }),
      signedReadUrl: async () => ({ url: "https://files.invalid/new-avatar" }),
    },
    {
      download: async () => {
        if (options.avatarDownloadSucceeds)
          return { body: Buffer.from("avatar"), contentType: "image/jpeg" };
        throw new Error("optional avatar failed");
      },
    },
    sourceFetch,
  ] as unknown as ConstructorParameters<typeof AuthorsService>;
  const service = new AuthorsService(...args);
  return {
    service,
    row: () => current,
    scopes,
    networkCalls: () => networkCalls,
  };
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
  assert.equal(account.avatarAvailable, false);
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
  assert.equal(row().avatarFileObjectId, null);
});

test("canonical X handle maintenance does not require profile synchronization", async () => {
  for (const handle of [
    " @OLD ",
    "https://x.com/old",
    "https://twitter.com/old",
  ]) {
    const { service, row } = fixture();
    const saved = await service.updateAccount(
      "author",
      "account",
      {
        handle,
        notes: "maintenance",
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: 0,
      },
      "actor",
    );
    assert.equal(saved.handle?.toLowerCase(), "old");
    assert.equal(row().notes, "maintenance");
  }
});

test("same-identity proof refresh retains the observed avatar when its download fails", async () => {
  const { service, row } = fixture({ avatarFileObjectId: "trusted-avatar" });
  const profile = await service.resolveXProfile(
    "actor",
    "old",
    "author",
    "account",
  );
  assert.equal(profile.avatarFileObjectId, null);
  const saved = await service.updateAccount(
    "author",
    "account",
    {
      externalUserId: "42",
      handle: profile.handle,
      avatarFileObjectId: null,
      profileProof: profile.profileProof,
      fetchEnabled: false,
      firstSyncMode: "none",
      expectedRevision: 0,
    },
    "actor",
  );
  assert.equal(row().avatarFileObjectId, "trusted-avatar");
  assert.equal(saved.avatarAvailable, true);
  assert.equal(saved.handle, "latest");
  assert.equal(saved.externalUserId, "42");
  assert.equal(saved.fetchEnabled, false);
  assert.equal(saved.firstSyncMode, "none");
});

test("explicit null avatar without a proof removes the observed avatar", async () => {
  const { service, row } = fixture({ avatarFileObjectId: "trusted-avatar" });
  const saved = await service.updateAccount(
    "author",
    "account",
    {
      avatarFileObjectId: null,
      fetchEnabled: false,
      firstSyncMode: "none",
      expectedRevision: 0,
    },
    "actor",
  );
  assert.equal(row().avatarFileObjectId, null);
  assert.equal(saved.avatarAvailable, false);
});

test("a successfully downloaded proof avatar replaces the observed avatar", async () => {
  const { service, row } = fixture({
    avatarFileObjectId: "trusted-avatar",
    avatarDownloadSucceeds: true,
  });
  const profile = await service.resolveXProfile(
    "actor",
    "old",
    "author",
    "account",
  );
  assert.equal(profile.avatarFileObjectId, "new-avatar");
  await service.updateAccount(
    "author",
    "account",
    {
      handle: profile.handle,
      avatarFileObjectId: profile.avatarFileObjectId,
      profileProof: profile.profileProof,
      fetchEnabled: false,
      firstSyncMode: "none",
      expectedRevision: 0,
    },
    "actor",
  );
  assert.equal(row().avatarFileObjectId, "new-avatar");
});

test("a failed proof avatar download does not accept a client avatar ID", async () => {
  const { service, row } = fixture({ avatarFileObjectId: "trusted-avatar" });
  const profile = await service.resolveXProfile(
    "actor",
    "old",
    "author",
    "account",
  );
  await assert.rejects(
    service.updateAccount(
      "author",
      "account",
      {
        handle: profile.handle,
        avatarFileObjectId: "new-avatar",
        profileProof: profile.profileProof,
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: 0,
      },
      "actor",
    ),
    /凭证与账号不一致/,
  );
  assert.equal(row().avatarFileObjectId, "trusted-avatar");
  assert.equal(row().revision, 0);
});

test("avatar retention cannot bypass a lost account revision CAS", async () => {
  const { service, row } = fixture({
    avatarFileObjectId: "trusted-avatar",
    conflictOnWrite: true,
  });
  const profile = await service.resolveXProfile(
    "actor",
    "old",
    "author",
    "account",
  );
  await assert.rejects(
    service.updateAccount(
      "author",
      "account",
      {
        handle: profile.handle,
        avatarFileObjectId: null,
        profileProof: profile.profileProof,
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: 0,
      },
      "actor",
    ),
    /平台账号已更新/,
  );
  assert.equal(row().avatarFileObjectId, "trusted-avatar");
  assert.equal(row().revision, 0);
  assert.equal(row().handle, "old");
});

test("Pixiv manual metadata remains compatible but naked avatar and cross-platform evidence are rejected", async () => {
  const f = fixture({ platform: "pixiv" });
  await f.service.createAccount(
    "author",
    {
      platform: "pixiv",
      externalUserId: "42",
      profileSyncAdapter: "forged",
      profileSyncedAt: new Date().toISOString(),
      fetchEnabled: false,
      firstSyncMode: "none",
    },
    "actor",
  );
  assert.equal(
    (f.row().metadataJson as Record<string, unknown>).profileSyncAdapter,
    undefined,
  );
  await assert.rejects(
    f.service.createAccount(
      "author",
      {
        platform: "pixiv",
        externalUserId: "42",
        avatarFileObjectId: "new-avatar",
        fetchEnabled: false,
        firstSyncMode: "none",
      },
      "actor",
    ),
    /凭证/,
  );
  const x = fixture();
  const profile = await x.service.resolveXProfile("actor", "artist", "author");
  await assert.rejects(
    f.service.createAccount(
      "author",
      {
        platform: "pixiv",
        externalUserId: "42",
        profileProof: profile.profileProof,
        fetchEnabled: false,
        firstSyncMode: "none",
      },
      "actor",
    ),
    /凭证/,
  );
});
test("Pixiv sync uses its own scope and preserves notes, settings and failed optional avatar", async () => {
  const f = fixture({
    platform: "pixiv",
    avatarFileObjectId: "trusted-avatar",
  });
  const profile = await f.service.resolvePixivProfile(
    "actor",
    "42",
    "author",
    "account",
  );
  assert.equal(profile.handle, null);
  assert.equal(profile.profileUrl, "https://www.pixiv.net/users/42");
  assert.deepEqual(f.scopes, ["pixiv"]);
  await f.service.updateAccount(
    "author",
    "account",
    {
      externalUserId: "42",
      profileProof: profile.profileProof,
      avatarFileObjectId: null,
      displayNameSnapshot: profile.displayName,
      fetchEnabled: false,
      firstSyncMode: "none",
      expectedRevision: 0,
    },
    "actor",
  );
  assert.equal(f.row().avatarFileObjectId, "trusted-avatar");
  assert.equal(f.row().notes, "retained private note");
  assert.equal(f.row().firstSyncMode, "none");
  assert.equal(f.row().fetchEnabled, false);
  assert.equal(
    (f.row().metadataJson as Record<string, unknown>).profileSyncAdapter,
    "x_fixture",
  );
});
test("Pixiv numeric mismatch rejects before network and returned mismatch never yields proof", async () => {
  const f = fixture({ platform: "pixiv" });
  await assert.rejects(
    f.service.resolvePixivProfile("actor", "43", "author", "account"),
    /身份|ID/,
  );
  assert.equal(f.networkCalls(), 0);
  const bad = fixture({ platform: "pixiv", returnedId: "43" });
  await assert.rejects(
    bad.service.resolvePixivProfile("actor", "42"),
    /身份|绑定/,
  );
});
test("Pixiv successful avatar adoption still obeys account revision CAS", async () => {
  for (const conflictOnWrite of [false, true]) {
    const f = fixture({
      platform: "pixiv",
      avatarFileObjectId: "trusted-avatar",
      avatarDownloadSucceeds: true,
      conflictOnWrite,
    });
    const p = await f.service.resolvePixivProfile(
      "actor",
      "42",
      "author",
      "account",
    );
    const save = f.service.updateAccount(
      "author",
      "account",
      {
        profileProof: p.profileProof,
        avatarFileObjectId: p.avatarFileObjectId,
        fetchEnabled: false,
        firstSyncMode: "none",
        expectedRevision: 0,
      },
      "actor",
    );
    if (conflictOnWrite) {
      await assert.rejects(save, /已更新/);
      assert.equal(f.row().avatarFileObjectId, "trusted-avatar");
    } else {
      await save;
      assert.equal(f.row().avatarFileObjectId, "new-avatar");
    }
  }
});

test("Pixiv resolution rejects unscoped, missing and archived bindings before network", async () => {
  const f = fixture({ platform: "pixiv", boundUnavailable: true });
  await assert.rejects(
    f.service.resolvePixivProfile("actor", "42", "author", "account"),
    /不存在/,
  );
  await assert.rejects(
    f.service.resolvePixivProfile("actor", "42", undefined, "account"),
    /不存在/,
  );
  assert.equal(f.networkCalls(), 0);
});
