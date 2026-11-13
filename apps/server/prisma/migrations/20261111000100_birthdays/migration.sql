BEGIN;
-- AlterTable
ALTER TABLE "notification_events" ADD COLUMN     "resource_kind" VARCHAR(32) NOT NULL DEFAULT 'work';

-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "birthday_global_generation" INTEGER,
ADD COLUMN     "birthday_offset_generation" INTEGER,
ADD COLUMN     "birthday_scope_generation" INTEGER;

-- CreateTable
CREATE TABLE "birthday_settings" (
    "id" VARCHAR(32) NOT NULL DEFAULT 'global',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "display_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reminders_enabled" BOOLEAN NOT NULL DEFAULT false,
    "send_time" VARCHAR(5) NOT NULL DEFAULT '09:00',
    "offset_days" INTEGER[] DEFAULT ARRAY[0]::INTEGER[],
    "reminder_generation" INTEGER NOT NULL DEFAULT 1,
    "reminder_accept_after" TIMESTAMPTZ(3),
    "offset_states" JSONB NOT NULL DEFAULT '{}',
    "template_note" VARCHAR(480) NOT NULL DEFAULT '',
    "template_revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "birthday_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "birthday_identities" (
    "entry_id" INTEGER NOT NULL,
    "person_key" VARCHAR(128) NOT NULL,
    "original_entry_id" INTEGER,
    "status" VARCHAR(16) NOT NULL DEFAULT 'confirmed',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "birthday_identities_pkey" PRIMARY KEY ("entry_id")
);

-- CreateTable
CREATE TABLE "birthday_name_overrides" (
    "person_key" VARCHAR(128) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "birthday_name_overrides_pkey" PRIMARY KEY ("person_key")
);

-- CreateTable
CREATE TABLE "birthday_catalogs" (
    "id" UUID NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "people" JSONB NOT NULL,
    "source_counts" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "birthday_catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "birthday_sync_states" (
    "id" VARCHAR(32) NOT NULL DEFAULT 'schaledb',
    "catalog_id" UUID,
    "last_checked_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "next_check_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" VARCHAR(64),
    "source_counts" JSONB NOT NULL DEFAULT '{}',
    "job_id" UUID,

    CONSTRAINT "birthday_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "birthday_reminder_occurrences" (
    "id" UUID NOT NULL,
    "namespace" VARCHAR(32) NOT NULL DEFAULT 'schaledb',
    "send_local_date" CHAR(10) NOT NULL,
    "target_local_date" CHAR(10) NOT NULL,
    "offset_days" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "valid_before" TIMESTAMPTZ(3) NOT NULL,
    "catalog_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "global_generation" INTEGER NOT NULL,
    "offset_generation" INTEGER NOT NULL,
    "event_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "birthday_reminder_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "birthday_channel_subscriptions" (
    "channel_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "audience_generation" INTEGER NOT NULL DEFAULT 1,
    "accept_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "birthday_channel_subscriptions_pkey" PRIMARY KEY ("channel_id")
);

-- CreateIndex
CREATE INDEX "birthday_identities_person_key_idx" ON "birthday_identities"("person_key");

-- CreateIndex
CREATE UNIQUE INDEX "birthday_catalogs_content_hash_key" ON "birthday_catalogs"("content_hash");

-- CreateIndex
CREATE INDEX "birthday_catalogs_created_at_idx" ON "birthday_catalogs"("created_at");

-- CreateIndex
CREATE INDEX "birthday_sync_states_next_check_at_idx" ON "birthday_sync_states"("next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "birthday_reminder_occurrences_event_id_key" ON "birthday_reminder_occurrences"("event_id");

-- CreateIndex
CREATE INDEX "birthday_reminder_occurrences_valid_before_idx" ON "birthday_reminder_occurrences"("valid_before");

-- CreateIndex
CREATE UNIQUE INDEX "birthday_occurrence_date_offset_key" ON "birthday_reminder_occurrences"("namespace", "send_local_date", "offset_days");

-- CreateIndex
CREATE INDEX "notification_event_resource_kind_idx" ON "notification_events"("resource_kind", "resource_id", "aggregate_version", "ordinal");

-- AddForeignKey
ALTER TABLE "birthday_sync_states" ADD CONSTRAINT "birthday_sync_states_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "birthday_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "birthday_reminder_occurrences" ADD CONSTRAINT "birthday_reminder_occurrences_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "birthday_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "birthday_channel_subscriptions" ADD CONSTRAINT "birthday_channel_subscriptions_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Existing test events retain their own resource namespace without changing payload hashes.
UPDATE notification_events SET resource_kind = 'notification_test' WHERE type = 'notification.test';

COMMIT;
