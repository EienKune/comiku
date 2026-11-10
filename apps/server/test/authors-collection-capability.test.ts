import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { AuthorsService } from "../src/authors/authors.service.js";
import type { CreateExternalAccountDto } from "../src/authors/authors.dto.js";
import type { ContentSourceClient } from "../src/source-ingestion/content-source.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";

const input: CreateExternalAccountDto = {
  platform: "pixiv",
  externalUserId: "123456",
  fetchEnabled: true,
  firstSyncMode: "last_24_hours",
};

function adapter(
  available = true,
  supportedFirstSyncModes: ContentSourceClient["supportedFirstSyncModes"] = [
    "none",
    "last_24_hours",
  ],
): ContentSourceClient {
  return {
    platform: "pixiv",
    adapterKey: "pixiv_fixture",
    priority: 10,
    metered: false,
    available,
    supportedFirstSyncModes,
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    checkAccount: async (account) => account,
    fetchPage: async () => ({ items: [], complete: true }),
  };
}

function fixture(
  clients: ContentSourceClient[] = [],
  storedAccount?: Partial<CreateExternalAccountDto>,
  storedStates?: Record<string, unknown>[],
) {
  const sources = new ContentSourceRegistry();
  clients.forEach((client) => sources.register(client));
  type Row = CreateExternalAccountDto & {
    id: string;
    authorId: string;
    revision: number;
    metadataJson: Record<string, unknown>;
    avatarFileObjectId: null;
    deletedAt: null;
    adapterStates: Record<string, unknown>[];
  };
  let row: Row | null = storedAccount
    ? {
        ...input,
        ...storedAccount,
        id: "account",
        authorId: "author",
        revision: 2,
        metadataJson: {},
        avatarFileObjectId: null,
        deletedAt: null,
        adapterStates: storedStates ?? [
          {
            adapterKey: "pixiv_fixture",
            enabled: true,
            health: "auth_required",
            revision: 3,
            consecutiveFailures: 1,
            lastErrorMessage: "Fixture authentication expired",
          },
        ],
      }
    : null;
  const db = {
    $queryRaw: async () => [],
    author: { findFirst: async () => ({ id: "author" }) },
    authorExternalAccount: {
      findFirst: async ({
        where,
      }: {
        where: { id?: string; authorId?: string };
      }) =>
        (where.id && row?.id !== where.id) ||
        (where.authorId && row?.authorId !== where.authorId)
          ? null
          : row,
      create: async ({
        data,
      }: {
        data: Omit<Row, "adapterStates"> & {
          adapterStates: { create: { adapterKey: string; health: string }[] };
        };
      }) => {
        row = {
          ...data,
          id: "account",
          revision: 0,
          deletedAt: null,
          adapterStates: data.adapterStates.create.map((state) => ({
            ...state,
            enabled: true,
            revision: 0,
            consecutiveFailures: 0,
            lastErrorMessage: null,
          })),
        };
        return row;
      },
      updateMany: async ({ data }: { data: Partial<Row> }) => {
        row = { ...row!, ...data, revision: row!.revision + 1 };
        return { count: 1 };
      },
      findUniqueOrThrow: async () => row,
    },
    sourceAdapterState: {
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          externalAccountId: string;
          adapterKey: string | { in: string[] };
          revision?: number;
          enabled?: boolean;
        };
        data: Record<string, unknown>;
      }) => {
        const states =
          row?.adapterStates.filter(
            (state) =>
              row?.id === where.externalAccountId &&
              (typeof where.adapterKey === "string"
                ? state.adapterKey === where.adapterKey
                : where.adapterKey.in.includes(String(state.adapterKey))) &&
              (where.revision === undefined ||
                state.revision === where.revision) &&
              (where.enabled === undefined || state.enabled === where.enabled),
          ) ?? [];
        for (const state of states)
          Object.assign(state, data, { revision: Number(state.revision) + 1 });
        return { count: states.length };
      },
      findUnique: async ({
        where,
      }: {
        where: {
          externalAccountId_adapterKey: {
            externalAccountId: string;
            adapterKey: string;
          };
        };
      }) =>
        row?.adapterStates.find(
          (state) =>
            row?.id === where.externalAccountId_adapterKey.externalAccountId &&
            state.adapterKey === where.externalAccountId_adapterKey.adapterKey,
        ) ?? null,
    },
    $transaction: async <T>(action: (tx: unknown) => Promise<T>) => action(db),
  };
  const args = [
    db,
    sources,
    null,
    null,
    {
      platforms: {
        profileNetwork: async (_actor: string, run: () => Promise<unknown>) =>
          run(),
      },
    },
  ] as unknown as ConstructorParameters<typeof AuthorsService>;
  return new AuthorsService(...args);
}

test("a configured Pixiv adapter permits collection and persists the selected first-sync window", async () => {
  const service = fixture([adapter()]);
  const result = await service.createAccount("author", input);
  assert.equal(result.fetchEnabled, true);
  assert.equal(result.firstSyncMode, "last_24_hours");
  assert.equal(result.providerAvailable, true);
  assert.equal(result.profileUrl, "https://www.pixiv.net/users/123456");
  assert.deepEqual(
    result.adapterStates.map((state) => state.adapterKey),
    ["pixiv_fixture"],
  );
});

test("an existing profile-only Pixiv account can enable a supported collection window", async () => {
  const service = fixture([adapter()]);
  const created = await service.createAccount("author", {
    ...input,
    fetchEnabled: false,
    firstSyncMode: "none",
  });
  const result = await service.updateAccount("author", created.id, {
    ...input,
    expectedRevision: created.revision,
  });
  assert.equal(result.fetchEnabled, true);
  assert.equal(result.firstSyncMode, "last_24_hours");
  assert.equal(result.revision, 1);
});

test("a changed stable identity is rejected without changing the account or adapter state", async () => {
  const service = fixture([adapter()], input);
  await assert.rejects(
    service.updateAccount("author", "account", {
      ...input,
      externalUserId: "654321",
      displayNameSnapshot: "Another person",
      expectedRevision: 2,
    }),
    ConflictException,
  );
  const result = await service.updateAccount("author", "account", {
    ...input,
    displayNameSnapshot: "Same person",
    expectedRevision: 2,
  });
  assert.equal(result.id, "account");
  assert.equal(result.externalUserId, "123456");
  assert.equal(result.deletedAt, null);
  assert.equal(result.displayNameSnapshot, "Same person");
  assert.equal(result.revision, 3);
  assert.equal(result.adapterStates[0].revision, 3);
  assert.equal(result.adapterStates[0].enabled, true);
});

test("X profile errors distinguish unconfigured sources from unsupported profile capability", async () => {
  const x = { ...adapter(), platform: "x", adapterKey: "x_gallery_dl" };
  for (const clients of [[], [{ ...x, available: false }]]) {
    await assert.rejects(
      fixture(clients).resolveXProfile("actor", "artist"),
      /尚未配置/,
    );
  }
  for (const metered of [false, true])
    await assert.rejects(
      fixture([{ ...x, metered }]).resolveXProfile("actor", "artist"),
      /采集适配器尚未支持资料同步/,
    );
});

test("an available synthetic X profile capability still resolves profiles", async () => {
  const client: ContentSourceClient = {
    ...adapter(),
    platform: "x",
    adapterKey: "x_profile_fixture",
    resolveProfileByHandle: async (handle) => ({
      externalUserId: "777",
      handle,
      displayName: "Synthetic artist",
    }),
  };
  const result = await fixture([client]).resolveXProfile("actor", "artist");
  assert.equal(result.externalUserId, "777");
  assert.equal(result.displayName, "Synthetic artist");
  assert.equal(result.adapterKey, "x_profile_fixture");
});

test("missing and unavailable Pixiv adapters remain profile-only", async () => {
  for (const clients of [[], [adapter(false)]]) {
    const service = fixture(clients);
    await assert.rejects(service.createAccount("author", input));
    const result = await service.createAccount("author", {
      ...input,
      fetchEnabled: false,
      firstSyncMode: "none",
    });
    assert.equal(result.fetchEnabled, false);
    assert.equal(result.firstSyncMode, "none");
    assert.equal(result.providerAvailable, false);
  }
});

test("an unavailable adapter cannot supply a window missing from the available Pixiv adapter", async () => {
  const unavailable = { ...adapter(false), adapterKey: "pixiv_unavailable" };
  await assert.rejects(
    fixture([adapter(true, ["none"]), unavailable]).createAccount(
      "author",
      input,
    ),
  );
});

for (const [name, clients] of [
  ["removed", []],
  ["unavailable", [adapter(false)]],
  ["missing the stored window", [adapter(true, ["none"])]],
] as const) {
  test(`an existing Pixiv account can edit its nickname and pause when its adapter is ${name}`, async () => {
    const service = fixture([...clients], input);
    const edited = await service.updateAccount("author", "account", {
      ...input,
      expectedRevision: 2,
      displayNameSnapshot: "Updated fixture nickname",
    });
    assert.equal(edited.displayNameSnapshot, "Updated fixture nickname");
    assert.equal(edited.fetchEnabled, true);
    assert.equal(edited.firstSyncMode, "last_24_hours");
    const paused = await service.updateAccount("author", "account", {
      ...input,
      expectedRevision: 3,
      fetchEnabled: false,
    });
    assert.equal(paused.fetchEnabled, false);
    assert.equal(paused.firstSyncMode, "last_24_hours");
    assert.equal(paused.revision, 4);
    const editedWhilePaused = await service.updateAccount("author", "account", {
      ...input,
      expectedRevision: 4,
      fetchEnabled: false,
      displayNameSnapshot: "Paused fixture nickname",
    });
    assert.equal(
      editedWhilePaused.displayNameSnapshot,
      "Paused fixture nickname",
    );
    assert.equal(editedWhilePaused.fetchEnabled, false);
    assert.equal(editedWhilePaused.firstSyncMode, "last_24_hours");
    await assert.rejects(
      service.updateAccount("author", "account", {
        ...input,
        expectedRevision: 5,
      }),
      BadRequestException,
    );
  });
}

test("changing a stored Pixiv collection window still requires an available supporting adapter", async () => {
  const service = fixture([], { fetchEnabled: false, firstSyncMode: "none" });
  await assert.rejects(
    service.updateAccount("author", "account", {
      ...input,
      fetchEnabled: false,
      expectedRevision: 2,
    }),
    BadRequestException,
  );
});

test("unavailable Pixiv account maintenance still checks the account binding and revision", async () => {
  const service = fixture([], input);
  await assert.rejects(
    service.updateAccount("another-author", "account", {
      ...input,
      expectedRevision: 2,
    }),
    NotFoundException,
  );
  await assert.rejects(
    service.updateAccount("author", "account", {
      ...input,
      expectedRevision: 1,
      fetchEnabled: false,
    }),
    ConflictException,
  );
});

test("an existing paused X account can choose no initial backfill without a runtime", async () => {
  const service = fixture([], {
    platform: "x",
    externalUserId: "42",
    handle: "artist",
    fetchEnabled: false,
    firstSyncMode: "last_24_hours",
  });
  const saved = await service.updateAccount("author", "account", {
    fetchEnabled: false,
    firstSyncMode: "none",
    expectedRevision: 2,
  });
  assert.equal(saved.fetchEnabled, false);
  assert.equal(saved.firstSyncMode, "none");
});

test("a persisted Pixiv adapter state can be paused after its adapter is removed", async () => {
  const service = fixture([], input);
  const result = await service.updateAdapterState(
    "author",
    "account",
    "pixiv_fixture",
    { enabled: false, expectedRevision: 3 },
  );
  assert.equal(result.adapterStates[0]?.enabled, false);
  assert.equal(result.adapterStates[0]?.health, "disabled");
  assert.equal(result.adapterStates[0]?.available, false);
  assert.equal(result.adapterStates[0]?.revision, 4);
});

test("a removed adapter can only pause its own persisted state at the current revision", async () => {
  const service = fixture([], input);
  await assert.rejects(
    service.updateAdapterState("another-author", "account", "pixiv_fixture", {
      enabled: false,
      expectedRevision: 3,
    }),
    NotFoundException,
  );
  await assert.rejects(
    service.updateAdapterState("author", "account", "pixiv_fixture", {
      enabled: false,
      expectedRevision: 2,
    }),
    ConflictException,
  );
  await assert.rejects(
    service.updateAdapterState("author", "account", "pixiv_unknown", {
      enabled: false,
      expectedRevision: 3,
    }),
    NotFoundException,
  );
});

test("missing and unavailable Pixiv adapters cannot enable a persisted channel", async () => {
  for (const clients of [[], [adapter(false)]]) {
    const service = fixture(clients, input);
    await assert.rejects(
      service.updateAdapterState("author", "account", "pixiv_fixture", {
        enabled: true,
        expectedRevision: 3,
      }),
      BadRequestException,
    );
  }
});

test("an authentication failure does not prevent enabling a configured Pixiv channel", async () => {
  const service = fixture([adapter()], input);
  const result = await service.updateAdapterState(
    "author",
    "account",
    "pixiv_fixture",
    { enabled: true, expectedRevision: 3 },
  );
  assert.equal(result.adapterStates[0]?.enabled, true);
  assert.equal(result.adapterStates[0]?.health, "idle");
});

test("daily account DTO omits retired channel switches and their check timestamps", async () => {
  const service = fixture([], input, [
    {
      adapterKey: "x_web_session",
      enabled: true,
      lastAttemptAt: new Date("2026-10-28T00:00:00.000Z"),
    },
    { adapterKey: "x_official_v2", enabled: true },
    {
      adapterKey: "pixiv_gallery_dl",
      enabled: false,
      health: "disabled",
      revision: 3,
      consecutiveFailures: 0,
      lastErrorMessage: null,
    },
  ]);
  const result = await service.updateAccount("author", "account", {
    ...input,
    fetchEnabled: false,
    expectedRevision: 2,
  });
  assert.deepEqual(
    result.adapterStates.map((state) => state.adapterKey),
    ["pixiv_gallery_dl"],
  );
  assert.equal(result.adapterStates[0].enabled, false);
  assert.equal(result.lastCheckedAt, null);
});

test("reactivating a restored account enables its internal permission without resetting recovery state", async () => {
  const recovery = {
    cursorJson: { page: 4 },
    discoveryCheckpointJson: { last: "opaque" },
    nextAttemptAt: new Date("2099-01-01"),
    fetchLeaseId: "retained",
    lastErrorMessage: "retained",
  };
  const service = fixture(
    [adapter()],
    { fetchEnabled: false, firstSyncMode: "none" },
    [
      {
        adapterKey: "pixiv_fixture",
        enabled: false,
        health: "disabled",
        revision: 3,
        consecutiveFailures: 2,
        ...recovery,
      },
    ],
  );
  const saved = await service.updateAccount("author", "account", {
    fetchEnabled: true,
    firstSyncMode: "none",
    expectedRevision: 2,
  });
  assert.equal(saved.adapterStates[0].enabled, true);
  assert.equal(saved.adapterStates[0].revision, 4);
  assert.equal(
    saved.adapterStates[0].lastErrorMessage,
    recovery.lastErrorMessage,
  );
  assert.equal(
    saved.adapterStates[0].nextAttemptAt,
    new Date(recovery.nextAttemptAt).toISOString(),
  );
});
