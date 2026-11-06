import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateAuthorDto } from "../src/authors/authors.dto.js";
import test from "node:test";
import { ConflictException } from "@nestjs/common";
import {
  normalizeAuthorTagSelection,
  resolveAuthorTagSelections,
} from "../src/authors/author-tags.js";

const tag = {
  id: "existing",
  name: "Existing",
  normalizedName: "existing",
  revision: 2,
};
function fixture(tags = [tag]) {
  let creates = 0,
    trips = 0;
  function insert(create: { name: string; normalizedName: string }) {
    const existing = tags.find(
      (tag) => tag.normalizedName === create.normalizedName,
    );
    if (existing) return existing;
    const saved = { id: `new-${++creates}`, revision: 0, ...create };
    tags.push(saved);
    return saved;
  }
  const tx = {
    $executeRaw: async () => 1,
    tag: {
      findMany: async ({
        where,
      }: {
        where: { id?: { in: string[] }; normalizedName?: { in: string[] } };
      }) => {
        trips++;
        return tags.filter(
          (tag) =>
            where.id?.in.includes(tag.id) ||
            where.normalizedName?.in.includes(tag.normalizedName),
        );
      },
      upsert: async ({
        create,
      }: {
        create: { name: string; normalizedName: string };
      }) => {
        trips++;
        return insert(create);
      },
      createMany: async ({
        data,
      }: {
        data: { name: string; normalizedName: string }[];
      }) => {
        trips++;
        data.forEach(insert);
        return { count: data.length };
      },
    },
  };
  return { tx, creates: () => creates, trips: () => trips };
}
test("a renamed or deleted reference rejects before creating any new name", async () => {
  for (const tags of [[], [tag]]) {
    const f = fixture(tags);
    await assert.rejects(
      resolveAuthorTagSelections(f.tx as never, [
        {
          existingTags: [{ id: "existing", expectedRevision: 1 }],
          newTagNames: ["old name"],
        },
      ]),
      ConflictException,
    );
    assert.equal(f.creates(), 0);
  }
});
test("existing references and explicit new names resolve once across a batch", async () => {
  const f = fixture();
  const result = await resolveAuthorTagSelections(f.tx as never, [
    {
      existingTags: [{ id: "existing", expectedRevision: 2 }],
      newTagNames: ["Ｅｘｉｓｔｉｎｇ", "comma,name"],
    },
    { existingTags: [], newTagNames: ["comma,name"] },
  ]);
  assert.equal(f.creates(), 1);
  assert.deepEqual(result, [["existing", "new-1"], ["new-1"]]);
});
test("selection validates combined limits, duplicate identities and normalized names", () => {
  assert.throws(() =>
    normalizeAuthorTagSelection({ existingTags: [], newTagNames: ["A", "Ａ"] }),
  );
  assert.throws(() =>
    normalizeAuthorTagSelection({
      existingTags: [
        { id: "x", expectedRevision: 1 },
        { id: "x", expectedRevision: 1 },
      ],
      newTagNames: [],
    }),
  );
  assert.throws(() =>
    normalizeAuthorTagSelection({
      existingTags: Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        expectedRevision: 0,
      })),
      newTagNames: ["over limit"],
    }),
  );
  assert.throws(() =>
    normalizeAuthorTagSelection({
      existingTags: [],
      newTagNames: ["x".repeat(65)],
    }),
  );
  assert.deepEqual(
    normalizeAuthorTagSelection({ existingTags: [], newTagNames: [" A,Ｂ "] })
      .newTagNames,
    ["A,B"],
  );
});

test("normalized names cannot overflow the catalog column and legacy null is rejected", async () => {
  assert.throws(() =>
    normalizeAuthorTagSelection({
      existingTags: [],
      newTagNames: ["İ".repeat(33)],
    }),
  );
  const errors = await validate(
    plainToInstance(CreateAuthorDto, {
      displayName: "Synthetic",
      sourceLanguage: "ja",
      authorizationStatus: "pending",
      tagNames: null,
    }),
  );
  assert.ok(errors.some((error) => error.property === "tagNames"));
});

test("large CSV tag selections use bounded bulk queries rather than one round trip per tag", async () => {
  const f = fixture([]);
  const rows = Array.from({ length: 20 }, (_, row) => ({
    existingTags: [],
    newTagNames: Array.from({ length: 50 }, (_, i) => `tag-${row}-${i}`),
  }));
  const result = await resolveAuthorTagSelections(f.tx as never, rows);
  assert.equal(result.length, 20);
  assert.equal(f.creates(), 1000);
  assert.ok(f.trips() <= 5);
});
