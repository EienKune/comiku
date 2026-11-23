CREATE TABLE "proofread_page_leases" (
  "work_image_id" UUID PRIMARY KEY REFERENCES "work_images"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "work_id" UUID NOT NULL REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "session_id" UUID NOT NULL, "editor_instance_id" UUID NOT NULL, "lease_token" UUID NOT NULL,
  "editor_epoch" INTEGER NOT NULL, "expires_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "proofread_page_leases_work_id_editor_epoch_expires_at_idx"
ON "proofread_page_leases" ("work_id","editor_epoch","expires_at");
