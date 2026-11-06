BEGIN;
CREATE TABLE "image_analysis_activations" (
  "id" VARCHAR(20) NOT NULL DEFAULT 'global',
  "active_model_key" VARCHAR(64),
  "generation" INTEGER NOT NULL DEFAULT 1,
  "activated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "historical_paused" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "image_analysis_activations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "image_analysis_activation_singleton" CHECK ("id" = 'global'),
  CONSTRAINT "image_analysis_activation_generation" CHECK ("generation" > 0)
);
CREATE TABLE "image_analysis_work_intents" (
  "media_id" UUID NOT NULL,
  "model_key" VARCHAR(64) NOT NULL,
  "purpose" VARCHAR(20) NOT NULL,
  "activation_generation" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "image_analysis_work_intents_pkey" PRIMARY KEY ("media_id", "model_key"),
  CONSTRAINT "image_analysis_work_intents_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "candidate_media"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "image_analysis_intent_purpose" CHECK ("purpose" IN ('incremental', 'historical'))
);
CREATE INDEX "image_analysis_work_intents_model_key_purpose_created_at_idx" ON "image_analysis_work_intents"("model_key", "purpose", "created_at");
CREATE INDEX "candidate_media_created_at_id_idx" ON "candidate_media"("created_at", "id");
COMMIT;
