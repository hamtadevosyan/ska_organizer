#!/bin/sh
set -eu
# Only a newly created pilot volume runs this script. The old skao volume is
# separate. The application role owns its database but cannot administer roles.
app_password=$(cat /run/secrets/app_password)
case "$app_password" in ''|*[!0-9a-f]*) echo 'Invalid pilot application secret.' >&2; exit 1;; esac
if [ "${#app_password}" -ne 64 ]; then echo 'Invalid pilot application secret.' >&2; exit 1; fi
{
  printf "CREATE ROLE ska_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\n" "$app_password"
  printf 'ALTER DATABASE ska_organizer OWNER TO ska_app;\nALTER SCHEMA public OWNER TO ska_app;\n'
} | psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 >/dev/null
unset app_password
