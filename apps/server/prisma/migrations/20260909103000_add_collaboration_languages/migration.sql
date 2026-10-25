CREATE TYPE "LanguageCapability" AS ENUM ('ja', 'ko');
CREATE TYPE "SourceLanguage" AS ENUM ('ja', 'ko', 'en');
CREATE TYPE "WorkCollaborationMode" AS ENUM ('single', 'multi');

ALTER TABLE "authors"
  ADD COLUMN "source_language" "SourceLanguage" NOT NULL DEFAULT 'ja';

ALTER TABLE "works"
  ADD COLUMN "source_language" "SourceLanguage" NOT NULL DEFAULT 'ja',
  ADD COLUMN "collaboration_mode" "WorkCollaborationMode" NOT NULL DEFAULT 'single';

UPDATE "works" AS work
SET "source_language" = author."source_language"
FROM "authors" AS author
WHERE author."id" = work."author_id";

ALTER TABLE "work_stage_participants"
  ADD COLUMN "left_at" TIMESTAMPTZ(3);

DROP INDEX "work_stage_participants_one_active_user_idx";
DROP INDEX "work_stage_participants_work_id_stage_submitted_at_idx";
CREATE INDEX "work_stage_participants_work_id_stage_submitted_at_left_at_idx"
  ON "work_stage_participants"("work_id", "stage", "submitted_at", "left_at");
CREATE UNIQUE INDEX "work_stage_participants_one_active_user_idx"
  ON "work_stage_participants"("work_id", "stage", "user_id")
  WHERE "submitted_at" IS NULL AND "left_at" IS NULL;

CREATE TABLE "user_language_capabilities" (
  "user_id" UUID NOT NULL,
  "language" "LanguageCapability" NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_language_capabilities_pkey" PRIMARY KEY ("user_id", "language")
);

CREATE TABLE "work_stage_assignments" (
  "id" UUID NOT NULL,
  "participant_id" UUID NOT NULL,
  "work_image_id" UUID NOT NULL,
  "assigned_by" UUID NOT NULL,
  "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_stage_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_stage_assignments_participant_id_work_image_id_key"
  ON "work_stage_assignments"("participant_id", "work_image_id");
CREATE INDEX "work_stage_assignments_work_image_id_idx"
  ON "work_stage_assignments"("work_image_id");

CREATE TABLE "stage_contribution_submissions" (
  "id" UUID NOT NULL,
  "participant_id" UUID NOT NULL,
  "created_by" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stage_contribution_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stage_contribution_submissions_participant_id_idempotency_key_key"
  ON "stage_contribution_submissions"("participant_id", "idempotency_key");
CREATE INDEX "stage_contribution_submissions_participant_id_created_at_idx"
  ON "stage_contribution_submissions"("participant_id", "created_at");

CREATE TABLE "stage_contribution_pages" (
  "submission_id" UUID NOT NULL,
  "work_image_id" UUID NOT NULL,
  "image_revision" INTEGER NOT NULL,
  CONSTRAINT "stage_contribution_pages_pkey" PRIMARY KEY ("submission_id", "work_image_id")
);

CREATE INDEX "stage_contribution_pages_work_image_id_idx"
  ON "stage_contribution_pages"("work_image_id");

ALTER TYPE "WorkEventAction" ADD VALUE 'collaboration_mode_updated' AFTER 'metadata_updated';
ALTER TYPE "WorkEventAction" ADD VALUE 'stage_assignment_updated' AFTER 'stage_assigned';
ALTER TYPE "WorkEventAction" ADD VALUE 'stage_contribution_completed' AFTER 'stage_assignment_updated';

ALTER TABLE "user_language_capabilities"
  ADD CONSTRAINT "user_language_capabilities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_stage_assignments"
  ADD CONSTRAINT "work_stage_assignments_participant_id_fkey"
  FOREIGN KEY ("participant_id") REFERENCES "work_stage_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_stage_assignments"
  ADD CONSTRAINT "work_stage_assignments_work_image_id_fkey"
  FOREIGN KEY ("work_image_id") REFERENCES "work_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_stage_assignments"
  ADD CONSTRAINT "work_stage_assignments_assigned_by_fkey"
  FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_contribution_submissions"
  ADD CONSTRAINT "stage_contribution_submissions_participant_id_fkey"
  FOREIGN KEY ("participant_id") REFERENCES "work_stage_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_contribution_submissions"
  ADD CONSTRAINT "stage_contribution_submissions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_contribution_pages"
  ADD CONSTRAINT "stage_contribution_pages_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "stage_contribution_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_contribution_pages"
  ADD CONSTRAINT "stage_contribution_pages_work_image_id_fkey"
  FOREIGN KEY ("work_image_id") REFERENCES "work_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
