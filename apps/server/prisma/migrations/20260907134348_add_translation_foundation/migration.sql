-- CreateEnum
CREATE TYPE "MarkerPositionType" AS ENUM ('inside', 'outside');

-- CreateEnum
CREATE TYPE "TranslationVersionKind" AS ENUM ('translate_submission', 'proofread_submission', 'revision', 'labelplus_import');

-- CreateEnum
CREATE TYPE "LabelPlusFileDirection" AS ENUM ('import', 'export');

-- CreateTable
CREATE TABLE "translation_entries" (
    "id" UUID NOT NULL,
    "work_image_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "marker_x" DECIMAL(8,7) NOT NULL,
    "marker_y" DECIMAL(8,7) NOT NULL,
    "marker_position_type" "MarkerPositionType" NOT NULL,
    "translated_text" TEXT NOT NULL DEFAULT '',
    "note" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "creation_idempotency_key" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "translation_entries_order_index_check" CHECK ("order_index" >= 0),
    CONSTRAINT "translation_entries_marker_x_check" CHECK ("marker_x" >= 0 AND "marker_x" <= 1),
    CONSTRAINT "translation_entries_marker_y_check" CHECK ("marker_y" >= 0 AND "marker_y" <= 1),
    CONSTRAINT "translation_entries_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "translation_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_versions" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "kind" "TranslationVersionKind" NOT NULL,
    "work_revision" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_versions_version_number_check" CHECK ("version_number" > 0),
    CONSTRAINT "translation_versions_work_revision_check" CHECK ("work_revision" >= 0),
    CONSTRAINT "translation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation_version_entries" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "work_image_id" UUID NOT NULL,
    "source_entry_id" UUID,
    "order_index" INTEGER NOT NULL,
    "marker_x" DECIMAL(8,7) NOT NULL,
    "marker_y" DECIMAL(8,7) NOT NULL,
    "marker_position_type" "MarkerPositionType" NOT NULL,
    "translated_text" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "translation_version_entries_order_index_check" CHECK ("order_index" >= 0),
    CONSTRAINT "translation_version_entries_marker_x_check" CHECK ("marker_x" >= 0 AND "marker_x" <= 1),
    CONSTRAINT "translation_version_entries_marker_y_check" CHECK ("marker_y" >= 0 AND "marker_y" <= 1),
    CONSTRAINT "translation_version_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labelplus_files" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "direction" "LabelPlusFileDirection" NOT NULL,
    "format_version" VARCHAR(32) NOT NULL,
    "parse_warnings" JSONB NOT NULL DEFAULT '[]',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labelplus_files_format_version_check" CHECK (length(btrim("format_version")) > 0),
    CONSTRAINT "labelplus_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "translation_entries_created_by_created_at_idx" ON "translation_entries"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "translation_entries_updated_by_updated_at_idx" ON "translation_entries"("updated_by", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "translation_entries_work_image_id_order_index_key" ON "translation_entries"("work_image_id", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "translation_entries_work_image_id_creation_idempotency_key_key" ON "translation_entries"("work_image_id", "creation_idempotency_key");

-- CreateIndex
CREATE INDEX "translation_versions_work_id_created_at_idx" ON "translation_versions"("work_id", "created_at");

-- CreateIndex
CREATE INDEX "translation_versions_created_by_created_at_idx" ON "translation_versions"("created_by", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "translation_versions_work_id_version_number_key" ON "translation_versions"("work_id", "version_number");

-- CreateIndex
CREATE INDEX "translation_version_entries_work_image_id_idx" ON "translation_version_entries"("work_image_id");

-- CreateIndex
CREATE INDEX "translation_version_entries_source_entry_id_idx" ON "translation_version_entries"("source_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "translation_version_entries_version_id_work_image_id_order__key" ON "translation_version_entries"("version_id", "work_image_id", "order_index");

-- CreateIndex
CREATE INDEX "labelplus_files_work_id_created_at_idx" ON "labelplus_files"("work_id", "created_at");

-- CreateIndex
CREATE INDEX "labelplus_files_file_object_id_idx" ON "labelplus_files"("file_object_id");

-- CreateIndex
CREATE INDEX "labelplus_files_created_by_created_at_idx" ON "labelplus_files"("created_by", "created_at");

-- AddForeignKey
ALTER TABLE "translation_entries" ADD CONSTRAINT "translation_entries_work_image_id_fkey" FOREIGN KEY ("work_image_id") REFERENCES "work_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_entries" ADD CONSTRAINT "translation_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_entries" ADD CONSTRAINT "translation_entries_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_versions" ADD CONSTRAINT "translation_versions_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_versions" ADD CONSTRAINT "translation_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_version_entries" ADD CONSTRAINT "translation_version_entries_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "translation_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_version_entries" ADD CONSTRAINT "translation_version_entries_work_image_id_fkey" FOREIGN KEY ("work_image_id") REFERENCES "work_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation_version_entries" ADD CONSTRAINT "translation_version_entries_source_entry_id_fkey" FOREIGN KEY ("source_entry_id") REFERENCES "translation_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labelplus_files" ADD CONSTRAINT "labelplus_files_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labelplus_files" ADD CONSTRAINT "labelplus_files_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labelplus_files" ADD CONSTRAINT "labelplus_files_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
