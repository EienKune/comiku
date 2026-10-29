ALTER TABLE "source_adapter_states"
  ADD COLUMN "completed_through_at" TIMESTAMPTZ(3),
  ADD COLUMN "discovery_checkpoint_json" JSONB NOT NULL DEFAULT '{}';

-- An item began before the latest successful completion, so its start is a
-- conservative coverage bound. Publication timestamps do not prove coverage.
UPDATE "source_adapter_states" AS state
SET "completed_through_at" = (
  SELECT MAX(item."started_at")
  FROM "source_fetch_run_items" AS item
  WHERE item."adapter_state_id" = state."id"
    AND item."external_account_id" = state."external_account_id"
    AND item."adapter_key" = state."adapter_key"
    AND item."status" = 'succeeded'
    AND item."started_at" <= state."last_success_at"
)
WHERE state."last_success_at" IS NOT NULL;
