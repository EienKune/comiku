ALTER TYPE "WorkEventAction" ADD VALUE 'typeset_version_uploaded';
ALTER TYPE "WorkEventAction" ADD VALUE 'typeset_version_selected';
ALTER TYPE "WorkEventAction" ADD VALUE 'typeset_version_deleted';
ALTER TYPE "WorkEventAction" ADD VALUE 'typeset_version_restored';

CREATE TABLE "typeset_image_versions" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "note" VARCHAR(1000),
    "automatically_sorted" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),
    "deleted_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "typeset_image_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "typeset_image_version_images" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "work_image_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "source_name" VARCHAR(255) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "typeset_image_version_images_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "works" ADD COLUMN "current_typeset_version_id" UUID;

CREATE UNIQUE INDEX "works_current_typeset_version_id_key"
    ON "works"("current_typeset_version_id");
CREATE UNIQUE INDEX "typeset_image_versions_work_id_version_number_key"
    ON "typeset_image_versions"("work_id", "version_number");
CREATE UNIQUE INDEX "typeset_image_versions_work_id_idempotency_key_key"
    ON "typeset_image_versions"("work_id", "idempotency_key");
CREATE INDEX "typeset_image_versions_work_id_deleted_at_created_at_idx"
    ON "typeset_image_versions"("work_id", "deleted_at", "created_at");
CREATE INDEX "typeset_image_versions_uploaded_by_created_at_idx"
    ON "typeset_image_versions"("uploaded_by", "created_at");
CREATE INDEX "typeset_image_versions_deleted_by_deleted_at_idx"
    ON "typeset_image_versions"("deleted_by", "deleted_at");
CREATE UNIQUE INDEX "typeset_image_version_images_version_id_order_index_key"
    ON "typeset_image_version_images"("version_id", "order_index");
CREATE UNIQUE INDEX "typeset_image_version_images_version_id_work_image_id_key"
    ON "typeset_image_version_images"("version_id", "work_image_id");
CREATE INDEX "typeset_image_version_images_work_image_id_idx"
    ON "typeset_image_version_images"("work_image_id");
CREATE INDEX "typeset_image_version_images_file_object_id_idx"
    ON "typeset_image_version_images"("file_object_id");

ALTER TABLE "typeset_image_versions"
    ADD CONSTRAINT "typeset_image_versions_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typeset_image_versions"
    ADD CONSTRAINT "typeset_image_versions_uploaded_by_fkey"
    FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typeset_image_versions"
    ADD CONSTRAINT "typeset_image_versions_deleted_by_fkey"
    FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typeset_image_version_images"
    ADD CONSTRAINT "typeset_image_version_images_version_id_fkey"
    FOREIGN KEY ("version_id") REFERENCES "typeset_image_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "typeset_image_version_images"
    ADD CONSTRAINT "typeset_image_version_images_work_image_id_fkey"
    FOREIGN KEY ("work_image_id") REFERENCES "work_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typeset_image_version_images"
    ADD CONSTRAINT "typeset_image_version_images_file_object_id_fkey"
    FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "works"
    ADD CONSTRAINT "works_current_typeset_version_id_fkey"
    FOREIGN KEY ("current_typeset_version_id") REFERENCES "typeset_image_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
