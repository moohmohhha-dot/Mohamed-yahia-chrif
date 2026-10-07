#!/usr/bin/env bash
# Encrypted backup of ARUMA: the database (core + Payment Service) and uploaded files.
#
#   DATABASE_URL=...  STORAGE_DIR=/srv/aruma/storage  BACKUP_DIR=/srv/backups \
#   BACKUP_AGE_RECIPIENT=age1...  scripts/backup.sh
#
# - Encrypted with age (https://age-encryption.org, free) for a PUBLIC key: the server can write backups
#   but cannot read them. The private key stays offline (see docs/SECURITY.md, "Disaster recovery").
# - PAYMENTS_DATABASE_URL is backed up too when it is a different database.
# - Keeps RETENTION_DAYS days (default 30). Copy BACKUP_DIR to another place (object storage, another
#   provider/region) after each run: a backup on the same server does not survive losing the server.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT (age public key) is required}"
STORAGE_DIR="${STORAGE_DIR:-./storage}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
umask 077

dump() { # $1 = url, $2 = name
  pg_dump --format=custom --no-owner --no-privileges "$1" | age -r "$BACKUP_AGE_RECIPIENT" -o "$BACKUP_DIR/aruma-$2-$stamp.dump.age"
}
dump "$DATABASE_URL" core
if [[ -n "${PAYMENTS_DATABASE_URL:-}" && "$PAYMENTS_DATABASE_URL" != "$DATABASE_URL" ]]; then
  dump "$PAYMENTS_DATABASE_URL" payments
fi
if [[ -d "$STORAGE_DIR" ]]; then
  tar -C "$STORAGE_DIR" -cf - . | age -r "$BACKUP_AGE_RECIPIENT" -o "$BACKUP_DIR/aruma-files-$stamp.tar.age"
fi
(cd "$BACKUP_DIR" && sha256sum aruma-*-"$stamp".* > "aruma-$stamp.sha256")

find "$BACKUP_DIR" -name 'aruma-*' -type f -mtime +"$RETENTION_DAYS" -delete
echo "backup $stamp written to $BACKUP_DIR"
ls -l "$BACKUP_DIR" | grep "$stamp"
