-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('pending', 'authorized', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "FirstSyncMode" AS ENUM ('none', 'last_24_hours');

-- CreateEnum
CREATE TYPE "FileLifecycleStatus" AS ENUM ('active', 'pending_deletion', 'deleted');

-- CreateTable
CREATE TABLE "file_objects" (
    "id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "bucket_scope" VARCHAR(32) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "size" BIGINT NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "lifecycle_status" "FileLifecycleStatus" NOT NULL DEFAULT 'active',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authors" (
    "id" UUID NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "avatar_file_object_id" UUID,
    "authorization_status" "AuthorizationStatus" NOT NULL DEFAULT 'pending',
    "authorization_note" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "authors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "author_external_accounts" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "external_user_id" VARCHAR(255) NOT NULL,
    "handle" VARCHAR(255),
    "profile_url" VARCHAR(2048),
    "display_name_snapshot" VARCHAR(255),
    "avatar_file_object_id" UUID,
    "fetch_enabled" BOOLEAN NOT NULL DEFAULT true,
    "first_sync_mode" "FirstSyncMode" NOT NULL DEFAULT 'none',
    "cursor_json" JSONB NOT NULL DEFAULT '{}',
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "last_checked_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "author_external_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "normalized_name" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "author_tags" (
    "author_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "author_tags_pkey" PRIMARY KEY ("author_id","tag_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_object_key_key" ON "file_objects"("object_key");

-- CreateIndex
CREATE INDEX "file_objects_bucket_scope_kind_lifecycle_status_idx" ON "file_objects"("bucket_scope", "kind", "lifecycle_status");

-- CreateIndex
CREATE INDEX "file_objects_created_by_idx" ON "file_objects"("created_by");

-- CreateIndex
CREATE INDEX "authors_authorization_status_deleted_at_idx" ON "authors"("authorization_status", "deleted_at");

-- CreateIndex
CREATE INDEX "author_external_accounts_author_id_deleted_at_idx" ON "author_external_accounts"("author_id", "deleted_at");

-- CreateIndex
CREATE INDEX "author_external_accounts_platform_fetch_enabled_deleted_at_idx" ON "author_external_accounts"("platform", "fetch_enabled", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "author_external_accounts_platform_external_user_id_key" ON "author_external_accounts"("platform", "external_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_normalized_name_key" ON "tags"("normalized_name");

-- CreateIndex
CREATE INDEX "author_tags_tag_id_idx" ON "author_tags"("tag_id");

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authors" ADD CONSTRAINT "authors_avatar_file_object_id_fkey" FOREIGN KEY ("avatar_file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "author_external_accounts" ADD CONSTRAINT "author_external_accounts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "author_external_accounts" ADD CONSTRAINT "author_external_accounts_avatar_file_object_id_fkey" FOREIGN KEY ("avatar_file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "author_tags" ADD CONSTRAINT "author_tags_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "author_tags" ADD CONSTRAINT "author_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
