-- CreateEnum
CREATE TYPE "CandidateActionType" AS ENUM ('import', 'discard', 'restore');

-- CreateTable
CREATE TABLE "candidate_action_logs" (
    "id" UUID NOT NULL,
    "candidate_post_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" "CandidateActionType" NOT NULL,
    "from_status" "CandidateStatus" NOT NULL,
    "to_status" "CandidateStatus" NOT NULL,
    "work_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "candidate_action_logs_candidate_post_id_created_at_idx" ON "candidate_action_logs"("candidate_post_id", "created_at");

-- CreateIndex
CREATE INDEX "candidate_action_logs_actor_id_created_at_idx" ON "candidate_action_logs"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "candidate_action_logs" ADD CONSTRAINT "candidate_action_logs_candidate_post_id_fkey" FOREIGN KEY ("candidate_post_id") REFERENCES "candidate_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_action_logs" ADD CONSTRAINT "candidate_action_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_action_logs" ADD CONSTRAINT "candidate_action_logs_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
