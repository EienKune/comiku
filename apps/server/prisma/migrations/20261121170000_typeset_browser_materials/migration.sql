CREATE TABLE "typeset_materials" (
 "id" UUID NOT NULL, "work_id" UUID NOT NULL, "actor_id" UUID NOT NULL,
 "translation_version_id" UUID NOT NULL, "source_asset_revision" INTEGER NOT NULL,
 "work_revision" INTEGER NOT NULL, "editor_epoch" INTEGER NOT NULL,
 "idempotency_key" UUID NOT NULL, "require_current_participation" BOOLEAN NOT NULL,
 "file_name" VARCHAR(255) NOT NULL, "translation_file_name" VARCHAR(255) NOT NULL,
 "translation_base64" TEXT NOT NULL, "delivered_at" TIMESTAMPTZ(3),
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "typeset_materials_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "typeset_materials_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "typeset_materials_translation_version_id_fkey" FOREIGN KEY ("translation_version_id") REFERENCES "translation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "typeset_materials_actor_id_idempotency_key_key" ON "typeset_materials"("actor_id", "idempotency_key");
CREATE INDEX "typeset_materials_work_id_created_at_idx" ON "typeset_materials"("work_id", "created_at");
CREATE TABLE "typeset_material_images" (
 "material_id" UUID NOT NULL, "work_image_id" UUID NOT NULL,
 "file_object_id" UUID NOT NULL, "order_index" INTEGER NOT NULL, "file_name" VARCHAR(255) NOT NULL,
 CONSTRAINT "typeset_material_images_pkey" PRIMARY KEY ("material_id", "order_index"),
 CONSTRAINT "typeset_material_images_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "typeset_materials"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "typeset_material_images_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "typeset_material_images_file_object_id_idx" ON "typeset_material_images"("file_object_id");
