BEGIN;

CREATE INDEX "notification_event_type_id_idx"
  ON "notification_events" ("type", "id");

CREATE INDEX "notification_delivery_group_created_idx"
  ON "notification_deliveries" ("group_id", "created_at", "id");

-- Prisma does not model partial indexes. Keep active backlog and resolved
-- terminal history outside this small unresolved terminal index. Its readers
-- explicitly include this literal status predicate alongside the bound status.
CREATE INDEX "notification_delivery_terminal_unresolved_idx"
  ON "notification_deliveries" ("status", "created_at", "id")
  WHERE "resolved_at" IS NULL AND "status" IN ('failed', 'unknown');

COMMIT;
