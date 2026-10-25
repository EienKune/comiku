CREATE TYPE "TypesetHandoffPackageKind" AS ENUM ('source_images');

CREATE TABLE "typeset_handoff_packages" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "kind" "TypesetHandoffPackageKind" NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "image_count" INTEGER NOT NULL,
    "work_revision" INTEGER NOT NULL,
    "editor_epoch" INTEGER NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "typeset_handoff_packages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "typeset_handoff_packages_work_id_kind_idempotency_key_key"
    ON "typeset_handoff_packages"("work_id", "kind", "idempotency_key");
CREATE INDEX "typeset_handoff_packages_work_id_created_at_idx"
    ON "typeset_handoff_packages"("work_id", "created_at");
CREATE INDEX "typeset_handoff_packages_file_object_id_idx"
    ON "typeset_handoff_packages"("file_object_id");
CREATE INDEX "typeset_handoff_packages_created_by_created_at_idx"
    ON "typeset_handoff_packages"("created_by", "created_at");

ALTER TABLE "typeset_handoff_packages"
    ADD CONSTRAINT "typeset_handoff_packages_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typeset_handoff_packages"
    ADD CONSTRAINT "typeset_handoff_packages_file_object_id_fkey"
    FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "typeset_handoff_packages"
    ADD CONSTRAINT "typeset_handoff_packages_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
