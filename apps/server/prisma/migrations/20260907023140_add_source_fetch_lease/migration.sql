-- AlterTable
ALTER TABLE "author_external_accounts" ADD COLUMN     "fetch_lease_id" UUID,
ADD COLUMN     "fetch_lease_until" TIMESTAMPTZ(3);
