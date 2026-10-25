-- CreateEnum
CREATE TYPE "ImageDerivativeStatus" AS ENUM ('queued', 'processing', 'ready', 'reused', 'failed');

-- CreateTable
CREATE TABLE "image_derivatives" (
    "id" UUID NOT NULL,
    "source_file_id" UUID NOT NULL,
    "recipe" VARCHAR(64) NOT NULL,
    "status" "ImageDerivativeStatus" NOT NULL DEFAULT 'queued',
    "output_file_id" UUID,
    "width" INTEGER,
    "height" INTEGER,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "image_derivatives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_derivatives_status_created_at_idx" ON "image_derivatives"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "image_derivatives_source_file_id_recipe_key" ON "image_derivatives"("source_file_id", "recipe");

-- AddForeignKey
ALTER TABLE "image_derivatives" ADD CONSTRAINT "image_derivatives_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_derivatives" ADD CONSTRAINT "image_derivatives_output_file_id_fkey" FOREIGN KEY ("output_file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
