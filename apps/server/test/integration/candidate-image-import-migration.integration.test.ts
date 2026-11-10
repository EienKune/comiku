import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CandidateAction } from "../../src/candidates/candidates.dto.js";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

test("the forward migration backfills exact source post, order and file only, preserving legacy business snapshots", async () => {
  const migration = await readFile(
    new URL(
      "../../prisma/migrations/20261110000100_candidate_image_import/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const f = await candidateReviewFixture();
  const rollback = new Error("rollback isolated source provenance migration");
  const schema = `image_import_${randomUUID().replaceAll("-", "")}`;
  try {
    const candidate = await f.post({
      analysisPredictions: Array.from({ length: 3 }, () => ({
        label: "positive",
        confidence: 0.8,
        score: 0.8,
      })),
    });
    const media = await f.db.candidateMedia.findMany({
      where: { candidatePostId: candidate.id },
      orderBy: { orderIndex: "asc" },
    });
    // Equal file IDs must still map to their own distinct source-page identities.
    await f.db.candidateMedia.update({
      where: { id: media[1].id },
      data: { fileObjectId: media[0].fileObjectId },
    });
    const imported = (
      await f.service.batch(f.actor.id, {
        action: CandidateAction.import,
        items: [{ id: candidate.id, expectedRevision: 0 }],
      })
    ).results[0];
    assert.equal(imported.outcome, "succeeded");
    await assert.rejects(
      f.db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
          await tx.$executeRawUnsafe(
            `SET LOCAL search_path TO "${schema}", public`,
          );
          for (const table of ["works", "work_images", "candidate_media"])
            await tx.$executeRawUnsafe(
              `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
            );
          await tx.$executeRaw`INSERT INTO works SELECT * FROM public.works WHERE id=${imported.workId}::uuid`;
          await tx.$executeRaw`INSERT INTO work_images SELECT * FROM public.work_images WHERE work_id=${imported.workId}::uuid`;
          await tx.$executeRaw`INSERT INTO candidate_media SELECT * FROM public.candidate_media WHERE candidate_post_id=${candidate.id}::uuid`;
          await tx.$executeRawUnsafe(
            "ALTER TABLE works DROP COLUMN candidate_import_revision",
          );
          await tx.$executeRawUnsafe(
            "ALTER TABLE work_images DROP COLUMN source_candidate_media_id",
          );
          // A mismatched historical page must remain unknown, not match by file alone.
          await tx.$executeRaw`UPDATE work_images SET original_file_object_id=${media[0].fileObjectId}::uuid WHERE order_index=2`;
          const snapshot = async () => ({
            works:
              await tx.$queryRaw`SELECT to_jsonb(w)-'candidate_import_revision' AS value FROM works w ORDER BY id`,
            images:
              await tx.$queryRaw`SELECT to_jsonb(i)-'source_candidate_media_id' AS value FROM work_images i ORDER BY order_index`,
            media:
              await tx.$queryRaw`SELECT to_jsonb(m) AS value FROM candidate_media m ORDER BY order_index`,
          });
          const before = await snapshot();
          for (const statement of migration
            .replace(/^--.*$/gm, "")
            .split(";")
            .map((value) => value.trim())
            .filter((value) => value && !/^(BEGIN|COMMIT)$/i.test(value)))
            await tx.$executeRawUnsafe(statement);
          assert.deepEqual(await snapshot(), before);
          const images = await tx.$queryRaw<
            { order_index: number; source_candidate_media_id: string | null }[]
          >`SELECT order_index,source_candidate_media_id FROM work_images ORDER BY order_index`;
          assert.deepEqual(
            images.map((image) => [
              image.order_index,
              image.source_candidate_media_id,
            ]),
            [
              [0, media[0].id],
              [1, media[1].id],
              [2, null],
            ],
          );
          const [work] = await tx.$queryRaw<
            { candidate_import_revision: number | null }[]
          >`SELECT candidate_import_revision FROM works`;
          assert.equal(work.candidate_import_revision, null);
          await tx.$executeRawUnsafe("SAVEPOINT before_restrict_check");
          await assert.rejects(
            tx.$executeRaw`DELETE FROM candidate_media WHERE id=${media[0].id}::uuid`,
            /foreign key constraint/,
          );
          await tx.$executeRawUnsafe(
            "ROLLBACK TO SAVEPOINT before_restrict_check",
          );
          throw rollback;
        },
        { timeout: 20_000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await f.db.candidateActionLog.deleteMany({
      where: { actorId: f.actor.id },
    });
    await f.db.workEvent.deleteMany({
      where: { work: { authorId: f.author.id } },
    });
    await f.db.work.deleteMany({ where: { authorId: f.author.id } });
    await f.close();
  }
});
