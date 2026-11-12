BEGIN;

ALTER TABLE "notification_deliveries"
  ADD COLUMN "reminder_generation" INTEGER,
  ADD COLUMN "reminder_scope_generation" INTEGER,
  ADD COLUMN "message_segments" JSONB;

CREATE TABLE "work_reminder_settings" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "send_times" TEXT[] DEFAULT ARRAY['09:00','18:00']::TEXT[],
  "note" VARCHAR(480) NOT NULL DEFAULT '',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "accept_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "work_reminder_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_reminder_subscriptions" (
  "channel_id" UUID NOT NULL,
  "digest_enabled" BOOLEAN NOT NULL DEFAULT false,
  "ready_enabled" BOOLEAN NOT NULL DEFAULT false,
  "overdue_enabled" BOOLEAN NOT NULL DEFAULT false,
  "mentions_enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "accept_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "work_reminder_subscriptions_pkey" PRIMARY KEY ("channel_id"),
  CONSTRAINT "work_reminder_subscriptions_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "work_reminder_clock" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "elapsed_milliseconds" BIGINT NOT NULL DEFAULT 0,
  "last_observed_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "work_reminder_clock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_reminder_episodes" (
  "participant_id" UUID NOT NULL,
  "work_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "stage" "WorkStage" NOT NULL,
  "round" INTEGER NOT NULL DEFAULT 1,
  "state" VARCHAR(16) NOT NULL,
  "source_key" CHAR(64) NOT NULL,
  "evidence_key" CHAR(64) NOT NULL,
  "eligible_milliseconds" BIGINT NOT NULL DEFAULT 0,
  "clock_milliseconds" BIGINT NOT NULL DEFAULT 0,
  "last_observed_at" TIMESTAMPTZ(3) NOT NULL,
  "ready_observed_at" TIMESTAMPTZ(3),
  "preclaimed" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "work_reminder_episodes_pkey" PRIMARY KEY ("participant_id")
);
CREATE INDEX "work_reminder_episode_observed_idx" ON "work_reminder_episodes"("last_observed_at", "participant_id");
CREATE INDEX "work_reminder_episode_active_observed_idx" ON "work_reminder_episodes"("last_observed_at", "participant_id") WHERE "state" <> 'ended';
CREATE INDEX "work_reminder_episode_due_idx" ON "work_reminder_episodes"("state", "eligible_milliseconds", "participant_id");

CREATE TABLE "work_digest_occurrences" (
  "id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "local_date" CHAR(10) NOT NULL,
  "slot" VARCHAR(5) NOT NULL,
  "due_at" TIMESTAMPTZ(3) NOT NULL,
  "valid_before" TIMESTAMPTZ(3) NOT NULL,
  "event_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_digest_occurrences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "work_digest_occurrences_event_id_key" ON "work_digest_occurrences"("event_id");
CREATE UNIQUE INDEX "work_digest_occurrence_slot_key" ON "work_digest_occurrences"("channel_id", "local_date", "slot");
CREATE INDEX "work_digest_occurrence_expiry_idx" ON "work_digest_occurrences"("valid_before");

CREATE TABLE "work_reminder_notices" (
  "id" UUID NOT NULL,
  "participant_id" UUID NOT NULL,
  "round" INTEGER NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "channel_id" UUID NOT NULL,
  "scope_generation" INTEGER NOT NULL,
  "event_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_reminder_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "work_reminder_notice_once_key" ON "work_reminder_notices"("participant_id", "round", "kind", "channel_id", "scope_generation");
CREATE INDEX "work_reminder_notice_scope_idx" ON "work_reminder_notices"("channel_id", "scope_generation", "event_id");
CREATE INDEX "work_reminder_notice_event_idx" ON "work_reminder_notices"("event_id");

-- Cancellation rounds are append-only evidence; this read never locks business writes.
CREATE INDEX "work_event_reminder_cancel_idx" ON "work_events"("work_id", "created_at", "id") WHERE "action" = 'stage_submission_cancelled';

COMMIT;
