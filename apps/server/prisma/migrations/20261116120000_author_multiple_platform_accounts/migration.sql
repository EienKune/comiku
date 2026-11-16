-- An author may own multiple identities on the same platform.
-- Keep the global (platform, external_user_id) identity constraint and all history.
DROP INDEX author_external_accounts_active_author_platform_key;
