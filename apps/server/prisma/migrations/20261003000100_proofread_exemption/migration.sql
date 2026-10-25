ALTER TABLE "users" ADD COLUMN "can_skip_proofreading" BOOLEAN NOT NULL DEFAULT false;
ALTER TYPE "WorkEventAction" ADD VALUE 'proofreading_skipped';
ALTER TABLE "works" ADD COLUMN "translation_contributor_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "proofread_skipped_version_id" UUID;
ALTER TABLE "translation_versions" ADD COLUMN "proofread_skipped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contributor_user_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "source_translation_version_id" UUID,
  ADD COLUMN "handoff_started_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "works_proofread_skipped_version_id_key" ON "works"("proofread_skipped_version_id");
ALTER TABLE "works" ADD CONSTRAINT "works_proofread_skipped_version_id_fkey"
  FOREIGN KEY ("proofread_skipped_version_id") REFERENCES "translation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "translation_versions" ADD CONSTRAINT "translation_versions_source_translation_version_id_fkey"
  FOREIGN KEY ("source_translation_version_id") REFERENCES "translation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
