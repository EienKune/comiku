-- AlterTable
ALTER TABLE "candidate_posts" ALTER COLUMN "author_external_account_id" DROP NOT NULL,
ALTER COLUMN "external_post_url" DROP NOT NULL;

-- Manual uploads have no remote media URL.
ALTER TABLE "candidate_media" ALTER COLUMN "source_url" DROP NOT NULL;

-- AlterTable
ALTER TABLE "works" ALTER COLUMN "source_post_url" DROP NOT NULL;
