CREATE TYPE "ReviewPurpose" AS ENUM ('production_decision', 'content_revision');
ALTER TYPE "ReviewResolution" ADD VALUE 'continue_production';
ALTER TYPE "ReviewResolution" ADD VALUE 'discard';
ALTER TYPE "ReviewResolution" ADD VALUE 'restore_production';
ALTER TYPE "ReviewResolution" ADD VALUE 'approve_revision';
ALTER TABLE work_review_cases ADD COLUMN purpose "ReviewPurpose" NOT NULL DEFAULT 'production_decision', ADD COLUMN baseline JSONB NOT NULL DEFAULT '{}', ADD COLUMN restored_at TIMESTAMPTZ(3);
ALTER TABLE works ADD COLUMN discarded_review_case_id UUID;
CREATE UNIQUE INDEX works_discarded_review_case_id_key ON works(discarded_review_case_id);
ALTER TABLE works ADD CONSTRAINT works_discarded_review_case_id_fkey FOREIGN KEY (discarded_review_case_id) REFERENCES work_review_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE;
-- Legacy cases remain production decisions; no historic record grants editing.
CREATE UNIQUE INDEX work_review_cases_one_open_per_work ON work_review_cases(work_id) WHERE status = 'open';
