-- Retired binary manga/photo history is intentionally removed, not remapped.
-- Back up the database with the normal deployment backup procedure before upgrading.
BEGIN;
DROP TABLE "candidate_classification_suggestions";
DROP TABLE "candidate_classification_decisions";
DROP TYPE "CandidateVisualClass";

DROP INDEX "candidate_posts_status_tag_disposition_posted_at_id_idx";
ALTER TABLE "candidate_posts" DROP COLUMN "tag_disposition";
DROP TYPE "CandidateTagDisposition";
COMMIT;
