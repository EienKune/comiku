BEGIN;

ALTER TABLE "authors" ADD COLUMN "notes" TEXT;
ALTER TABLE "author_external_accounts" ADD COLUMN "notes" TEXT;

COMMIT;
