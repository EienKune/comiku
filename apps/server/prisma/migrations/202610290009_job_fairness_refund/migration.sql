BEGIN;
ALTER TABLE job_queue_states
  ADD COLUMN advance_lease_id UUID,
  ADD COLUMN prior_last_queue VARCHAR(64),
  ADD COLUMN prior_consecutive INTEGER;
COMMIT;
