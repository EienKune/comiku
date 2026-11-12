BEGIN;

-- Earlier standalone reminder releases did not have the optional resource_kind column.
-- Its later default must not reclassify already persisted reminder events as works.
UPDATE notification_events
SET resource_kind = CASE type
  WHEN 'work.digest' THEN 'work_digest'
  WHEN 'work.ready' THEN 'work_ready'
END
WHERE resource_kind = 'work'
  AND type IN ('work.digest', 'work.ready');

COMMIT;
