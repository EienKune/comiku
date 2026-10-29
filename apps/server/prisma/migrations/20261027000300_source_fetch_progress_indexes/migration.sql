-- Bounded source-business progress reads by trigger and active status.
CREATE INDEX "source_fetch_runs_trigger_started_at_idx" ON "source_fetch_runs"("trigger", "started_at");
CREATE INDEX "source_fetch_runs_status_started_at_idx" ON "source_fetch_runs"("status", "started_at");
