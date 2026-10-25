ALTER TABLE "work_review_cases"
ADD COLUMN "opened_typeset_version_id" UUID;

CREATE INDEX "work_review_cases_opened_typeset_version_id_idx"
ON "work_review_cases"("opened_typeset_version_id");

ALTER TABLE "work_review_cases"
ADD CONSTRAINT "work_review_cases_opened_typeset_version_id_fkey"
FOREIGN KEY ("opened_typeset_version_id")
REFERENCES "typeset_image_versions"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
