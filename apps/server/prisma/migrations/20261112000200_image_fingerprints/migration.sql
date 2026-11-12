BEGIN;

CREATE TYPE "ImageFingerprintStatus" AS ENUM ('queued', 'running', 'ready', 'failed');

CREATE TABLE "image_fingerprints" (
    "id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "recipe_version" VARCHAR(64) NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "status" "ImageFingerprintStatus" NOT NULL DEFAULT 'queued',
    "phash_hex" CHAR(16),
    "width" INTEGER,
    "height" INTEGER,
    "job_id" UUID,
    "last_error" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "image_fingerprints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "image_fingerprint_ready_hash_check" CHECK (
      "status" <> 'ready' OR ("phash_hex" IS NOT NULL AND "phash_hex" ~ '^[0-9a-f]{16}$')
    ),
    CONSTRAINT "image_fingerprint_sha_check" CHECK (
      "source_sha256" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "image_fingerprints_file_object_id_recipe_version_key"
  ON "image_fingerprints"("file_object_id", "recipe_version");
CREATE INDEX "image_fingerprints_recipe_version_status_created_at_id_idx"
  ON "image_fingerprints"("recipe_version", "status", "created_at", "id");
CREATE INDEX "image_fingerprints_recipe_version_source_sha256_status_idx"
  ON "image_fingerprints"("recipe_version", "source_sha256", "status");
CREATE INDEX "file_objects_checksum_idx" ON "file_objects"("checksum");

ALTER TABLE "image_fingerprints" ADD CONSTRAINT "image_fingerprints_file_object_id_fkey"
  FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
