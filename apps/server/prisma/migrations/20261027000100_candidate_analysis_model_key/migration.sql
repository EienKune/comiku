-- This is cache provenance, not the globally selected model. Existing summaries
-- remain untrusted until rebuilt from their actual per-media results by the worker.
ALTER TABLE "candidate_posts" ADD COLUMN "analysis_model_key" VARCHAR(64);
