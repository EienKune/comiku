import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { candidateReviewFixture } from "./candidate-review-fixture.js";
import { AuthorsService } from "../../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";

test("the single-control migration preserves pause intent and all runtime recovery fields", async () => {
  const f = await candidateReviewFixture();
  const schema = `controls_${randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback isolated collection migration");
  const migration = await readFile(
    new URL(
      "../../prisma/migrations/20261106000200_author_collection_controls/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  try {
    await assert.rejects(
      f.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(
          `SET LOCAL search_path TO "${schema}", public`,
        );
        await tx.$executeRawUnsafe(
          "CREATE TABLE authors (id text PRIMARY KEY, deleted_at timestamptz)",
        );
        await tx.$executeRawUnsafe(
          "CREATE TABLE author_external_accounts (id text PRIMARY KEY, author_id text, platform text, deleted_at timestamptz, fetch_enabled boolean, revision int)",
        );
        await tx.$executeRawUnsafe(
          "CREATE TABLE source_adapter_states (external_account_id text, adapter_key text, enabled boolean, revision int, recovery jsonb)",
        );
        await tx.$executeRawUnsafe(
          "INSERT INTO authors VALUES ('active',NULL),('archived',now())",
        );
        await tx.$executeRawUnsafe(
          "INSERT INTO author_external_accounts VALUES ('x','active','x',NULL,true,3),('p','active','pixiv',NULL,false,4),('old','active','x',NULL,true,5),('archived','archived','x',NULL,true,6)",
        );
        for (const [id, key] of [
          ["x", "x_gallery_dl"],
          ["p", "pixiv_gallery_dl"],
          ["old", "x_web_session"],
          ["archived", "x_gallery_dl"],
        ])
          await tx.$executeRawUnsafe(
            "INSERT INTO source_adapter_states VALUES ($1,$2,false,7,$3::jsonb)",
            id,
            key,
            JSON.stringify({
              cursor: { page: 9 },
              checkpoint: { next: "opaque" },
              lease: randomUUID(),
              cooldown: "2099-01-01",
              error: "retained",
            }),
          );
        const before = await tx.$queryRawUnsafe<
          { external_account_id: string; recovery: unknown }[]
        >(
          "SELECT external_account_id,recovery FROM source_adapter_states ORDER BY external_account_id",
        );
        for (const statement of migration
          .split(";")
          .filter((part) => part.trim()))
          await tx.$executeRawUnsafe(statement);
        const accounts = await tx.$queryRawUnsafe<
          { id: string; fetch_enabled: boolean; revision: number }[]
        >(
          "SELECT id,fetch_enabled,revision FROM author_external_accounts ORDER BY id",
        );
        assert.deepEqual(accounts, [
          { id: "archived", fetch_enabled: true, revision: 6 },
          { id: "old", fetch_enabled: true, revision: 5 },
          { id: "p", fetch_enabled: false, revision: 4 },
          { id: "x", fetch_enabled: false, revision: 4 },
        ]);
        const states = await tx.$queryRawUnsafe<
          { external_account_id: string; enabled: boolean; revision: number }[]
        >(
          "SELECT external_account_id,enabled,revision FROM source_adapter_states ORDER BY external_account_id",
        );
        assert.deepEqual(states, [
          { external_account_id: "archived", enabled: false, revision: 7 },
          { external_account_id: "old", enabled: false, revision: 7 },
          { external_account_id: "p", enabled: true, revision: 8 },
          { external_account_id: "x", enabled: true, revision: 8 },
        ]);
        assert.deepEqual(
          await tx.$queryRawUnsafe(
            "SELECT external_account_id,recovery FROM source_adapter_states ORDER BY external_account_id",
          ),
          before,
        );
        throw rollback;
      }),
      (error) => error === rollback,
    );
  } finally {
    await f.close();
  }
});

test("unlink, restore and the business enable switch preserve recovery fields and resume the active adapter", async () => {
  const f = await candidateReviewFixture();
  const registry = new ContentSourceRegistry().register({
    platform: "pixiv",
    adapterKey: "pixiv_gallery_dl",
    available: true,
    priority: 1,
    metered: false,
    supportedFirstSyncModes: ["none"],
    allowedMediaHosts: [],
    initialCursor: () => ({}),
    checkAccount: async (account) => account,
    fetchPage: async () => {
      throw new Error("No platform network in this fixture");
    },
  });
  const service = new AuthorsService(
    f.db,
    registry,
    {} as never,
    {} as never,
    {} as never,
  );
  try {
    const account = await service.createAccount(
      f.author.id,
      {
        platform: "pixiv",
        externalUserId: String(
          BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12)),
        ),
        fetchEnabled: true,
        firstSyncMode: "none",
      },
      f.actor.id,
    );
    const recovery = {
      cursorJson: { page: 7 },
      discoveryCheckpointJson: { value: "opaque" },
      nextAttemptAt: new Date("2099-01-01"),
      lastErrorMessage: "Synthetic retained error",
    };
    await f.db.sourceAdapterState.updateMany({
      where: { externalAccountId: account.id },
      data: recovery,
    });
    await service.archiveAccount(
      f.author.id,
      account.id,
      account.revision,
      f.actor.id,
    );
    const archived = await f.db.authorExternalAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    const restored = await service.restoreAccount(
      f.author.id,
      account.id,
      archived.revision,
      f.actor.id,
    );
    assert.equal(restored.fetchEnabled, false);
    const enabled = await service.updateAccount(
      f.author.id,
      account.id,
      {
        fetchEnabled: true,
        firstSyncMode: "none",
        expectedRevision: restored.revision,
      },
      f.actor.id,
    );
    assert.equal(enabled.adapterStates[0].enabled, true);
    const state = await f.db.sourceAdapterState.findFirstOrThrow({
      where: { externalAccountId: account.id },
    });
    for (const key of [
      "cursorJson",
      "discoveryCheckpointJson",
      "nextAttemptAt",
      "lastErrorMessage",
    ] as const)
      assert.deepEqual(state[key], recovery[key]);
  } finally {
    await f.db.authorExternalAccount.deleteMany({
      where: { authorId: f.author.id },
    });
    await f.close();
  }
});
