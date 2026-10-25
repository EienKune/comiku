CREATE TYPE "SourceAdapterHealth" AS ENUM (
  'idle',
  'healthy',
  'degraded',
  'cooling_down',
  'unavailable',
  'disabled'
);

CREATE TYPE "CandidateVisualClass" AS ENUM ('manga', 'photo');

CREATE TYPE "CandidateTagGroupKind" AS ENUM ('valid', 'gray', 'blocked');

CREATE TABLE "source_adapter_states" (
  "id" UUID NOT NULL,
  "external_account_id" UUID NOT NULL,
  "adapter_key" VARCHAR(64) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "health" "SourceAdapterHealth" NOT NULL DEFAULT 'idle',
  "cursor_json" JSONB NOT NULL DEFAULT '{}',
  "high_water_published_at" TIMESTAMPTZ(3),
  "high_water_external_id" VARCHAR(255),
  "last_attempt_at" TIMESTAMPTZ(3),
  "last_success_at" TIMESTAMPTZ(3),
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(3),
  "last_error_code" VARCHAR(64),
  "last_error_message" VARCHAR(500),
  "fetch_lease_id" UUID,
  "fetch_lease_until" TIMESTAMPTZ(3),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "source_adapter_states_pkey" PRIMARY KEY ("id")
);

INSERT INTO "source_adapter_states" (
  "id",
  "external_account_id",
  "adapter_key",
  "cursor_json",
  "health",
  "last_attempt_at",
  "last_success_at",
  "fetch_lease_id",
  "fetch_lease_until",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  "id",
  CASE WHEN "platform" = 'x' THEN 'x_official_v2' ELSE "platform" || '_default' END,
  "cursor_json",
  CASE WHEN "last_checked_at" IS NULL THEN 'idle'::"SourceAdapterHealth" ELSE 'healthy'::"SourceAdapterHealth" END,
  "last_checked_at",
  "last_checked_at",
  "fetch_lease_id",
  "fetch_lease_until",
  CURRENT_TIMESTAMP
FROM "author_external_accounts";

CREATE UNIQUE INDEX "source_adapter_states_external_account_id_adapter_key_key"
  ON "source_adapter_states"("external_account_id", "adapter_key");
CREATE INDEX "source_adapter_states_adapter_key_enabled_health_next_attem_idx"
  ON "source_adapter_states"("adapter_key", "enabled", "health", "next_attempt_at");
CREATE INDEX "source_adapter_states_fetch_lease_until_idx"
  ON "source_adapter_states"("fetch_lease_until");

ALTER TABLE "source_adapter_states"
  ADD CONSTRAINT "source_adapter_states_external_account_id_fkey"
  FOREIGN KEY ("external_account_id") REFERENCES "author_external_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "source_fetch_run_items"
  ADD COLUMN "adapter_state_id" UUID,
  ADD COLUMN "adapter_key" VARCHAR(64),
  ADD COLUMN "api_requests" INTEGER NOT NULL DEFAULT 0;

UPDATE "source_fetch_run_items" AS item
SET
  "adapter_state_id" = state."id",
  "adapter_key" = state."adapter_key"
FROM "source_adapter_states" AS state
WHERE state."external_account_id" = item."external_account_id";

ALTER TABLE "source_fetch_run_items"
  ALTER COLUMN "adapter_state_id" SET NOT NULL,
  ALTER COLUMN "adapter_key" SET NOT NULL;

DROP INDEX "source_fetch_run_items_run_id_external_account_id_key";
CREATE UNIQUE INDEX "source_fetch_run_items_run_id_external_account_id_adapter_k_key"
  ON "source_fetch_run_items"("run_id", "external_account_id", "adapter_key");
CREATE INDEX "source_fetch_run_items_adapter_state_id_started_at_idx"
  ON "source_fetch_run_items"("adapter_state_id", "started_at");

ALTER TABLE "source_fetch_run_items"
  ADD CONSTRAINT "source_fetch_run_items_adapter_state_id_fkey"
  FOREIGN KEY ("adapter_state_id") REFERENCES "source_adapter_states"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "source_adapter_budget_usage" (
  "adapter_key" VARCHAR(64) NOT NULL,
  "period_key" VARCHAR(16) NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "source_adapter_budget_usage_pkey" PRIMARY KEY ("adapter_key", "period_key")
);

ALTER TABLE "candidate_posts"
  ADD COLUMN "has_valid_tag" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "candidate_posts_status_has_valid_tag_posted_at_id_idx"
  ON "candidate_posts"("status", "has_valid_tag", "posted_at", "id");

CREATE TABLE "candidate_source_observations" (
  "id" UUID NOT NULL,
  "candidate_post_id" UUID NOT NULL,
  "external_account_id" UUID,
  "adapter_state_id" UUID,
  "adapter_key" VARCHAR(64) NOT NULL,
  "raw_json" JSONB NOT NULL,
  "observation_count" INTEGER NOT NULL DEFAULT 1,
  "first_observed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_observed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_source_observations_pkey" PRIMARY KEY ("id")
);

INSERT INTO "candidate_source_observations" (
  "id",
  "candidate_post_id",
  "external_account_id",
  "adapter_state_id",
  "adapter_key",
  "raw_json",
  "first_observed_at",
  "last_observed_at"
)
SELECT
  gen_random_uuid(),
  candidate."id",
  candidate."author_external_account_id",
  state."id",
  CASE
    WHEN candidate."platform" = 'manual' THEN 'manual'
    WHEN candidate."platform" = 'x' THEN 'x_official_v2'
    ELSE candidate."platform" || '_default'
  END,
  candidate."raw_json",
  candidate."fetched_at",
  candidate."fetched_at"
FROM "candidate_posts" AS candidate
LEFT JOIN "source_adapter_states" AS state
  ON state."external_account_id" = candidate."author_external_account_id";

CREATE UNIQUE INDEX "candidate_source_observations_candidate_post_id_adapter_key_key"
  ON "candidate_source_observations"("candidate_post_id", "adapter_key");
CREATE INDEX "candidate_source_observations_external_account_id_last_obse_idx"
  ON "candidate_source_observations"("external_account_id", "last_observed_at");
CREATE INDEX "candidate_source_observations_adapter_state_id_last_observe_idx"
  ON "candidate_source_observations"("adapter_state_id", "last_observed_at");

ALTER TABLE "candidate_source_observations"
  ADD CONSTRAINT "candidate_source_observations_candidate_post_id_fkey"
  FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_source_observations"
  ADD CONSTRAINT "candidate_source_observations_external_account_id_fkey"
  FOREIGN KEY ("external_account_id") REFERENCES "author_external_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "candidate_source_observations"
  ADD CONSTRAINT "candidate_source_observations_adapter_state_id_fkey"
  FOREIGN KEY ("adapter_state_id") REFERENCES "source_adapter_states"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "candidate_hashtags" (
  "candidate_post_id" UUID NOT NULL,
  "normalized_value" VARCHAR(100) NOT NULL,
  "display_value" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_hashtags_pkey" PRIMARY KEY ("candidate_post_id", "normalized_value")
);

CREATE INDEX "candidate_hashtags_normalized_value_candidate_post_id_idx"
  ON "candidate_hashtags"("normalized_value", "candidate_post_id");
ALTER TABLE "candidate_hashtags"
  ADD CONSTRAINT "candidate_hashtags_candidate_post_id_fkey"
  FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "candidate_tag_groups" (
  "id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "kind" "CandidateTagGroupKind" NOT NULL DEFAULT 'valid',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "candidate_tag_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "candidate_tag_groups_name_key" ON "candidate_tag_groups"("name");
CREATE INDEX "candidate_tag_groups_kind_enabled_idx" ON "candidate_tag_groups"("kind", "enabled");

CREATE TABLE "candidate_tag_aliases" (
  "id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "display_value" VARCHAR(100) NOT NULL,
  "normalized_value" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_tag_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "candidate_tag_aliases_normalized_value_key"
  ON "candidate_tag_aliases"("normalized_value");
CREATE INDEX "candidate_tag_aliases_group_id_idx" ON "candidate_tag_aliases"("group_id");
ALTER TABLE "candidate_tag_aliases"
  ADD CONSTRAINT "candidate_tag_aliases_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "candidate_tag_groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "candidate_classification_suggestions" (
  "id" UUID NOT NULL,
  "candidate_post_id" UUID NOT NULL,
  "label" "CandidateVisualClass" NOT NULL,
  "classifier_name" VARCHAR(100) NOT NULL,
  "classifier_version" VARCHAR(100) NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_classification_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "candidate_classification_suggestions_candidate_post_id_crea_idx"
  ON "candidate_classification_suggestions"("candidate_post_id", "created_at");
ALTER TABLE "candidate_classification_suggestions"
  ADD CONSTRAINT "candidate_classification_suggestions_candidate_post_id_fkey"
  FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "candidate_classification_decisions" (
  "candidate_post_id" UUID NOT NULL,
  "label" "CandidateVisualClass" NOT NULL,
  "decided_by" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "candidate_classification_decisions_pkey" PRIMARY KEY ("candidate_post_id")
);

CREATE INDEX "candidate_classification_decisions_label_updated_at_idx"
  ON "candidate_classification_decisions"("label", "updated_at");
ALTER TABLE "candidate_classification_decisions"
  ADD CONSTRAINT "candidate_classification_decisions_candidate_post_id_fkey"
  FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_classification_decisions"
  ADD CONSTRAINT "candidate_classification_decisions_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "author_external_accounts"
  DROP COLUMN "cursor_json",
  DROP COLUMN "last_checked_at",
  DROP COLUMN "fetch_lease_id",
  DROP COLUMN "fetch_lease_until";
