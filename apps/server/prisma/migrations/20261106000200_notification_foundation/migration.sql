BEGIN;
-- CreateTable
CREATE TABLE "notification_events" (
    "id" UUID NOT NULL,
    "event_key" VARCHAR(255) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "resource_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "route_refs" JSONB NOT NULL,
    "routed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "connection_key" VARCHAR(64) NOT NULL,
    "connection_fingerprint" CHAR(64) NOT NULL,
    "group_id" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "event_types" TEXT[],
    "include_details" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "audience_generation" INTEGER NOT NULL DEFAULT 1,
    "next_send_at" TIMESTAMPTZ(3),
    "rate_window_at" TIMESTAMPTZ(3),
    "rate_window_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "audience_generation" INTEGER NOT NULL,
    "replay_generation" INTEGER NOT NULL DEFAULT 0,
    "source_delivery_id" UUID,
    "request_key" VARCHAR(255),
    "requested_by" UUID,
    "resolution_key" VARCHAR(255),
    "connection_key" VARCHAR(64) NOT NULL,
    "connection_fingerprint" CHAR(64) NOT NULL,
    "group_id" VARCHAR(64) NOT NULL,
    "channel_revision" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "provider_message_id" VARCHAR(128),
    "next_attempt_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_attempts" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "job_id" UUID NOT NULL,
    "lease_id" UUID NOT NULL,
    "send_boundary_crossed" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(24) NOT NULL DEFAULT 'sending',
    "error_code" VARCHAR(64),
    "provider_message_id" VARCHAR(128),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_events_event_key_key" ON "notification_events"("event_key");

-- CreateIndex
CREATE INDEX "notification_events_routed_at_created_at_idx" ON "notification_events"("routed_at", "created_at");

-- CreateIndex
CREATE INDEX "notification_events_resource_id_aggregate_version_ordinal_idx" ON "notification_events"("resource_id", "aggregate_version", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channels_group_id_key" ON "notification_channels"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_request_key_key" ON "notification_deliveries"("request_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_resolution_key_key" ON "notification_deliveries"("resolution_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_job_id_key" ON "notification_deliveries"("job_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_created_at_idx" ON "notification_deliveries"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_channel_id_status_resolved_at_idx" ON "notification_deliveries"("channel_id", "status", "resolved_at");

CREATE INDEX "notification_deliveries_created_at_id_idx" ON "notification_deliveries"("created_at", "id");

CREATE INDEX "notification_deliveries_status_created_at_id_idx" ON "notification_deliveries"("status", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_event_id_channel_id_audience_genera_key" ON "notification_deliveries"("event_id", "channel_id", "audience_generation", "replay_generation");

-- CreateIndex
CREATE INDEX "notification_attempts_job_id_status_idx" ON "notification_attempts"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_attempts_delivery_id_number_key" ON "notification_attempts"("delivery_id", "number");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "notification_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "notification_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
