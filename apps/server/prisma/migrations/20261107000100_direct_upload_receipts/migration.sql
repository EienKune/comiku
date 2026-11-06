BEGIN;
ALTER TABLE "direct_upload_sessions" ADD COLUMN "terminal_at" TIMESTAMPTZ(3), ADD COLUMN "staging_cleaned_at" TIMESTAMPTZ(3);
UPDATE "direct_upload_sessions" SET "terminal_at" = CURRENT_TIMESTAMP WHERE "status" IN ('completed', 'failed', 'expired');
CREATE INDEX "direct_upload_terminal_idx" ON "direct_upload_sessions" ("terminal_at", "id");
CREATE INDEX "direct_upload_cleanup_idx" ON "direct_upload_sessions" ("staging_cleaned_at", "terminal_at", "id");
CREATE INDEX "direct_upload_pending_idx" ON "direct_upload_sessions" ("terminal_at", "expires_at", "id");
COMMIT;
