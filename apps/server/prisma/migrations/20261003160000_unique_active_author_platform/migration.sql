-- Keep the earliest active identity per author/platform. Archive duplicates rather
-- than deleting referenced source identities, candidates, observations or runs.
WITH ranked AS (
  SELECT id,
    row_number() OVER (PARTITION BY author_id, platform ORDER BY created_at, id) AS position,
    first_value(id) OVER (PARTITION BY author_id, platform ORDER BY created_at, id) AS retained_id
  FROM author_external_accounts WHERE deleted_at IS NULL
)
UPDATE author_external_accounts AS account
SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
    fetch_enabled = false, revision = account.revision + 1,
    metadata_json = account.metadata_json || jsonb_build_object('uniquenessCleanup',
      jsonb_build_object('reason', 'one_active_account_per_author_platform',
        'retainedAccountId', ranked.retained_id, 'at', CURRENT_TIMESTAMP))
FROM ranked WHERE account.id = ranked.id AND ranked.position > 1;

UPDATE source_adapter_states AS state
SET enabled = false, health = 'disabled', fetch_lease_id = NULL,
    fetch_lease_until = NULL, revision = state.revision + 1, updated_at = CURRENT_TIMESTAMP
FROM author_external_accounts AS account
WHERE state.external_account_id = account.id AND account.deleted_at IS NOT NULL
  AND account.metadata_json ? 'uniquenessCleanup';

-- Partial uniqueness permits recoverable history while preventing concurrent
-- binding/restoration from creating another active identity for this platform.
CREATE UNIQUE INDEX author_external_accounts_active_author_platform_key
  ON author_external_accounts (author_id, platform) WHERE deleted_at IS NULL;
