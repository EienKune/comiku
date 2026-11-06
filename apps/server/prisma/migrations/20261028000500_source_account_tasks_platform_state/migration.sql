BEGIN;
CREATE TYPE "SourceAccountTaskStatus" AS ENUM ('queued','running','waiting','succeeded','failed');
CREATE TYPE "SourcePlatformStatus" AS ENUM ('unverified','healthy','auth_paused','cooling_down');
CREATE TABLE source_platform_states (
 platform VARCHAR(32) PRIMARY KEY,
 credential_generation VARCHAR(64) NOT NULL,
 status "SourcePlatformStatus" NOT NULL DEFAULT 'unverified',
 cooldown_until TIMESTAMPTZ(3), error_code VARCHAR(64), revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE source_fetch_account_tasks (
 id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES source_fetch_runs(id) ON DELETE CASCADE ON UPDATE CASCADE,
 account_id UUID NOT NULL REFERENCES author_external_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 platform VARCHAR(32) NOT NULL, job_id UUID,
 status "SourceAccountTaskStatus" NOT NULL DEFAULT 'queued', credential_generation VARCHAR(64),
 started_at TIMESTAMPTZ(3), completed_at TIMESTAMPTZ(3), deferred_until TIMESTAMPTZ(3), failure_code VARCHAR(64)
);
CREATE UNIQUE INDEX source_fetch_account_tasks_run_id_account_id_key ON source_fetch_account_tasks(run_id,account_id);
CREATE UNIQUE INDEX source_fetch_account_tasks_job_id_key ON source_fetch_account_tasks(job_id);
CREATE INDEX source_fetch_account_tasks_status_deferred_until_idx ON source_fetch_account_tasks(status,deferred_until);
CREATE INDEX source_fetch_account_tasks_account_id_status_idx ON source_fetch_account_tasks(account_id,status);
COMMIT;
