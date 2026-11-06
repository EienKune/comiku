import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AuthorsService } from "../src/authors/authors.service.js";
import { AuthorsController } from "../src/authors/authors.controller.js";
import {
  CreateAuthorDto,
  CreateExternalAccountDto,
  UpdateExternalAccountDto,
} from "../src/authors/authors.dto.js";
import { ACCESS, permissionsFor } from "../src/common/access.js";
import { ContentSourceRegistry } from "../src/source-ingestion/source-registry.js";
const base = {
  displayName: "Artist",
  sourceLanguage: "ja" as const,
  authorizationStatus: "pending" as const,
  tagNames: [],
};
const account = {
  platform: "pixiv",
  externalUserId: "123",
  fetchEnabled: false,
  firstSyncMode: "none" as const,
};
function fixture() {
  const now = new Date();
  let row = {
    id: "author",
    ...base,
    notes: "author secret",
    revision: 0,
    tags: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    externalAccounts: [
      {
        id: "account",
        authorId: "author",
        ...account,
        notes: "account secret",
        handle: null,
        profileUrl: null,
        displayNameSnapshot: null,
        revision: 0,
        metadataJson: {},
        adapterStates: [],
        deletedAt: null,
      },
    ],
  };
  const db = {
    author: {
      findFirst: async () => row,
      findUniqueOrThrow: async () => row,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data, revision: row.revision + 1 };
        return { count: 1 };
      },
    },
    authorTag: { deleteMany: async () => {} },
    authorExternalAccount: {
      findFirst: async () => row.externalAccounts[0],
      findUniqueOrThrow: async () => row.externalAccounts[0],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        row.externalAccounts[0] = {
          ...row.externalAccounts[0],
          ...data,
          revision: row.externalAccounts[0].revision + 1,
        };
        return { count: 1 };
      },
    },
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  const service = new AuthorsService(
    db as never,
    new ContentSourceRegistry(),
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, row: () => row };
}
test("notes input accepts null/blank and limits both author and account text to 2000", async () => {
  for (const [Dto, fields] of [
    [CreateAuthorDto, base],
    [CreateExternalAccountDto, account],
    [UpdateExternalAccountDto, { ...account, expectedRevision: 0 }],
  ] as const) {
    for (const notes of [null, "   ", "x".repeat(2000)])
      assert.equal(
        (
          await validate(
            plainToInstance(Dto as new () => object, { ...fields, notes }),
          )
        ).length,
        0,
      );
    const errors = await validate(
      plainToInstance(Dto as new () => object, {
        ...fields,
        notes: "x".repeat(2001),
      }),
    );
    assert.ok(errors.some((error) => error.property === "notes"));
  }
});
test("managed read includes notes but public author and account summaries omit them", async () => {
  const { service } = fixture();
  const publicAuthor = await service.get("author");
  assert.equal(Object.hasOwn(publicAuthor, "notes"), false);
  assert.equal(Object.hasOwn(publicAuthor.externalAccounts[0], "notes"), false);
  const managed = await service.getManaged("author");
  assert.equal(managed.notes, "author secret");
  assert.equal(managed.externalAccounts[0].notes, "account secret");
});
test("managed endpoint requires authors manage available only to source and admin", () => {
  assert.equal(
    Reflect.getMetadata(ACCESS, AuthorsController.prototype.managed)
      ?.permission,
    "authors:manage",
  );
  for (const role of ["source", "admin"] as const)
    assert.ok(permissionsFor([role], false).includes("authors:manage"));
  for (const role of [
    "translator",
    "proofreader",
    "typesetter",
    "operator",
    "reviewer",
  ] as const)
    assert.equal(
      permissionsFor([role], false).includes("authors:manage"),
      false,
    );
});
test("author and account PATCH trim notes, preserve omission and clear blank", async () => {
  const { service, row } = fixture();
  await service.update("author", {
    ...base,
    existingTags: [],
    newTagNames: [],
    notes: " saved ",
    expectedRevision: 0,
  });
  assert.equal(row().notes, "saved");
  await service.update("author", {
    ...base,
    existingTags: [],
    newTagNames: [],
    expectedRevision: 1,
  });
  assert.equal(row().notes, "saved");
  await service.update("author", {
    ...base,
    existingTags: [],
    newTagNames: [],
    notes: "  ",
    expectedRevision: 2,
  });
  assert.equal(row().notes, null);
  for (const [notes, expected] of [
    [" account saved ", "account saved"],
    [undefined, "account saved"],
    [" ", null],
  ] as const) {
    await service.updateAccount("author", "account", {
      ...account,
      ...(notes === undefined ? {} : { notes }),
      expectedRevision: row().externalAccounts[0].revision,
    });
    assert.equal(row().externalAccounts[0].notes, expected);
  }
});
test("creation hash preserves historical no-note payload and binds only nonempty notes", () => {
  const { service } = fixture();
  const hash = (input: unknown) =>
    (
      service as unknown as { creationPayloadHash(input: unknown): string }
    ).creationPayloadHash(input);
  const input = { ...base, accounts: [account] };
  const legacy = createHash("sha256")
    .update(
      JSON.stringify({
        ...base,
        tagNames: undefined,
        tags: [],
        accounts: [
          {
            platform: "pixiv",
            externalUserId: "123",
            handle: null,
            profileUrl: "https://www.pixiv.net/users/123",
            displayNameSnapshot: null,
            avatarFileObjectId: null,
            fetchEnabled: false,
            firstSyncMode: "none",
          },
        ],
      }),
    )
    .digest("hex");
  assert.equal(hash(input), legacy);
  assert.equal(
    hash({ ...input, notes: null, accounts: [{ ...account, notes: " " }] }),
    legacy,
  );
  assert.notEqual(hash({ ...input, notes: "a" }), legacy);
  assert.notEqual(
    hash({ ...input, accounts: [{ ...account, notes: "a" }] }),
    legacy,
  );
  assert.equal(
    hash({ ...input, notes: " a " }),
    hash({ ...input, notes: "a" }),
  );
});
