ALTER TABLE "notification_work_event_activation"
  ADD COLUMN "last_maintenance_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_capture_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_registration_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_error_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_error_code" VARCHAR(64);

CREATE INDEX "notification_work_receipt_status_created_idx"
  ON "notification_work_event_receipts" ("status", "created_at", "id");
