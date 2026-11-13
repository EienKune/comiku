import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

test("composition forward backfill retains primary snapshots and derives known mapping independently from receipt revision", async () => {
  const migration = await readFile(
    new URL(
      "../../prisma/migrations/20261114000000_candidate_composition/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const f = await candidateReviewFixture();
  const schema = `composition_migration_${randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback isolated composition migration");
  try {
    await assert.rejects(
      f.db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
          await tx.$executeRawUnsafe(
            `SET LOCAL search_path TO "${schema}", public`,
          );
          for (const statement of [
            "CREATE TABLE users (id UUID PRIMARY KEY)",
            "CREATE TABLE candidate_posts (id UUID PRIMARY KEY)",
            "CREATE TABLE candidate_media (id UUID PRIMARY KEY, candidate_post_id UUID NOT NULL, file_object_id UUID NOT NULL)",
            "CREATE TABLE works (id UUID PRIMARY KEY, source_candidate_post_id UUID NOT NULL, candidate_import_revision INTEGER, source_text TEXT)",
            "CREATE UNIQUE INDEX works_source_candidate_post_id_key ON works(source_candidate_post_id)",
            "CREATE TABLE work_images (id UUID PRIMARY KEY, work_id UUID NOT NULL, source_candidate_media_id UUID, original_file_object_id UUID NOT NULL)",
          ])
            await tx.$executeRawUnsafe(statement);
          const sourceIds = Array.from({ length: 5 }, () => randomUUID());
          const workIds = Array.from({ length: 5 }, () => randomUUID());
          const mediaIds = Array.from({ length: 5 }, () => randomUUID());
          const fileIds = Array.from({ length: 5 }, () => randomUUID());
          for (const [index, sourceId] of sourceIds.entries()) {
            await tx.$executeRaw`INSERT INTO candidate_posts(id) VALUES (${sourceId}::uuid)`;
            await tx.$executeRaw`INSERT INTO candidate_media(id,candidate_post_id,file_object_id) VALUES (${mediaIds[index]}::uuid,${sourceId}::uuid,${fileIds[index]}::uuid)`;
            await tx.$executeRaw`INSERT INTO works(id,source_candidate_post_id,candidate_import_revision,source_text) VALUES (${workIds[index]}::uuid,${sourceId}::uuid,${index === 0 ? null : 7},${`frozen source ${index}`})`;
          }
          // Complete mapping with null revision is known; missing provenance, wrong
          // original file, foreign post mapping and no pages remain unknown.
          for (const index of [0, 1, 2, 3]) {
            await tx.$executeRaw`INSERT INTO work_images(id,work_id,source_candidate_media_id,original_file_object_id) VALUES (${randomUUID()}::uuid,${workIds[index]}::uuid,${index === 1 ? null : mediaIds[index === 3 ? 4 : index]}::uuid,${fileIds[index === 2 || index === 3 ? 4 : index]}::uuid)`;
          }
          const before =
            await tx.$queryRaw`SELECT to_jsonb(w)-'candidate_import_revision' AS value FROM works w ORDER BY id`;
          for (const statement of migration
            .replace(/^--.*$/gm, "")
            .split(";")
            .map((value) => value.trim())
            .filter((value) => value && !/^(BEGIN|COMMIT)$/i.test(value)))
            await tx.$executeRawUnsafe(statement);
          const after =
            await tx.$queryRaw`SELECT to_jsonb(w)-'candidate_composition_id' AS value FROM works w ORDER BY id`;
          assert.deepEqual(after, before);
          const rows = await tx.$queryRaw<
            {
              work_id: string;
              candidate_post_id: string;
              order_index: number;
              imported_revision: number | null;
              source_text: string;
              mapping_known: boolean;
            }[]
          >`SELECT * FROM work_candidate_sources`;
          const byWork = new Map(rows.map((row) => [row.work_id, row]));
          for (const [index, workId] of workIds.entries()) {
            assert.deepEqual(byWork.get(workId), {
              work_id: workId,
              candidate_post_id: sourceIds[index],
              order_index: 0,
              imported_revision: index === 0 ? null : 7,
              source_text: `frozen source ${index}`,
              mapping_known: index === 0,
            });
          }
          assert.equal(
            (
              await tx.$queryRaw<
                { count: number }[]
              >`SELECT count(*)::int AS count FROM candidate_composition_receipts`
            )[0].count,
            0,
          );
          throw rollback;
        },
        { timeout: 20_000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await f.close();
  }
});
