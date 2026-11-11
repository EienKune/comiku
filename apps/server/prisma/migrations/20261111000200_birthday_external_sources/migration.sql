CREATE TABLE "birthday_external_entries" (
    "source" VARCHAR(32) NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "person_key" VARCHAR(128),
    "status" VARCHAR(16) NOT NULL DEFAULT 'confirmed',
    "blocked_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "game_entry_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "profile" JSONB,
    "profile_hash" CHAR(64),
    "listed_at" TIMESTAMPTZ(3) NOT NULL,
    "last_checked_at" TIMESTAMPTZ(3),
    "next_check_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" VARCHAR(64),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "birthday_external_entries_pkey" PRIMARY KEY ("source", "entry_id"),
    CONSTRAINT "birthday_external_entry_positive" CHECK ("entry_id" > 0),
    CONSTRAINT "birthday_external_status_valid" CHECK ("status" IN ('confirmed', 'pending'))
);
CREATE INDEX "birthday_external_due_idx" ON "birthday_external_entries"("source", "next_check_at", "entry_id");
CREATE INDEX "birthday_external_person_idx" ON "birthday_external_entries"("person_key");
