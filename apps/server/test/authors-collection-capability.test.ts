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
        adapterStates: [
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
          adapterKey: string;
          revision: number;
        };
        data: Record<string, unknown>;
      }) => {
        const state = row?.adapterStates.find(
          (state) =>
            row?.id === where.externalAccountId &&
            state.adapterKey === where.adapterKey &&
            state.revision === where.revision,
        );
        if (!state) return { count: 0 };
        Object.assign(state, data, { revision: where.revision + 1 });
        return { count: 1 };
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
    null,
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
