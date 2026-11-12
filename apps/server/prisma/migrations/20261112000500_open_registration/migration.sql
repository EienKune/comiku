CREATE TABLE "account_registration_settings" (
  "id" VARCHAR(20) NOT NULL DEFAULT 'global',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "allow_role_selection" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "account_registration_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_registration_settings_singleton" CHECK ("id" = 'global'),
  CONSTRAINT "account_registration_settings_revision_check" CHECK ("revision" >= 0)
);
