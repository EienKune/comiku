BEGIN;

CREATE TABLE "source_discovery_posts" (
 "id" UUID NOT NULL, "account_id" UUID NOT NULL, "platform" VARCHAR(32) NOT NULL,
 "external_post_id" VARCHAR(200) NOT NULL, "source_user_id" VARCHAR(200) NOT NULL,
 "adapter_key" VARCHAR(100) NOT NULL, "actor_id" UUID, "discovered_run_id" UUID NOT NULL,
 "window_json" JSONB NOT NULL, "evidence_json" JSONB NOT NULL DEFAULT '{}', "metadata_json" JSONB,
 "expected_media_count" INTEGER, "state" VARCHAR(32) NOT NULL DEFAULT 'metadata_pending',
 "failure_code" VARCHAR(64), "attempts" INTEGER NOT NULL DEFAULT 0,
 "next_retry_at" TIMESTAMPTZ(3), "revision" INTEGER NOT NULL DEFAULT 0,
 "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "source_discovery_posts_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "source_discovery_posts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "author_external_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "source_discovery_posts_account_id_platform_external_post_id_key" ON "source_discovery_posts"("account_id", "platform", "external_post_id");
CREATE INDEX "source_discovery_posts_state_next_retry_at_account_id_idx" ON "source_discovery_posts"("state", "next_retry_at", "account_id");
CREATE TABLE "source_discovery_media" (
 "id" UUID NOT NULL, "discovery_post_id" UUID NOT NULL, "external_media_id" VARCHAR(200) NOT NULL,
 "order_index" INTEGER NOT NULL, "metadata_json" JSONB NOT NULL, "file_object_id" UUID,
 "state" VARCHAR(32) NOT NULL DEFAULT 'pending', "failure_code" VARCHAR(64), "attempts" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "source_discovery_media_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "source_discovery_media_discovery_post_id_fkey" FOREIGN KEY ("discovery_post_id") REFERENCES "source_discovery_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "source_discovery_media_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "source_discovery_media_discovery_post_id_external_media_id_key" ON "source_discovery_media"("discovery_post_id", "external_media_id");
CREATE INDEX "source_discovery_media_file_object_id_idx" ON "source_discovery_media"("file_object_id");
CREATE TABLE "source_recovery_campaigns" (
 "scan_epoch" INTEGER,
 "id" UUID NOT NULL, "discovery_post_id" UUID NOT NULL, "number" INTEGER NOT NULL, "job_id" UUID,
 "state" VARCHAR(32) NOT NULL DEFAULT 'queued', "failure_code" VARCHAR(64),
 "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMPTZ(3),
 CONSTRAINT "source_recovery_campaigns_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "source_recovery_campaigns_discovery_post_id_fkey" FOREIGN KEY ("discovery_post_id") REFERENCES "source_discovery_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "source_recovery_campaigns_job_id_key" ON "source_recovery_campaigns"("job_id");
CREATE UNIQUE INDEX "source_recovery_campaigns_discovery_post_id_number_key" ON "source_recovery_campaigns"("discovery_post_id", "number");
CREATE INDEX "source_recovery_campaigns_state_completed_at_idx" ON "source_recovery_campaigns"("state", "completed_at");

COMMIT;
