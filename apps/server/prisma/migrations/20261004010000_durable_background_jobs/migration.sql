-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "JobLane" AS ENUM ('network', 'heavy');

-- AlterEnum
ALTER TYPE "SourceFetchRunStatus" ADD VALUE 'queued';

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "resource_id" UUID NOT NULL,
    "actor_id" UUID,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "lane" "JobLane" NOT NULL DEFAULT 'heavy',
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 10,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_id" UUID,
    "lease_until" TIMESTAMPTZ(3),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_schedules" (
    "name" VARCHAR(64) NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_schedules_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_idempotency_key_key" ON "background_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "background_jobs_lane_status_available_at_priority_idx" ON "background_jobs"("lane", "status", "available_at", "priority");
