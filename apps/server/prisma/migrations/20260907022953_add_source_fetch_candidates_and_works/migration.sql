-- CreateEnum
CREATE TYPE "SourceFetchTrigger" AS ENUM ('manual', 'scheduled');

-- CreateEnum
CREATE TYPE "SourceFetchRunStatus" AS ENUM ('running', 'succeeded', 'partial_failed', 'failed');

-- CreateEnum
CREATE TYPE "SourceFetchItemStatus" AS ENUM ('running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('pending', 'imported', 'discarded');

-- CreateEnum
CREATE TYPE "ReferencedPostType" AS ENUM ('reply', 'quote');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('pending_translate');

-- CreateTable
CREATE TABLE "source_fetch_runs" (
    "id" UUID NOT NULL,
    "trigger" "SourceFetchTrigger" NOT NULL,
    "status" "SourceFetchRunStatus" NOT NULL DEFAULT 'running',
    "requested_by" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "source_fetch_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_fetch_run_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "external_account_id" UUID NOT NULL,
    "status" "SourceFetchItemStatus" NOT NULL DEFAULT 'running',
    "cursor_before" JSONB NOT NULL,
    "cursor_after" JSONB,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "candidates_created" INTEGER NOT NULL DEFAULT 0,
    "candidates_existing" INTEGER NOT NULL DEFAULT 0,
    "media_stored" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "source_fetch_run_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_posts" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "author_external_account_id" UUID NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "external_post_id" VARCHAR(255) NOT NULL,
    "external_post_url" VARCHAR(2048) NOT NULL,
    "text" TEXT,
    "referenced_post_type" "ReferencedPostType",
    "referenced_post_id" VARCHAR(255),
    "posted_at" TIMESTAMPTZ(3) NOT NULL,
    "raw_json" JSONB NOT NULL,
    "status" "CandidateStatus" NOT NULL DEFAULT 'pending',
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "candidate_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_media" (
    "id" UUID NOT NULL,
    "candidate_post_id" UUID NOT NULL,
    "external_media_id" VARCHAR(255) NOT NULL,
    "order_index" INTEGER NOT NULL,
    "file_object_id" UUID NOT NULL,
    "source_url" VARCHAR(2048) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "media_type" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "works" (
    "id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "source_candidate_post_id" UUID NOT NULL,
    "source_post_url" VARCHAR(2048) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "source_text" TEXT,
    "workflow_status" "WorkflowStatus" NOT NULL DEFAULT 'pending_translate',
    "imported_by" UUID NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "works_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_images" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "order_index" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_fetch_runs_started_at_idx" ON "source_fetch_runs"("started_at");

-- CreateIndex
CREATE INDEX "source_fetch_run_items_external_account_id_started_at_idx" ON "source_fetch_run_items"("external_account_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_fetch_run_items_run_id_external_account_id_key" ON "source_fetch_run_items"("run_id", "external_account_id");

-- CreateIndex
CREATE INDEX "candidate_posts_status_fetched_at_idx" ON "candidate_posts"("status", "fetched_at");

-- CreateIndex
CREATE INDEX "candidate_posts_author_id_status_fetched_at_idx" ON "candidate_posts"("author_id", "status", "fetched_at");

-- CreateIndex
CREATE INDEX "candidate_posts_author_external_account_id_fetched_at_idx" ON "candidate_posts"("author_external_account_id", "fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_posts_platform_external_post_id_key" ON "candidate_posts"("platform", "external_post_id");

-- CreateIndex
CREATE INDEX "candidate_media_file_object_id_idx" ON "candidate_media"("file_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_media_candidate_post_id_external_media_id_key" ON "candidate_media"("candidate_post_id", "external_media_id");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_media_candidate_post_id_order_index_key" ON "candidate_media"("candidate_post_id", "order_index");

-- CreateIndex
CREATE UNIQUE INDEX "works_source_candidate_post_id_key" ON "works"("source_candidate_post_id");

-- CreateIndex
CREATE INDEX "works_workflow_status_imported_at_idx" ON "works"("workflow_status", "imported_at");

-- CreateIndex
CREATE INDEX "works_author_id_imported_at_idx" ON "works"("author_id", "imported_at");

-- CreateIndex
CREATE INDEX "work_images_file_object_id_idx" ON "work_images"("file_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_images_work_id_order_index_key" ON "work_images"("work_id", "order_index");

-- AddForeignKey
ALTER TABLE "source_fetch_runs" ADD CONSTRAINT "source_fetch_runs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_fetch_run_items" ADD CONSTRAINT "source_fetch_run_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "source_fetch_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_fetch_run_items" ADD CONSTRAINT "source_fetch_run_items_external_account_id_fkey" FOREIGN KEY ("external_account_id") REFERENCES "author_external_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_posts" ADD CONSTRAINT "candidate_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_posts" ADD CONSTRAINT "candidate_posts_author_external_account_id_fkey" FOREIGN KEY ("author_external_account_id") REFERENCES "author_external_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_posts" ADD CONSTRAINT "candidate_posts_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_media" ADD CONSTRAINT "candidate_media_candidate_post_id_fkey" FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_media" ADD CONSTRAINT "candidate_media_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "works" ADD CONSTRAINT "works_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "works" ADD CONSTRAINT "works_source_candidate_post_id_fkey" FOREIGN KEY ("source_candidate_post_id") REFERENCES "candidate_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "works" ADD CONSTRAINT "works_imported_by_fkey" FOREIGN KEY ("imported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_images" ADD CONSTRAINT "work_images_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_images" ADD CONSTRAINT "work_images_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
