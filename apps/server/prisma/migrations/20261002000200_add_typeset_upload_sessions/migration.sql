-- CreateTable
CREATE TABLE "typeset_upload_sessions" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "typeset_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "typeset_upload_files" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "source_name" VARCHAR(255) NOT NULL,
    "order_index" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "size" BIGINT NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "error" VARCHAR(500),

    CONSTRAINT "typeset_upload_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "typeset_upload_images" (
    "id" UUID NOT NULL,
    "upload_file_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "source_name" VARCHAR(255) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "order_index" INTEGER NOT NULL,

    CONSTRAINT "typeset_upload_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "typeset_upload_previews" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "work_revision" INTEGER NOT NULL,
    "editor_epoch" INTEGER NOT NULL,
    "handoff_started_at" TIMESTAMPTZ(3) NOT NULL,
    "image_ids" JSONB NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "version_id" UUID,

    CONSTRAINT "typeset_upload_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "typeset_upload_sessions_actor_id_created_at_idx" ON "typeset_upload_sessions"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "typeset_upload_sessions_expires_at_status_idx" ON "typeset_upload_sessions"("expires_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "typeset_upload_files_object_key_key" ON "typeset_upload_files"("object_key");

-- CreateIndex
CREATE INDEX "typeset_upload_images_upload_file_id_order_index_idx" ON "typeset_upload_images"("upload_file_id", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "typeset_upload_previews_idempotency_key_key" ON "typeset_upload_previews"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "typeset_upload_previews_session_id_work_id_key" ON "typeset_upload_previews"("session_id", "work_id");

-- AddForeignKey
ALTER TABLE "typeset_upload_sessions" ADD CONSTRAINT "typeset_upload_sessions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_upload_files" ADD CONSTRAINT "typeset_upload_files_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "typeset_upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_upload_images" ADD CONSTRAINT "typeset_upload_images_upload_file_id_fkey" FOREIGN KEY ("upload_file_id") REFERENCES "typeset_upload_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_upload_images" ADD CONSTRAINT "typeset_upload_images_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_upload_previews" ADD CONSTRAINT "typeset_upload_previews_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "typeset_upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_upload_previews" ADD CONSTRAINT "typeset_upload_previews_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typeset_upload_previews" ADD CONSTRAINT "typeset_upload_previews_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "typeset_image_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
