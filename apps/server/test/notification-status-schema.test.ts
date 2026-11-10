import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("status observations have a forward migration and ordered receipt index", () => {
  const path = new URL(
    "../prisma/migrations/20261110000200_notification_bridge_status/migration.sql",
    import.meta.url,
  );
  assert.ok(existsSync(path), "forward status migration must exist");
  const migration = readFileSync(path, "utf8");
  for (const field of [
    "last_maintenance_at",
    "last_capture_at",
    "last_registration_at",
    "last_error_at",
    "last_error_code",
  ])
    assert.match(migration, new RegExp(field));
  assert.match(migration, /\("status", "created_at", "id"\)/);
  assert.doesNotMatch(migration, /UPDATE|DELETE|DROP|source_since/i);
});
