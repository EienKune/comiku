-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('normal', 'on_hold', 'needs_review', 'blocked');

-- CreateEnum
CREATE TYPE "WorkStage" AS ENUM ('translate', 'proofread', 'typeset', 'publish');

-- CreateEnum
CREATE TYPE "WorkParticipationMode" AS ENUM ('owner', 'collaborator');

-- CreateEnum
CREATE TYPE "WorkEventAction" AS ENUM ('imported', 'metadata_updated', 'stage_joined', 'stage_submitted', 'review_opened', 'hold_opened', 'review_resumed', 'review_revised', 'review_kept_on_hold', 'review_blocked', 'archived', 'restored');

-- CreateEnum
CREATE TYPE "ReviewRequestType" AS ENUM ('review', 'hold');

-- CreateEnum
CREATE TYPE "ReviewCaseStatus" AS ENUM ('open', 'resolved');

-- CreateEnum
CREATE TYPE "ReviewResolution" AS ENUM ('resume', 'revise', 'keep_on_hold', 'block');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkflowStatus" ADD VALUE 'translating';
ALTER TYPE "WorkflowStatus" ADD VALUE 'pending_proofread';
ALTER TYPE "WorkflowStatus" ADD VALUE 'proofreading';
ALTER TYPE "WorkflowStatus" ADD VALUE 'pending_typeset';
ALTER TYPE "WorkflowStatus" ADD VALUE 'typesetting';
ALTER TYPE "WorkflowStatus" ADD VALUE 'pending_publish';
ALTER TYPE "WorkflowStatus" ADD VALUE 'published';
ALTER TYPE "WorkflowStatus" ADD VALUE 'archived';

-- DropIndex
DROP INDEX "works_workflow_status_imported_at_idx";

-- RenameColumn
ALTER TABLE "work_images" RENAME COLUMN "file_object_id" TO "original_file_object_id";
ALTER TABLE "work_images" RENAME CONSTRAINT "work_images_file_object_id_fkey" TO "work_images_original_file_object_id_fkey";
ALTER INDEX "work_images_file_object_id_idx" RENAME TO "work_images_original_file_object_id_idx";

-- AlterTable
ALTER TABLE "work_images" ADD COLUMN "height" INTEGER,
ADD COLUMN "width" INTEGER;

-- AlterTable
ALTER TABLE "works" ADD COLUMN     "archived_from_workflow_status" "WorkflowStatus",
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "published_at" TIMESTAMPTZ(3),
ADD COLUMN     "review_status" "ReviewStatus" NOT NULL DEFAULT 'normal';

-- CreateTable
CREATE TABLE "work_stage_participants" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "stage" "WorkStage" NOT NULL,
    "user_id" UUID NOT NULL,
    "participation_mode" "WorkParticipationMode" NOT NULL,
    "credit_name_override" VARCHAR(100),
    "credit_name_snapshot" VARCHAR(100),
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),

    CONSTRAINT "work_stage_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_events" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" "WorkEventAction" NOT NULL,
    "from_workflow_status" "WorkflowStatus",
    "to_workflow_status" "WorkflowStatus",
    "from_review_status" "ReviewStatus",
    "to_review_status" "ReviewStatus",
    "idempotency_key" UUID,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_review_cases" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "opened_from_workflow_status" "WorkflowStatus" NOT NULL,
    "request_type" "ReviewRequestType" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReviewCaseStatus" NOT NULL DEFAULT 'open',
    "opened_by" UUID NOT NULL,
    "resolved_by" UUID,
    "resolution" "ReviewResolution",
    "target_workflow_status" "WorkflowStatus",
    "resolution_note" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "work_review_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_stage_participants_work_id_stage_submitted_at_idx" ON "work_stage_participants"("work_id", "stage", "submitted_at");

-- CreateIndex
CREATE INDEX "work_stage_participants_user_id_joined_at_idx" ON "work_stage_participants"("user_id", "joined_at");

-- CreateIndex
CREATE UNIQUE INDEX "work_stage_participants_one_active_user_idx" ON "work_stage_participants"("work_id", "stage", "user_id") WHERE "submitted_at" IS NULL;

-- CreateIndex
CREATE INDEX "work_events_work_id_created_at_idx" ON "work_events"("work_id", "created_at");

-- CreateIndex
CREATE INDEX "work_events_actor_id_created_at_idx" ON "work_events"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "work_events_work_id_idempotency_key_key" ON "work_events"("work_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "work_review_cases_status_created_at_idx" ON "work_review_cases"("status", "created_at");

-- CreateIndex
CREATE INDEX "work_review_cases_work_id_created_at_idx" ON "work_review_cases"("work_id", "created_at");

-- CreateIndex
CREATE INDEX "work_review_cases_opened_by_created_at_idx" ON "work_review_cases"("opened_by", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "work_review_cases_one_open_per_work_idx" ON "work_review_cases"("work_id") WHERE "status" = 'open';

-- CreateIndex
CREATE INDEX "works_workflow_status_review_status_priority_imported_at_idx" ON "works"("workflow_status", "review_status", "priority", "imported_at");

-- CreateIndex
CREATE INDEX "works_review_status_updated_at_idx" ON "works"("review_status", "updated_at");

-- AddForeignKey
ALTER TABLE "work_stage_participants" ADD CONSTRAINT "work_stage_participants_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_stage_participants" ADD CONSTRAINT "work_stage_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_events" ADD CONSTRAINT "work_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_review_cases" ADD CONSTRAINT "work_review_cases_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_review_cases" ADD CONSTRAINT "work_review_cases_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_review_cases" ADD CONSTRAINT "work_review_cases_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
