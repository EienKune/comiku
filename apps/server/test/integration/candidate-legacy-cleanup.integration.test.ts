import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

const migrationUrl = new URL(
  "../../prisma/migrations/20261031000200_remove_legacy_candidate_classification/migration.sql",
  import.meta.url,
);

test("the final schema exposes current model evidence without retired binary classification storage", async () => {
  const schema = await readFile(
    new URL("../../prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  assert.equal(
    /CandidateClassification(?:Suggestion|Decision)|CandidateVisualClass|CandidateTagDisposition|tagDisposition/.test(
      schema,
    ),
    false,
  );
});

test("the forward cleanup deletes legacy manga/photo records while preserving model history and human business state", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const predecessor = await readFile(
    new URL(
      "../../prisma/migrations/20260912100000_add_source_adapter_states_and_candidate_classification/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const f = await candidateReviewFixture();
  const rollback = new Error("rollback isolated legacy migration schema");
  const schema = `legacy_cleanup_${randomUUID().replaceAll("-", "")}`;
  try {
    const post = await f.post({
      status: "imported",
      revision: 7,
      reviewedById: f.actor.id,
      reviewedAt: new Date("2026-10-01T00:00:00Z"),
    });
    await assert.rejects(
      f.db.$transaction(
        async (tx) => {
          // Clone only synthetic fixture rows into a transaction-local schema.
          // No legacy DDL or cleanup statement touches the shared public schema.
          await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
          await tx.$executeRawUnsafe(
            `SET LOCAL search_path TO "${schema}", public`,
          );
          for (const table of [
            "users",
            "candidate_posts",
            "candidate_media",
            "candidate_media_analyses",
            "works",
            "candidate_action_logs",
            "candidate_tag_groups",
          ])
            await tx.$executeRawUnsafe(
              `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
            );
          await tx.$executeRaw`INSERT INTO users SELECT * FROM public.users WHERE id=${f.actor.id}::uuid`;
          await tx.$executeRaw`INSERT INTO candidate_posts SELECT * FROM public.candidate_posts WHERE id=${post.id}::uuid`;
          await tx.$executeRaw`INSERT INTO candidate_media SELECT * FROM public.candidate_media WHERE candidate_post_id=${post.id}::uuid`;
          await tx.$executeRaw`INSERT INTO candidate_media_analyses SELECT a.* FROM public.candidate_media_analyses a JOIN candidate_media m ON m.id=a.media_id`;
          await tx.$executeRawUnsafe(
            `CREATE TYPE "CandidateVisualClass" AS ENUM ('manga', 'photo')`,
          );
          await tx.$executeRawUnsafe(
            `CREATE TYPE "CandidateTagDisposition" AS ENUM ('valid', 'neutral', 'blocked')`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE candidate_posts DROP COLUMN IF EXISTS tag_disposition`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE candidate_posts ADD COLUMN tag_disposition "CandidateTagDisposition" NOT NULL DEFAULT 'neutral'`,
          );
          await tx.$executeRawUnsafe(
            `CREATE INDEX candidate_posts_status_tag_disposition_posted_at_id_idx ON candidate_posts(status, tag_disposition, posted_at, id)`,
          );
          // Reuse the released legacy table definitions, indexes and foreign keys.
          const legacyTables = predecessor.match(
            /CREATE TABLE "candidate_classification_suggestions"[\s\S]*?(?=ALTER TABLE "author_external_accounts")/,
          )?.[0];
          assert.ok(legacyTables);
          assert.ok(
            legacyTables.includes(
              'CREATE TABLE "candidate_classification_decisions"',
            ),
          );
          for (const statement of legacyTables
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean))
            await tx.$executeRawUnsafe(statement);
          await tx.$executeRaw`INSERT INTO candidate_classification_suggestions (id,candidate_post_id,label,classifier_name,classifier_version,score) VALUES (${randomUUID()}::uuid,${post.id}::uuid,'manga','retired-synthetic','1',0.9)`;
          await tx.$executeRaw`INSERT INTO candidate_classification_decisions (candidate_post_id,label,decided_by,revision,updated_at) VALUES (${post.id}::uuid,'photo',${f.actor.id}::uuid,3,CURRENT_TIMESTAMP)`;
          const workId = randomUUID();
          await tx.$executeRaw`INSERT INTO works (id,author_id,source_candidate_post_id,imported_by,updated_at) VALUES (${workId}::uuid,${f.author.id}::uuid,${post.id}::uuid,${f.actor.id}::uuid,CURRENT_TIMESTAMP)`;
          await tx.$executeRaw`INSERT INTO candidate_action_logs (id,candidate_post_id,actor_id,action,from_status,to_status,work_id) VALUES (${randomUUID()}::uuid,${post.id}::uuid,${f.actor.id}::uuid,'import','pending','imported',${workId}::uuid)`;
          for (const kind of ["valid", "blocked", "gray"])
            await tx.$executeRaw`INSERT INTO candidate_tag_groups (id,name,kind,updated_at) VALUES (${randomUUID()}::uuid,${kind},${kind}::"CandidateTagGroupKind",CURRENT_TIMESTAMP)`;
          const snapshot = async () => ({
            posts:
              await tx.$queryRaw`SELECT to_jsonb(c)-'tag_disposition' AS value FROM candidate_posts c ORDER BY id`,
            media:
              await tx.$queryRaw`SELECT to_jsonb(m) AS value FROM candidate_media m ORDER BY id`,
            analyses:
              await tx.$queryRaw`SELECT to_jsonb(a) AS value FROM candidate_media_analyses a ORDER BY id`,
            works:
              await tx.$queryRaw`SELECT to_jsonb(w) AS value FROM works w ORDER BY id`,
            actions:
              await tx.$queryRaw`SELECT to_jsonb(a) AS value FROM candidate_action_logs a ORDER BY id`,
            tags: await tx.$queryRaw`SELECT to_jsonb(g) AS value FROM candidate_tag_groups g ORDER BY id`,
          });
          const before = await snapshot();
          assert.equal((before.analyses as unknown[]).length, 1);
          for (const statement of migration
            .replace(/^--.*$/gm, "")
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s)))
            await tx.$executeRawUnsafe(statement);
          assert.deepEqual(await snapshot(), before);
          const [remaining] = await tx.$queryRaw<{ count: number }[]>`
            SELECT (
              (SELECT count(*) FROM pg_tables WHERE schemaname=${schema} AND tablename IN ('candidate_classification_suggestions','candidate_classification_decisions')) +
              (SELECT count(*) FROM information_schema.columns WHERE table_schema=${schema} AND table_name='candidate_posts' AND column_name='tag_disposition') +
              (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=${schema} AND t.typname IN ('CandidateVisualClass','CandidateTagDisposition')) +
              (SELECT count(*) FROM pg_indexes WHERE schemaname=${schema} AND indexname='candidate_posts_status_tag_disposition_posted_at_id_idx')
            )::int AS count`;
          assert.equal(remaining.count, 0);
          throw rollback;
        },
        { timeout: 20000 },
      ),
      (error) => error === rollback,
    );
  } finally {
    await f.close();
  }
});
