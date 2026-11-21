CREATE TABLE "typeset_upload_verifications" (
  "id" UUID NOT NULL,
  "upload_file_id" UUID NOT NULL,
  "object_key" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'processing',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleaned_at" TIMESTAMPTZ(3),
  CONSTRAINT "typeset_upload_verifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "typeset_upload_verifications_upload_file_id_fkey" FOREIGN KEY ("upload_file_id") REFERENCES "typeset_upload_files"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "typeset_upload_verifications_object_key_key" ON "typeset_upload_verifications"("object_key");
CREATE INDEX "typeset_upload_verifications_status_expires_at_idx" ON "typeset_upload_verifications"("status", "expires_at");
CREATE INDEX "typeset_upload_verifications_upload_file_id_status_idx" ON "typeset_upload_verifications"("upload_file_id", "status");
ALTER TABLE "typeset_upload_previews" ADD COLUMN "applied_at" TIMESTAMPTZ(3);
