BEGIN;

ALTER TABLE "works" ADD COLUMN "candidate_import_revision" INTEGER;
ALTER TABLE "work_images" ADD COLUMN "source_candidate_media_id" UUID;

CREATE UNIQUE INDEX "work_images_source_candidate_media_id_key"
  ON "work_images"("source_candidate_media_id");

ALTER TABLE "work_images" ADD CONSTRAINT "work_images_source_candidate_media_id_fkey"
  FOREIGN KEY ("source_candidate_media_id") REFERENCES "candidate_media"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Historical imports copied the whole candidate in its existing order. Only
-- recover a page's source when post, order and original file all agree. Never
-- infer the original request revision from a candidate's present revision.
UPDATE "work_images" AS image
SET "source_candidate_media_id" = media."id"
FROM "works" AS work, "candidate_media" AS media
WHERE image."work_id" = work."id"
  AND media."candidate_post_id" = work."source_candidate_post_id"
  AND media."order_index" = image."order_index"
  AND media."file_object_id" = image."original_file_object_id";

COMMIT;
