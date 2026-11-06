-- Preserve each account's previous pause intent before removing the secondary
-- business control. Runtime cursors, retries, cooldowns and leases are untouched.
UPDATE author_external_accounts AS a
SET fetch_enabled = false, revision = a.revision + 1
WHERE a.deleted_at IS NULL AND a.fetch_enabled
  AND EXISTS (SELECT 1 FROM authors WHERE id = a.author_id AND deleted_at IS NULL)
  AND EXISTS (
    SELECT 1 FROM source_adapter_states AS s
    WHERE s.external_account_id = a.id AND NOT s.enabled
      AND ((a.platform = 'x' AND s.adapter_key = 'x_gallery_dl')
        OR (a.platform = 'pixiv' AND s.adapter_key = 'pixiv_gallery_dl'))
  );

UPDATE source_adapter_states AS s
SET enabled = true, revision = s.revision + 1
FROM author_external_accounts AS a, authors AS author
WHERE s.external_account_id = a.id AND a.author_id = author.id
  AND a.deleted_at IS NULL AND author.deleted_at IS NULL AND NOT s.enabled
  AND ((a.platform = 'x' AND s.adapter_key = 'x_gallery_dl')
    OR (a.platform = 'pixiv' AND s.adapter_key = 'pixiv_gallery_dl'));
