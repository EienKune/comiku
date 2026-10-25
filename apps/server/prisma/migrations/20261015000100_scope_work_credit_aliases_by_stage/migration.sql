-- A temporary credit belongs to one work, member and responsibility.
ALTER TABLE "work_credit_aliases" ADD COLUMN "stage" "WorkStage";

-- Submitted participants still count; only withdrawn responsibilities are excluded.
UPDATE "work_credit_aliases" AS alias
SET "stage" = (
  SELECT participant."stage"
  FROM "work_stage_participants" AS participant
  WHERE participant."work_id" = alias."work_id"
    AND participant."user_id" = alias."user_id"
    AND participant."left_at" IS NULL
  ORDER BY participant."stage"
  LIMIT 1
);

-- Orphaned convenience aliases must not reappear on a later claim.
-- Historical participant/event/publication snapshots remain untouched.
DELETE FROM "work_credit_aliases" WHERE "stage" IS NULL;
ALTER TABLE "work_credit_aliases" ALTER COLUMN "stage" SET NOT NULL;
ALTER TABLE "work_credit_aliases" DROP CONSTRAINT "work_credit_aliases_pkey";
ALTER TABLE "work_credit_aliases"
  ADD CONSTRAINT "work_credit_aliases_pkey" PRIMARY KEY ("work_id", "user_id", "stage");

-- Preserve the previously displayed shared credit for every remaining role.
INSERT INTO "work_credit_aliases" ("work_id", "user_id", "stage", "credit_name", "updated_at")
SELECT DISTINCT alias."work_id", alias."user_id", participant."stage", alias."credit_name", alias."updated_at"
FROM "work_credit_aliases" AS alias
JOIN "work_stage_participants" AS participant
  ON participant."work_id" = alias."work_id" AND participant."user_id" = alias."user_id"
WHERE participant."left_at" IS NULL
ON CONFLICT ("work_id", "user_id", "stage") DO NOTHING;
