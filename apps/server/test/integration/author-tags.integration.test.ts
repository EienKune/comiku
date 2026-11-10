import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictException } from "@nestjs/common";
import { AuthorsService } from "../../src/authors/authors.service.js";
import { ContentSourceRegistry } from "../../src/source-ingestion/source-registry.js";
import { AUTHOR_IMPORT_TEMPLATE } from "../../src/authors/author-import.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

async function fixture() {
  const f = await candidateReviewFixture();
  const prefix = `tags_${randomUUID().replaceAll("-", "")}`;
  const service = new AuthorsService(
    f.db,
    new ContentSourceRegistry(),
    {} as never,
    {} as never,
    {} as never,
  );
  const fields = {
    displayName: f.author.displayName,
    sourceLanguage: "ja" as const,
    authorizationStatus: "authorized" as const,
  };
  return {
    ...f,
    prefix,
    service,
    fields,
    async close() {
      await f.db.authorCreationRequest.deleteMany({
        where: { actorId: f.actor.id },
      });
      await f.db.author.deleteMany({
        where: { displayName: { startsWith: prefix } },
      });
      await f.db.tag.deleteMany({
        where: { normalizedName: { startsWith: prefix } },
      });
      await f.close();
    },
  };
}

for (const change of ["rename", "delete"] as const)
  test(`a stale author tag reference cannot resurrect a name after ${change}`, async () => {
    const f = await fixture();
    try {
      const tag = await f.service.createTag({ name: f.prefix });
      const selection = {
        existingTags: [{ id: tag.id, expectedRevision: tag.revision }],
        newTagNames: [],
      };
      const author = await f.service.update(f.author.id, {
        ...f.fields,
        ...selection,
        expectedRevision: 0,
      });
      if (change === "rename")
        await f.service.updateTag(tag.id, {
          name: f.prefix + "_renamed",
          expectedRevision: tag.revision,
        });
      else await f.service.deleteTag(tag.id, tag.revision);
      await assert.rejects(
        f.service.update(f.author.id, {
          ...f.fields,
          ...selection,
          notes: "stale",
          expectedRevision: author.revision,
        }),
        ConflictException,
      );
      assert.equal(
        await f.db.tag.count({ where: { normalizedName: f.prefix } }),
        0,
      );
      assert.equal(
        (await f.db.author.findUniqueOrThrow({ where: { id: f.author.id } }))
          .revision,
        author.revision,
      );
    } finally {
      await f.close();
    }
  });

test("a committed creation replay survives later catalog changes but an uncommitted reference does not", async () => {
  const f = await fixture();
  try {
    const tag = await f.service.createTag({ name: f.prefix });
    const input = {
      ...f.fields,
      displayName: f.prefix + "_author",
      existingTags: [{ id: tag.id, expectedRevision: tag.revision }],
      newTagNames: [],
      idempotencyKey: randomUUID(),
    };
    const created = await f.service.create(input, f.actor.id);
    await f.service.updateTag(tag.id, {
      name: f.prefix + "_renamed",
      expectedRevision: tag.revision,
    });
    assert.equal((await f.service.create(input, f.actor.id)).id, created.id);
    await assert.rejects(
      f.service.create({ ...input, idempotencyKey: randomUUID() }, f.actor.id),
      ConflictException,
    );
    await assert.rejects(
      f.service.create(
        { ...f.fields, tagNames: [], idempotencyKey: randomUUID() },
        f.actor.id,
      ),
      ConflictException,
    );
    assert.equal(
      await f.db.author.count({ where: { displayName: f.prefix + "_author" } }),
      1,
    );
  } finally {
    await f.close();
  }
});

test("opposite tag orders serialize without deadlocking and keep both author updates", async () => {
  const f = await fixture();
  try {
    const first = await f.service.createTag({ name: f.prefix + "_a" }),
      second = await f.service.createTag({ name: f.prefix + "_b" });
    const other = await f.db.author.create({
      data: { displayName: f.prefix + "_other" },
    });
    const refs = [first, second].map((tag) => ({
      id: tag.id,
      expectedRevision: tag.revision,
    }));
    await Promise.all([
      f.service.update(f.author.id, {
        ...f.fields,
        existingTags: refs,
        newTagNames: [],
        expectedRevision: 0,
      }),
      f.service.update(other.id, {
        ...f.fields,
        displayName: other.displayName,
        existingTags: [...refs].reverse(),
        newTagNames: [],
        expectedRevision: 0,
      }),
    ]);
    assert.equal(
      await f.db.authorTag.count({
        where: { authorId: { in: [f.author.id, other.id] } },
      }),
      4,
    );
  } finally {
    await f.close();
  }
});

test("CSV preview pins catalog references and stale commit never recreates renamed tags", async () => {
  const f = await fixture();
  try {
    const tag = await f.service.createTag({ name: f.prefix });
    const buffer = Buffer.from(
      `${AUTHOR_IMPORT_TEMPLATE}${f.prefix}_csv,ja,pending,${tag.name},,,,\r\n`,
    );
    const preview = await f.service.previewImport(f.actor.id, {
      buffer,
      size: buffer.length,
      originalname: "synthetic.csv",
      mimetype: "text/csv",
    });
    assert.equal(preview.invalidCount, 0);
    assert.deepEqual(preview.rows[0].existingTags, [
      { id: tag.id, expectedRevision: tag.revision },
    ]);
    await f.service.updateTag(tag.id, {
      name: f.prefix + "_renamed",
      expectedRevision: tag.revision,
    });
    await assert.rejects(
      f.service.importAuthors(f.actor.id, preview.rows),
      ConflictException,
    );
    assert.equal(
      await f.db.author.count({ where: { displayName: f.prefix + "_csv" } }),
      0,
    );
    assert.equal(
      await f.db.tag.count({ where: { normalizedName: f.prefix } }),
      0,
    );
  } finally {
    await f.close();
  }
});
