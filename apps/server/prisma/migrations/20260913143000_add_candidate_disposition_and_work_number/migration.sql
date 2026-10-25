CREATE TYPE "CandidateTagDisposition" AS ENUM ('valid', 'neutral', 'blocked');

ALTER TABLE "candidate_posts"
  ADD COLUMN "tag_disposition" "CandidateTagDisposition" NOT NULL DEFAULT 'neutral';

UPDATE "candidate_posts" AS candidate
SET "tag_disposition" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "candidate_hashtags" AS hashtag
    JOIN "candidate_tag_aliases" AS alias
      ON alias."normalized_value" = hashtag."normalized_value"
    JOIN "candidate_tag_groups" AS tag_group
      ON tag_group."id" = alias."group_id"
    WHERE hashtag."candidate_post_id" = candidate."id"
      AND tag_group."enabled" = true
      AND tag_group."kind" = 'blocked'::"CandidateTagGroupKind"
  ) THEN 'blocked'::"CandidateTagDisposition"
  WHEN EXISTS (
    SELECT 1
    FROM "candidate_hashtags" AS hashtag
    JOIN "candidate_tag_aliases" AS alias
      ON alias."normalized_value" = hashtag."normalized_value"
    JOIN "candidate_tag_groups" AS tag_group
      ON tag_group."id" = alias."group_id"
    WHERE hashtag."candidate_post_id" = candidate."id"
      AND tag_group."enabled" = true
      AND tag_group."kind" = 'valid'::"CandidateTagGroupKind"
  ) THEN 'valid'::"CandidateTagDisposition"
  ELSE 'neutral'::"CandidateTagDisposition"
END;

DROP INDEX IF EXISTS "candidate_posts_status_has_valid_tag_posted_at_id_idx";
CREATE INDEX "candidate_posts_status_tag_disposition_posted_at_id_idx"
  ON "candidate_posts"("status", "tag_disposition", "posted_at", "id");
ALTER TABLE "candidate_posts" DROP COLUMN "has_valid_tag";

CREATE SEQUENCE "works_work_number_seq";
ALTER TABLE "works" ADD COLUMN "work_number" INTEGER;

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "imported_at" ASC, "id" ASC)::INTEGER AS number
  FROM "works"
)
UPDATE "works" AS work
SET "work_number" = numbered.number
FROM numbered
WHERE work."id" = numbered."id";

SELECT setval(
  '"works_work_number_seq"',
  COALESCE((SELECT MAX("work_number") FROM "works"), 1),
  EXISTS (SELECT 1 FROM "works")
);

ALTER TABLE "works"
  ALTER COLUMN "work_number" SET DEFAULT nextval('"works_work_number_seq"'),
  ALTER COLUMN "work_number" SET NOT NULL,
  ALTER COLUMN "title" DROP NOT NULL;

ALTER SEQUENCE "works_work_number_seq" OWNED BY "works"."work_number";
CREATE UNIQUE INDEX "works_work_number_key" ON "works"("work_number");
