-- CreateEnum
CREATE TYPE "ReviewRevisionStatus" AS ENUM ('active', 'completed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkEventAction" ADD VALUE 'review_revision_joined';
ALTER TYPE "WorkEventAction" ADD VALUE 'review_revision_left';
ALTER TYPE "WorkEventAction" ADD VALUE 'review_revision_pages_updated';
ALTER TYPE "WorkEventAction" ADD VALUE 'review_revision_contribution_completed';
ALTER TYPE "WorkEventAction" ADD VALUE 'review_revision_completed';
ALTER TYPE "WorkEventAction" ADD VALUE 'typeset_version_reviewed';

-- AlterTable
ALTER TABLE "translation_versions" ADD COLUMN     "review_revision_id" UUID;

-- AlterTable
ALTER TABLE "typeset_handoff_packages" ADD COLUMN     "translation_version_id" UUID;

-- AlterTable
ALTER TABLE "typeset_image_versions" ADD COLUMN     "reviewed_translation_version_id" UUID,
ADD COLUMN     "source_translation_version_id" UUID,
ADD COLUMN     "text_reviewed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "works" ADD COLUMN     "required_handoff_version_id" UUID,
ADD COLUMN     "typeset_review_required" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "work_review_revisions" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "review_case_id" UUID NOT NULL,
    "target_stage" "WorkStage" NOT NULL,
    "current_stage" "WorkStage" NOT NULL,
    "status" "ReviewRevisionStatus" NOT NULL DEFAULT 'active',
    "return_workflow_status" "WorkflowStatus" NOT NULL,
    "baseline" JSONB NOT NULL,
    "initial_text" JSONB NOT NULL,
    "translation_version_id" UUID,
    "original_contributor_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "original_collaboration_mode" "WorkCollaborationMode" NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_review_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_revision_participants" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stage" "WorkStage" NOT NULL,
    "image_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "completed_pages" JSONB NOT NULL DEFAULT '[]',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),

    CONSTRAINT "review_revision_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_review_revisions_review_case_id_key" ON "work_review_revisions"("review_case_id");

-- CreateIndex
CREATE INDEX "work_review_revisions_work_id_status_idx" ON "work_review_revisions"("work_id", "status");

-- CreateIndex
CREATE INDEX "review_revision_participants_revision_id_stage_left_at_idx" ON "review_revision_participants"("revision_id", "stage", "left_at");

-- CreateIndex
CREATE INDEX "review_revision_participants_user_id_joined_at_idx" ON "review_revision_participants"("user_id", "joined_at");

-- AddForeignKey
ALTER TABLE "works" ADD CONSTRAINT "works_required_handoff_version_id_fkey" FOREIGN KEY ("required_handoff_version_id") REFERENCES "translation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_versions" ADD CONSTRAINT "translation_versions_review_revision_id_fkey" FOREIGN KEY ("review_revision_id") REFERENCES "work_review_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_handoff_packages" ADD CONSTRAINT "typeset_handoff_packages_translation_version_id_fkey" FOREIGN KEY ("translation_version_id") REFERENCES "translation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_image_versions" ADD CONSTRAINT "typeset_image_versions_source_translation_version_id_fkey" FOREIGN KEY ("source_translation_version_id") REFERENCES "translation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_image_versions" ADD CONSTRAINT "typeset_image_versions_reviewed_translation_version_id_fkey" FOREIGN KEY ("reviewed_translation_version_id") REFERENCES "translation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_review_revisions" ADD CONSTRAINT "work_review_revisions_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_review_revisions" ADD CONSTRAINT "work_review_revisions_review_case_id_fkey" FOREIGN KEY ("review_case_id") REFERENCES "work_review_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_revision_participants" ADD CONSTRAINT "review_revision_participants_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "work_review_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_revision_participants" ADD CONSTRAINT "review_revision_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX review_revision_participants_active_user_stage ON review_revision_participants(revision_id,user_id,stage) WHERE left_at IS NULL AND submitted_at IS NULL;
ALTER TABLE work_review_revisions ADD CONSTRAINT work_review_revisions_text_stages CHECK (target_stage IN ('translate','proofread') AND current_stage IN ('translate','proofread'));
