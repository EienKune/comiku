ALTER TABLE "candidate_posts" ADD COLUMN "analysis_score" DOUBLE PRECISION,
ADD COLUMN "analysis_state" VARCHAR(20) NOT NULL DEFAULT 'unprocessed';
CREATE TABLE "candidate_media_analyses" (
  "id" UUID NOT NULL,
  "media_id" UUID NOT NULL,
  "model_key" VARCHAR(64) NOT NULL,
  "model_revision" TEXT NOT NULL,
  "decision_version" TEXT NOT NULL,
  "source_sha256" VARCHAR(64) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "score" DOUBLE PRECISION,
  "result_json" JSONB,
  "last_error" VARCHAR(100),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "candidate_media_analyses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_media_analyses_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "candidate_media"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "candidate_media_analyses_media_id_model_key_key" ON "candidate_media_analyses"("media_id", "model_key");
CREATE INDEX "candidate_media_analyses_model_key_status_idx" ON "candidate_media_analyses"("model_key", "status");
