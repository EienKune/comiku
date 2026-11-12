ALTER TABLE "work_events" ADD COLUMN "notification_captured_at" TIMESTAMPTZ(3);
ALTER TABLE "notification_channels" ADD COLUMN "source_accept_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "notification_work_event_activation" (
  "id" VARCHAR(32) NOT NULL,
  "source_since" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_work_event_activation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "notification_work_event_receipts" (
  "id" UUID NOT NULL,
  "source_event_id" UUID NOT NULL,
  "resource_id" UUID NOT NULL,
  "resource_ordinal" INTEGER NOT NULL,
  "input_version" INTEGER NOT NULL DEFAULT 1,
  "safe_input" JSONB NOT NULL,
  "payload_hash" CHAR(64),
  "route_refs" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "error_code" VARCHAR(64),
  "notification_event_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "notification_work_event_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_work_receipt_source_key" ON "notification_work_event_receipts"("source_event_id");
CREATE UNIQUE INDEX "notification_work_receipt_resource_ordinal_key" ON "notification_work_event_receipts"("resource_id", "resource_ordinal");
CREATE INDEX "notification_work_receipt_due_idx" ON "notification_work_event_receipts"("status", "next_attempt_at", "created_at");
CREATE INDEX "notification_work_receipt_resource_pending_idx" ON "notification_work_event_receipts"("resource_id", "status", "resource_ordinal");
-- This notification-only marker is ignored by Prisma default WorkEvent reads/DTOs.
CREATE INDEX "work_events_notification_uncaptured_idx" ON "work_events"("created_at", "id")
WHERE "notification_captured_at" IS NULL AND "action" IN (
  'imported', 'stage_joined', 'stage_started', 'typeset_handoff_started',
  'stage_left', 'stage_assignment_updated', 'stage_submitted',
  'proofreading_skipped', 'stage_submission_cancelled', 'review_opened',
  'review_withdrawn', 'review_resumed', 'archived', 'restored', 'publish_confirmed'
);
