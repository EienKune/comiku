import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorsController } from "../src/authors/authors.controller.js";
import { AuthorsService } from "../src/authors/authors.service.js";
import { ACCESS } from "../src/common/access.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";

test("source-account reads expose safe identities including disabled history", async () => {
  const rows = [null, new Date("2026-11-01T00:00:00.000Z")].map(
    (deletedAt, index) => ({
      id: `account-${index}`,
      platform: "pixiv",
      externalUserId: `${42 + index}`,
      handle: null,
      profileUrl: null,
      displayNameSnapshot: "Snapshot",
      avatarFileObjectId: index ? "avatar" : null,
      fetchEnabled: false,
      deletedAt,
      notes: "PRIVATE_NOTES",
      metadataJson: { private: "PRIVATE_METADATA" },
      adapterStates: [{ adapterKey: "PRIVATE_ADAPTER" }],
    }),
  );
  const db = {
    author: { findFirst: async () => ({ id: "author" }) },
    authorExternalAccount: {
      findMany: async ({
        where,
        orderBy,
        select,
      }: {
        where: object;
        orderBy: object;
        select: Record<string, unknown>;
      }) => {
        assert.deepEqual(where, { authorId: "author" });
        assert.deepEqual(orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
        assert.equal(select.notes, undefined);
        assert.equal(select.adapterStates, undefined);
        assert.equal(select.metadataJson, undefined);
        return rows;
      },
    },
  };
  const service = new AuthorsService(
    db as never,
    new ContentSourceRegistry(),
    {} as never,
    {} as never,
    {} as never,
  );
  const result = await service.listSourceAccounts("author");
  assert.deepEqual(result, [
    {
      id: "account-0",
      platform: "pixiv",
      externalUserId: "42",
      handle: null,
      profileUrl: null,
      displayNameSnapshot: "Snapshot",
      avatarAvailable: false,
      fetchEnabled: false,
      deletedAt: null,
    },
    {
      id: "account-1",
      platform: "pixiv",
      externalUserId: "43",
      handle: null,
      profileUrl: null,
      displayNameSnapshot: "Snapshot",
      avatarAvailable: true,
      fetchEnabled: false,
      deletedAt: "2026-11-01T00:00:00.000Z",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("source-account history requires authors read instead of managed-account access", () => {
  assert.equal(
    Reflect.getMetadata(ACCESS, AuthorsController.prototype.sourceAccounts)
      ?.permission,
    "authors:read",
  );
});

test("source-account lookup rejects a missing or archived parent", async () => {
  const db = { author: { findFirst: async () => null } };
  const service = new AuthorsService(
    db as never,
    new ContentSourceRegistry(),
    {} as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(service.listSourceAccounts("missing"), /作者不存在/);
});
