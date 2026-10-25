ALTER TYPE "WorkEventAction" ADD VALUE 'stage_credit_updated';

CREATE TABLE "work_credit_aliases" (
    "work_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credit_name" VARCHAR(100) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_credit_aliases_pkey" PRIMARY KEY ("work_id", "user_id")
);

CREATE INDEX "work_credit_aliases_user_id_idx" ON "work_credit_aliases"("user_id");

ALTER TABLE "work_credit_aliases" ADD CONSTRAINT "work_credit_aliases_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "work_credit_aliases" ADD CONSTRAINT "work_credit_aliases_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "work_credit_aliases" ("work_id", "user_id", "credit_name", "updated_at")
SELECT DISTINCT ON ("work_id", "user_id")
    "work_id", "user_id", "credit_name_override", "joined_at"
FROM "work_stage_participants"
WHERE "credit_name_override" IS NOT NULL
ORDER BY "work_id", "user_id", "joined_at" DESC;

ALTER TABLE "work_stage_participants" DROP COLUMN "credit_name_override";

ALTER TABLE "users" DROP COLUMN "default_credit_name";
