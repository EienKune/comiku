-- Keep the original 15-action index and its persistent activation boundary.
-- A separate range prevents expanded historical rows from being filtered again
-- on every legacy poll. Each query applies its own persistent source_since.
CREATE INDEX "work_events_notification_expanded_idx" ON "work_events"("created_at", "id")
WHERE "notification_captured_at" IS NULL AND "action" IN (
  'metadata_updated', 'collaboration_mode_updated', 'stage_credit_updated',
  'stage_contribution_completed', 'translation_imported', 'typeset_version_uploaded',
  'typeset_version_selected', 'typeset_version_deleted', 'typeset_version_restored'
);
