BEGIN;

CREATE TABLE "candidate_composition_receipts" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "candidate_composition_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "candidate_composition_receipts_actor_id_idempotency_key_key" ON "candidate_composition_receipts"("actor_id", "idempotency_key");
ALTER TABLE "candidate_composition_receipts" ADD CONSTRAINT "candidate_composition_receipts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "works" ADD COLUMN "candidate_composition_id" UUID;
ALTER TABLE "works" ADD CONSTRAINT "works_candidate_composition_id_fkey" FOREIGN KEY ("candidate_composition_id") REFERENCES "candidate_composition_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "works_source_candidate_post_id_key";
CREATE INDEX "works_source_candidate_post_id_idx" ON "works"("source_candidate_post_id");
CREATE INDEX "works_candidate_composition_id_idx" ON "works"("candidate_composition_id");

CREATE TABLE "work_candidate_sources" (
  "work_id" UUID NOT NULL,
  "candidate_post_id" UUID NOT NULL,
  "order_index" INTEGER NOT NULL,
  "imported_revision" INTEGER,
  "source_text" TEXT,
  "mapping_known" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "work_candidate_sources_pkey" PRIMARY KEY ("work_id", "candidate_post_id")
);
CREATE UNIQUE INDEX "work_candidate_sources_work_id_order_index_key" ON "work_candidate_sources"("work_id", "order_index");
CREATE INDEX "work_candidate_sources_candidate_post_id_work_id_idx" ON "work_candidate_sources"("candidate_post_id", "work_id");
ALTER TABLE "work_candidate_sources" ADD CONSTRAINT "work_candidate_sources_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_candidate_sources" ADD CONSTRAINT "work_candidate_sources_candidate_post_id_fkey" FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A revision receipt is not evidence of complete page provenance. Verify every
-- adopted page against the primary post and its original file independently.
INSERT INTO "work_candidate_sources" ("work_id", "candidate_post_id", "order_index", "imported_revision", "source_text", "mapping_known")
SELECT w.id, w.source_candidate_post_id, 0, w.candidate_import_revision, w.source_text,
  EXISTS (SELECT 1 FROM work_images i WHERE i.work_id=w.id)
  AND NOT EXISTS (
    SELECT 1 FROM work_images i
    LEFT JOIN candidate_media m ON m.id=i.source_candidate_media_id
    WHERE i.work_id=w.id AND (
      m.id IS NULL OR m.candidate_post_id<>w.source_candidate_post_id
      OR m.file_object_id<>i.original_file_object_id
    )
  )
FROM works w;
ALTER TABLE "works" DROP COLUMN "candidate_import_revision";

COMMIT;
