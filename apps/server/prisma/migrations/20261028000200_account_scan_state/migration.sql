BEGIN;

CREATE TABLE "source_account_scan_states" (
  "account_id" UUID NOT NULL,
  "discovered_through_at" TIMESTAMPTZ(3),
  "window_json" JSONB NOT NULL DEFAULT '{}',
  "lease_owner_job_id" UUID,
  "lease_until" TIMESTAMPTZ(3),
  "epoch" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "source_account_scan_states_pkey" PRIMARY KEY ("account_id"),
  CONSTRAINT "source_account_scan_states_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "author_external_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "source_account_scan_states_lease_until_idx" ON "source_account_scan_states"("lease_until");

-- Only the account's gallery implementation may certify inherited coverage.
-- Preserve a bound unfinished window even when no successful coverage exists.
INSERT INTO "source_account_scan_states" ("account_id", "discovered_through_at", "window_json")
SELECT account."id",
  CASE WHEN state."completed_through_at" <= state."last_success_at"
    AND EXISTS (SELECT 1 FROM "source_fetch_run_items" item
      WHERE item."adapter_state_id" = state."id"
        AND item."external_account_id" = account."id"
        AND item."adapter_key" = state."adapter_key"
        AND item."status" = 'succeeded'
        AND item."started_at" <= state."last_success_at")
    THEN state."completed_through_at" END,
  CASE WHEN state."cursor_json"->'_sourceScanWindow'->>'sourceId' = account."external_user_id"
    AND state."cursor_json"->'_sourceScanWindow'->>'adapterKey' = state."adapter_key"
    AND state."cursor_json"->'_sourceScanWindow'->>'firstSyncMode' = account."first_sync_mode"::text
    AND state."cursor_json"->'_sourceScanWindow'->>'endTime' = state."cursor_json"->>'endTime'
    AND jsonb_typeof(state."cursor_json"->'_sourceScanWindow'->'endTime') = 'string'
    AND jsonb_typeof(state."cursor_json"->'_sourceScanWindow'->'startTime') IN ('string', 'null')
    AND (state."cursor_json"->'_sourceScanWindow'->'startTime') IS NOT NULL
    AND COALESCE(state."cursor_json"->'_sourceScanWindow'->>'startTime', '') = COALESCE(state."cursor_json"->>'startTime', '')
    THEN ((state."cursor_json"->'_sourceScanWindow') - 'adapterKey'::text) || '{"version":1}'::jsonb
    ELSE '{}'::jsonb END
FROM "author_external_accounts" account
LEFT JOIN "source_adapter_states" state ON state."external_account_id" = account."id"
  AND state."adapter_key" = account."platform" || '_gallery_dl';

COMMIT;
