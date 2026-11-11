ALTER TABLE "users" ADD COLUMN "qq_number" VARCHAR(20);

ALTER TABLE "users" ADD CONSTRAINT "users_qq_number_format"
  CHECK ("qq_number" IS NULL OR "qq_number" ~ '^[1-9][0-9]{4,19}$');

CREATE UNIQUE INDEX "users_qq_number_key" ON "users"("qq_number");
