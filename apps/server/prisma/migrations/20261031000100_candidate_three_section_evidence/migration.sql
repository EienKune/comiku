BEGIN;
ALTER TABLE candidate_review_sessions ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN rules_version VARCHAR(64), ADD COLUMN review_policy_key VARCHAR(64);
ALTER TABLE candidate_review_sessions ALTER COLUMN policy_version SET DEFAULT 2;
ALTER TABLE candidate_review_session_entries ADD COLUMN reason_json JSONB;
COMMIT;
