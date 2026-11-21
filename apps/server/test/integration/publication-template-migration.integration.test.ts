import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Disposable TEST_DATABASE_URL required");

test("default-copy migration changes only the old built-in content and remains idempotent", async () => {
  const db = new PrismaService(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  const sql = await readFile(
    new URL(
      "../../prisma/migrations/20261121100000_plain_publication_title/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const old =
    "**{{title}}**\n{{body}}作者：{{author}}\n\n翻译：{{translation_credits}}\n校对：{{proofread_credits}}\n嵌字：{{typeset_credits}}\n点赞加关注可以看到更多汉化作品\n转载请注明原作者";
  const rollback = new Error("rollback publication template fixtures");
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        const template = await tx.publishTemplate.update({
          where: { key: "default" },
          data: { content: old, revision: 7 },
        });
        const other = await tx.publishTemplate.create({
          data: {
            key: `custom-${randomUUID()}`,
            name: "Other template",
            content: old,
            revision: 3,
          },
        });
        await tx.$executeRawUnsafe(sql);
        const updated = await tx.publishTemplate.findUniqueOrThrow({
          where: { id: template.id },
        });
        assert.equal(
          updated.content,
          old.replace("**{{title}}**", "{{title}}"),
        );
        assert.equal(updated.revision, 8);
        assert.equal(
          (
            await tx.publishTemplate.findUniqueOrThrow({
              where: { id: other.id },
            })
          ).content,
          old,
        );
        await tx.$executeRawUnsafe(sql);
        assert.equal(
          (
            await tx.publishTemplate.findUniqueOrThrow({
              where: { id: template.id },
            })
          ).revision,
          8,
        );
        const custom = "**{{title}}**\nCustomized copy {{author}}";
        await tx.publishTemplate.update({
          where: { id: template.id },
          data: { content: custom, revision: 9 },
        });
        await tx.$executeRawUnsafe(sql);
        const untouched = await tx.publishTemplate.findUniqueOrThrow({
          where: { id: template.id },
        });
        assert.equal(untouched.content, custom);
        assert.equal(untouched.revision, 9);
        throw rollback;
      }),
      (error) => error === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});
