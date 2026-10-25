#!/bin/sh
set -eu
# Fresh volume only. Secrets go to SQL stdin, never command arguments or logs.
app_password=$(cat /run/secrets/postgres_password)
backup_password=$(cat /run/secrets/postgres_backup_password)
case "$app_password" in *[!A-Za-z0-9_-]*) echo 'Invalid database secret format.' >&2; exit 1 ;; esac
case "$backup_password" in *[!A-Za-z0-9_-]*) echo 'Invalid database secret format.' >&2; exit 1 ;; esac
case "$POSTGRES_DB" in ''|*[!A-Za-z0-9_]*) echo 'Invalid database name.' >&2; exit 1 ;; esac
[ "${#app_password}" -ge 32 ] && [ "${#backup_password}" -ge 32 ]
[ "${#app_password}" -le 128 ] && [ "${#backup_password}" -le 128 ]
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<SQL
CREATE ROLE comiku LOGIN PASSWORD '$app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER DATABASE "$POSTGRES_DB" OWNER TO comiku;
GRANT ALL ON SCHEMA public TO comiku;
CREATE ROLE comiku_backup LOGIN PASSWORD '$backup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO comiku_backup;
GRANT pg_read_all_data TO comiku_backup;
SQL
