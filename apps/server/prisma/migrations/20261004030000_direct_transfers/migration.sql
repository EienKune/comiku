-- CreateEnum
CREATE TYPE "DirectUploadPurpose" AS ENUM ('author_avatar', 'author_evidence', 'typeset_single');

-- CreateEnum
CREATE TYPE "DirectUploadStatus" AS ENUM ('pending', 'queued', 'processing', 'completed', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "DownloadPurpose" AS ENUM ('handoff', 'publication');

-- CreateTable
CREATE TABLE "direct_upload_sessions" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "purpose" "DirectUploadPurpose" NOT NULL,
    "status" "DirectUploadStatus" NOT NULL DEFAULT 'pending',
    "expected_revision" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" VARCHAR(500),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "download_preparations" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "purpose" "DownloadPurpose" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "expected_revision" INTEGER NOT NULL,
    "expected_editor_epoch" INTEGER NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "file_object_id" UUID,
    "package_id" UUID,
    "file_name" VARCHAR(255),
    "error" VARCHAR(500),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "download_preparations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "direct_upload_sessions_actor_id_created_at_idx" ON "direct_upload_sessions"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "direct_upload_sessions_status_expires_at_idx" ON "direct_upload_sessions"("status", "expires_at");

-- CreateIndex
CREATE INDEX "download_preparations_status_expires_at_idx" ON "download_preparations"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "download_preparations_actor_id_idempotency_key_key" ON "download_preparations"("actor_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "download_preparations" ADD CONSTRAINT "download_preparations_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
