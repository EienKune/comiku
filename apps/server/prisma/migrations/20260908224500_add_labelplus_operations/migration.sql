-- AlterEnum
ALTER TYPE "WorkEventAction" ADD VALUE 'translation_imported';

-- AlterTable
ALTER TABLE "labelplus_files" ADD COLUMN "idempotency_key" UUID;
ALTER TABLE "labelplus_files" ADD COLUMN "file_name" VARCHAR(255) NOT NULL DEFAULT 'labelplus.txt';
ALTER TABLE "labelplus_files" ADD COLUMN "image_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "labelplus_files" ADD COLUMN "marker_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "labelplus_files"
SET "idempotency_key" = gen_random_uuid()
WHERE "idempotency_key" IS NULL;

ALTER TABLE "labelplus_files" ALTER COLUMN "idempotency_key" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "labelplus_files_work_id_direction_idempotency_key_key" ON "labelplus_files"("work_id", "direction", "idempotency_key");
