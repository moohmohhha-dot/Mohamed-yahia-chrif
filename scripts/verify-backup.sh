#!/usr/bin/env bash
# Proves a backup can be restored (run it every week): restores the latest backup into a throw-away
# database, checks it, then drops it. A backup that was never restored is not a backup.
#
#   ADMIN_DATABASE_URL=postgres://user:pass@host:5432/postgres  BACKUP_DIR=/srv/backups \
#   BACKUP_AGE_IDENTITY=/secure/aruma-backup.key  scripts/verify-backup.sh
set -euo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL (a role that can create databases) is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY is required}"
latest="$(ls -1t "$BACKUP_DIR"/aruma-core-*.dump.age | head -n 1)"
db="aruma_restore_check_$(date -u +%s)"
base="${ADMIN_DATABASE_URL%/*}"
psql -q "$ADMIN_DATABASE_URL" -c "create database $db"
trap 'psql -q "$ADMIN_DATABASE_URL" -c "drop database if exists $db" >/dev/null' EXIT

TARGET_DATABASE_URL="$base/$db" BACKUP_AGE_IDENTITY="$BACKUP_AGE_IDENTITY" "$(dirname "$0")/restore.sh" "$latest"

q() { psql -tA "$base/$db" -c "$1"; }
tables="$(q "select count(*) from information_schema.tables where table_schema = 'public'")"
migrations="$(q "select count(*) from drizzle.__drizzle_migrations")"
users="$(q "select count(*) from users")"
unbalanced="$(q "select count(*) from (select e.currency from journal_lines l join journal_entries e on e.id = l.entry_id group by e.currency having sum(l.debit_minor) <> sum(l.credit_minor)) x")"
guards="$(q "select count(*) from pg_trigger where not tgisinternal")"
echo "restored $latest → tables=$tables migrations=$migrations users=$users triggers=$guards ledger_unbalanced_currencies=$unbalanced"
[[ "$tables" -gt 50 && "$migrations" -gt 0 && "$unbalanced" -eq 0 && "$guards" -gt 0 ]] || { echo "RESTORE CHECK FAILED" >&2; exit 1; }
echo "restore check passed"
