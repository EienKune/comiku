-- AlterTable
ALTER TABLE "works" ADD COLUMN "editor_epoch" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "works" ADD CONSTRAINT "works_editor_epoch_check" CHECK ("editor_epoch" >= 0);

-- AlterTable
ALTER TABLE "translation_versions" ADD COLUMN "editor_epoch" INTEGER NOT NULL DEFAULT 0;

UPDATE "translation_versions"
SET "editor_epoch" = "version_number";

UPDATE "works" AS "work"
SET "editor_epoch" = "head"."editor_epoch"
FROM (
  SELECT "work_id", MAX("editor_epoch") AS "editor_epoch"
  FROM "translation_versions"
  GROUP BY "work_id"
) AS "head"
WHERE "work"."id" = "head"."work_id";

ALTER TABLE "translation_versions" ALTER COLUMN "editor_epoch" DROP DEFAULT;

ALTER TABLE "translation_versions" ADD CONSTRAINT "translation_versions_editor_epoch_check" CHECK ("editor_epoch" > 0);
