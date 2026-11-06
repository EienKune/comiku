BEGIN;
ALTER TYPE "JobLane" ADD VALUE IF NOT EXISTS 'analysis';
ALTER TABLE "background_jobs"
  ADD COLUMN "execution_scope" VARCHAR(128) NOT NULL DEFAULT 'global',
  ADD COLUMN "queue_name" VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE TABLE "job_queue_states" (
  "lane" "JobLane" NOT NULL,
  "scope" VARCHAR(128) NOT NULL,
  "last_queue" VARCHAR(64) NOT NULL,
  "consecutive" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "job_queue_states_pkey" PRIMARY KEY ("lane", "scope")
);
DROP INDEX "background_jobs_lane_status_available_at_priority_idx";
CREATE INDEX "background_jobs_scope_queue_claim_idx"
 ON "background_jobs"("lane", "execution_scope", "status", "available_at", "queue_name", "priority");
COMMIT;
