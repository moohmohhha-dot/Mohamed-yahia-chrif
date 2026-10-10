#!/usr/bin/env bash
# Restores an encrypted backup made by scripts/backup.sh.
#
#   TARGET_DATABASE_URL=postgres://...  BACKUP_AGE_IDENTITY=/secure/aruma-backup.key \
#   scripts/restore.sh /srv/backups/aruma-core-20261007T020000Z.dump.age [files.tar.age TARGET_STORAGE_DIR]
#
# The target database must exist and be empty (or be one you accept to overwrite: objects are replaced).
# Checks the backup against its .sha256 manifest first. Never restore over production without a fresh
# backup of the current state.
set -euo pipefail

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY (age private key file) is required}"
dump="${1:?path to aruma-core-*.dump.age}"
files="${2:-}"
target_storage="${3:-}"

stamp="$(basename "$dump" | sed -E 's/^aruma-[a-z]+-(.*)\.dump\.age$/\1/')"
manifest="$(dirname "$dump")/aruma-$stamp.sha256"
if [[ -f "$manifest" ]]; then
  (cd "$(dirname "$dump")" && sha256sum --check --ignore-missing --quiet "aruma-$stamp.sha256")
  echo "checksums OK ($manifest)"
else
  echo "warning: no checksum manifest for $stamp" >&2
fi

age -d -i "$BACKUP_AGE_IDENTITY" "$dump" | pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error -d "$TARGET_DATABASE_URL"
echo "database restored into $TARGET_DATABASE_URL"

if [[ -n "$files" ]]; then
  : "${target_storage:?third argument: the storage directory to restore files into}"
  mkdir -p "$target_storage"
  age -d -i "$BACKUP_AGE_IDENTITY" "$files" | tar -C "$target_storage" -xf -
  echo "files restored into $target_storage"
fi
