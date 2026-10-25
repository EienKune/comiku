-- Review requests and holds had identical behavior. Normalize existing data and
-- keep one review state while retaining "blocked" as a distinct conclusion.
CREATE TYPE "ReviewStatus_new" AS ENUM ('normal', 'needs_review', 'blocked');

ALTER TABLE "works" ALTER COLUMN "review_status" DROP DEFAULT;
ALTER TABLE "works"
  ALTER COLUMN "review_status" TYPE "ReviewStatus_new"
  USING (
    CASE
      WHEN "review_status"::text = 'on_hold' THEN 'needs_review'
      ELSE "review_status"::text
    END
  )::"ReviewStatus_new";
ALTER TABLE "work_events"
  ALTER COLUMN "from_review_status" TYPE "ReviewStatus_new"
  USING (
    CASE
      WHEN "from_review_status"::text = 'on_hold' THEN 'needs_review'
      ELSE "from_review_status"::text
    END
  )::"ReviewStatus_new",
  ALTER COLUMN "to_review_status" TYPE "ReviewStatus_new"
  USING (
    CASE
      WHEN "to_review_status"::text = 'on_hold' THEN 'needs_review'
      ELSE "to_review_status"::text
    END
  )::"ReviewStatus_new";
DROP TYPE "ReviewStatus";
ALTER TYPE "ReviewStatus_new" RENAME TO "ReviewStatus";
ALTER TABLE "works"
  ALTER COLUMN "review_status" SET DEFAULT 'normal'::"ReviewStatus";

-- A review case now has one initiation meaning, so the request discriminator is
-- redundant. Existing hold cases retain their reason and resolution history.
ALTER TABLE "work_review_cases" DROP COLUMN "request_type";
DROP TYPE "ReviewRequestType";

ALTER TYPE "ReviewResolution"
  RENAME VALUE 'keep_on_hold' TO 'keep_pending';

CREATE TYPE "WorkEventAction_new" AS ENUM (
  'imported',
  'metadata_updated',
  'stage_joined',
  'stage_assigned',
  'stage_left',
  'stage_submitted',
  'translation_revision_submitted',
  'translation_imported',
  'review_opened',
  'review_resumed',
  'review_revised',
  'review_kept_pending',
  'review_blocked',
  'archived',
  'restored'
);
ALTER TABLE "work_events"
  ALTER COLUMN "action" TYPE "WorkEventAction_new"
  USING (
    CASE
      WHEN "action"::text = 'hold_opened' THEN 'review_opened'
      WHEN "action"::text = 'review_kept_on_hold' THEN 'review_kept_pending'
      ELSE "action"::text
    END
  )::"WorkEventAction_new";
DROP TYPE "WorkEventAction";
ALTER TYPE "WorkEventAction_new" RENAME TO "WorkEventAction";
