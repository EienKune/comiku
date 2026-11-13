-- CreateTable
CREATE TABLE "archive_export_settings" (
    "id" VARCHAR(20) NOT NULL DEFAULT 'global',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "bandwidth_limit_mib" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "archive_export_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_export_runs" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "year" INTEGER NOT NULL,
    "month" INTEGER,
    "content" VARCHAR(16) NOT NULL,
    "include_archived" BOOLEAN NOT NULL DEFAULT false,
    "include_discarded" BOOLEAN NOT NULL DEFAULT false,
    "work_count" INTEGER NOT NULL DEFAULT 0,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "text_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "missing_rendered_count" INTEGER NOT NULL DEFAULT 0,
    "package_count" INTEGER NOT NULL DEFAULT 0,
    "completed_package_count" INTEGER NOT NULL DEFAULT 0,
    "captured_month_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_bytes" BIGINT NOT NULL DEFAULT 0,
    "completed_bytes" BIGINT NOT NULL DEFAULT 0,
    "error" VARCHAR(100),
    "files_status" VARCHAR(24) NOT NULL DEFAULT 'available',
    "files_deleted_at" TIMESTAMPTZ(3),
    "deletion_error" VARCHAR(100),
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "archive_export_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_export_months" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "month" INTEGER NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,

    CONSTRAINT "archive_export_months_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_export_work_snapshots" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "month_id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "work_number" INTEGER NOT NULL,
    "work_revision" INTEGER NOT NULL,
    "editor_epoch" INTEGER NOT NULL,
    "workflow_status" VARCHAR(32) NOT NULL,
    "review_status" VARCHAR(32) NOT NULL,
    "text_source" VARCHAR(48) NOT NULL,
    "translation_version_id" UUID,
    "typeset_version_id" UUID,
    "facts" JSONB NOT NULL,
    "issues" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "archive_export_work_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_export_entries" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "snapshot_id" UUID,
    "package_id" UUID,
    "ordinal" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "path" TEXT NOT NULL,
    "file_object_id" UUID,
    "source_file_object_id" UUID,
    "source_key" TEXT,
    "work_image_id" UUID,
    "content_text" TEXT,
    "size" BIGINT NOT NULL,
    "checksum" CHAR(64) NOT NULL,

    CONSTRAINT "archive_export_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_export_packages" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "file_name" VARCHAR(255) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "estimated_bytes" BIGINT NOT NULL,
    "bytes" BIGINT,
    "checksum" CHAR(64),
    "file_object_id" UUID,
    "adopted_attempt_id" UUID,
    "error" VARCHAR(100),
    "job_id" UUID,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "archive_export_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_export_attempts" (
    "id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "job_id" UUID NOT NULL,
    "lease_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "upload_id" TEXT,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(24) NOT NULL DEFAULT 'running',
    "complete_intent" BOOLEAN NOT NULL DEFAULT false,
    "expected_bytes" BIGINT,
    "expected_checksum" CHAR(64),
    "error" VARCHAR(100),
    "cleanup_status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "cleanup_error" VARCHAR(100),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "archive_export_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_export_mutations" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "operation" VARCHAR(24) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archive_export_mutations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "archive_export_runs_created_at_id_idx" ON "archive_export_runs"("created_at", "id");

-- CreateIndex
CREATE INDEX "archive_export_runs_status_created_at_idx" ON "archive_export_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "archive_export_runs_files_status_expires_at_idx" ON "archive_export_runs"("files_status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_runs_actor_id_idempotency_key_key" ON "archive_export_runs"("actor_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_months_run_id_month_key" ON "archive_export_months"("run_id", "month");

-- CreateIndex
CREATE INDEX "archive_export_work_snapshots_run_id_work_number_id_idx" ON "archive_export_work_snapshots"("run_id", "work_number", "id");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_work_snapshots_run_id_work_id_key" ON "archive_export_work_snapshots"("run_id", "work_id");

-- CreateIndex
CREATE INDEX "archive_export_entries_file_object_id_idx" ON "archive_export_entries"("file_object_id");

-- CreateIndex
CREATE INDEX "archive_export_entries_package_id_ordinal_idx" ON "archive_export_entries"("package_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_entries_run_id_ordinal_key" ON "archive_export_entries"("run_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_entries_run_id_path_key" ON "archive_export_entries"("run_id", "path");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_packages_file_object_id_key" ON "archive_export_packages"("file_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_packages_adopted_attempt_id_key" ON "archive_export_packages"("adopted_attempt_id");

-- CreateIndex
CREATE INDEX "archive_export_packages_run_id_status_ordinal_idx" ON "archive_export_packages"("run_id", "status", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_packages_run_id_ordinal_key" ON "archive_export_packages"("run_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_attempts_object_key_key" ON "archive_export_attempts"("object_key");

-- CreateIndex
CREATE INDEX "archive_export_attempts_settled_at_started_at_idx" ON "archive_export_attempts"("settled_at", "started_at");

-- CreateIndex
CREATE INDEX "archive_export_attempts_package_id_cleanup_status_idx" ON "archive_export_attempts"("package_id", "cleanup_status");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_attempts_job_id_lease_id_key" ON "archive_export_attempts"("job_id", "lease_id");

-- CreateIndex
CREATE UNIQUE INDEX "archive_export_mutations_actor_id_idempotency_key_key" ON "archive_export_mutations"("actor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "works_created_archive_idx" ON "works"("created_at", "id");

-- AddForeignKey
ALTER TABLE "archive_export_runs" ADD CONSTRAINT "archive_export_runs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_months" ADD CONSTRAINT "archive_export_months_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "archive_export_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_work_snapshots" ADD CONSTRAINT "archive_export_work_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "archive_export_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_work_snapshots" ADD CONSTRAINT "archive_export_work_snapshots_month_id_fkey" FOREIGN KEY ("month_id") REFERENCES "archive_export_months"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_entries" ADD CONSTRAINT "archive_export_entries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "archive_export_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_entries" ADD CONSTRAINT "archive_export_entries_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "archive_export_work_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_entries" ADD CONSTRAINT "archive_export_entries_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "archive_export_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_entries" ADD CONSTRAINT "archive_export_entries_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_packages" ADD CONSTRAINT "archive_export_packages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "archive_export_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_packages" ADD CONSTRAINT "archive_export_packages_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_attempts" ADD CONSTRAINT "archive_export_attempts_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "archive_export_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_export_mutations" ADD CONSTRAINT "archive_export_mutations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "archive_export_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Work-local planning and month adoption must not scan the full archive history.
CREATE INDEX "archive_export_entries_snapshot_id_ordinal_idx" ON "archive_export_entries"("snapshot_id", "ordinal");
CREATE INDEX "archive_export_work_snapshots_month_id_idx" ON "archive_export_work_snapshots"("month_id");
