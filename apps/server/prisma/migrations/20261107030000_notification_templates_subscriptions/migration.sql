ALTER TABLE "notification_channels"
ADD COLUMN "receiver_mode" VARCHAR(16) NOT NULL DEFAULT 'legacy',
ADD COLUMN "subscription_rules" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "notification_templates" (
  "event_type" VARCHAR(64) NOT NULL,
  "title_enabled" BOOLEAN NOT NULL DEFAULT false,
  "author_enabled" BOOLEAN NOT NULL DEFAULT false,
  "actor_enabled" BOOLEAN NOT NULL DEFAULT false,
  "note" VARCHAR(480) NOT NULL DEFAULT '',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "content_revision" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("event_type")
);
