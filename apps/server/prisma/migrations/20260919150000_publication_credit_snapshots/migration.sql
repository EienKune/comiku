ALTER TABLE "publish_records"
  ADD COLUMN "translation_credits_snapshot" JSONB,
  ADD COLUMN "proofread_credits_snapshot" JSONB,
  ADD COLUMN "typeset_credits_snapshot" JSONB;
