BEGIN;
CREATE TABLE "candidate_review_sessions" (
  "id" UUID NOT NULL, "actor_id" UUID NOT NULL, "idempotency_key" UUID NOT NULL, "cursor_secret" UUID NOT NULL,
  "normalized_filter_json" JSONB NOT NULL, "filter_hash" VARCHAR(64) NOT NULL, "model_key" VARCHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL, "hard_expires_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "candidate_review_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_review_sessions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "candidate_review_sessions_actor_id_idempotency_key_key" ON "candidate_review_sessions"("actor_id", "idempotency_key");
CREATE INDEX "candidate_review_sessions_actor_id_expires_at_last_used_at_idx" ON "candidate_review_sessions"("actor_id", "expires_at", "last_used_at");
CREATE INDEX "candidate_review_sessions_expires_at_id_idx" ON "candidate_review_sessions"("expires_at", "id");
CREATE TABLE "candidate_review_session_entries" (
  "session_id" UUID NOT NULL, "candidate_id" UUID NOT NULL, "ordinal" INTEGER NOT NULL,
  "triage_group" VARCHAR(32) NOT NULL, "frozen_score" DOUBLE PRECISION,
  CONSTRAINT "candidate_review_session_entries_pkey" PRIMARY KEY ("session_id", "candidate_id"),
  CONSTRAINT "candidate_review_session_entries_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "candidate_review_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "candidate_review_session_entries_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "candidate_review_session_entries_session_id_ordinal_key" ON "candidate_review_session_entries"("session_id", "ordinal");
CREATE INDEX "candidate_review_entries_group_order_idx" ON "candidate_review_session_entries"("session_id", "triage_group", "ordinal");
CREATE INDEX "candidate_review_session_entries_candidate_id_idx" ON "candidate_review_session_entries"("candidate_id");
COMMIT;
