ALTER TABLE "authors" DROP COLUMN "authorization_note";

CREATE TABLE "author_authorization_evidence" (
  "id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "file_object_id" UUID NOT NULL,
  "order_index" INTEGER NOT NULL,
  "uploaded_by" UUID NOT NULL,
  "deleted_by" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(3),

  CONSTRAINT "author_authorization_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "author_authorization_evidence_author_id_order_index_idx"
  ON "author_authorization_evidence"("author_id", "order_index");
CREATE INDEX "author_authorization_evidence_author_id_deleted_at_idx"
  ON "author_authorization_evidence"("author_id", "deleted_at");
CREATE INDEX "author_authorization_evidence_file_object_id_idx"
  ON "author_authorization_evidence"("file_object_id");

ALTER TABLE "author_authorization_evidence"
  ADD CONSTRAINT "author_authorization_evidence_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "authors"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "author_authorization_evidence"
  ADD CONSTRAINT "author_authorization_evidence_file_object_id_fkey"
  FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "author_authorization_evidence"
  ADD CONSTRAINT "author_authorization_evidence_uploaded_by_fkey"
  FOREIGN KEY ("uploaded_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "author_authorization_evidence"
  ADD CONSTRAINT "author_authorization_evidence_deleted_by_fkey"
  FOREIGN KEY ("deleted_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
