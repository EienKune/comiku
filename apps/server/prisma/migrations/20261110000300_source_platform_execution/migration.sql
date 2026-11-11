ALTER TABLE "source_platform_states"
  ADD COLUMN "maintenance_paused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "maintenance_epoch" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "source_platform_executions" (
  "id" UUID NOT NULL,
  "platform" VARCHAR(32) NOT NULL,
  "kind" VARCHAR(24) NOT NULL,
  "owner_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "lease_id" UUID NOT NULL,
  "task_id" UUID,
  "campaign_id" UUID,
  "credential_generation" VARCHAR(64) NOT NULL,
  "budget_attempt" INTEGER NOT NULL,
  "budget_refunded" BOOLEAN NOT NULL DEFAULT false,
  "admitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_outcome" VARCHAR(24),
  "business_finished_at" TIMESTAMPTZ(3),
  "settled_at" TIMESTAMPTZ(3),
  "diagnostic_json" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "source_platform_executions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "source_platform_executions_job_id_lease_id_key" ON "source_platform_executions"("job_id", "lease_id");
CREATE INDEX "source_execution_task_idx" ON "source_platform_executions"("task_id", "admitted_at", "id");
CREATE INDEX "source_execution_campaign_idx" ON "source_platform_executions"("campaign_id", "admitted_at", "id");
CREATE INDEX "source_execution_unsettled_idx" ON "source_platform_executions"("platform", "settled_at", "id");
CREATE INDEX "source_execution_retention_idx" ON "source_platform_executions"("settled_at", "id");

CREATE TABLE "source_credential_change_operations" (
  "id" UUID NOT NULL,
  "platform" VARCHAR(20) NOT NULL,
  "actor_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "expected_epoch" INTEGER NOT NULL,
  "expected_generation" VARCHAR(64) NOT NULL,
  "target_generation" VARCHAR(64),
  "phase" VARCHAR(24) NOT NULL,
  "failure_code" VARCHAR(64),
  "verification_outcome" VARCHAR(20),
  "verification_code" VARCHAR(64),
  "verified_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT "source_credential_change_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "source_credential_change_operations_actor_id_request_id_key" ON "source_credential_change_operations"("actor_id", "request_id");
CREATE INDEX "source_credential_operation_platform_idx" ON "source_credential_change_operations"("platform", "created_at", "id");
