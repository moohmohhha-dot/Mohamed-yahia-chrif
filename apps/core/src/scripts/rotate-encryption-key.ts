/**
 * Re-encrypts all sensitive values and files with the current key after a key change.
 *
 *   1. Generate a new key: openssl rand -base64 32
 *   2. Set DATA_ENCRYPTION_KEY=<new key> and DATA_ENCRYPTION_KEYS_OLD=<previous key>, restart the API.
 *   3. DATABASE_URL=... STORAGE_DIR=... pnpm --filter @aruma/core rotate-encryption-key
 *   4. When it reports nothing left on the old key (run it again: resealed = 0), remove DATA_ENCRYPTION_KEYS_OLD.
 * Take a backup first (scripts/backup.sh). Values are re-sealed in one transaction; files one by one.
 */
import { createDb } from '@aruma/db';
import { createLocalStorage, createSecretBox, rotateEncryption } from '../modules/platform/index.js';

const { DATABASE_URL, DATA_ENCRYPTION_KEY, DATA_ENCRYPTION_KEYS_OLD = '', STORAGE_DIR = './storage' } = process.env;
if (!DATABASE_URL || !DATA_ENCRYPTION_KEY) {
  console.error('Set DATABASE_URL, DATA_ENCRYPTION_KEY (new) and DATA_ENCRYPTION_KEYS_OLD (previous)');
  process.exit(1);
}
const { db, pool } = createDb(DATABASE_URL);
try {
  const secrets = createSecretBox(DATA_ENCRYPTION_KEY, DATA_ENCRYPTION_KEYS_OLD.split(',').filter(Boolean));
  const report = await db.transaction((tx) => rotateEncryption(tx, secrets, createLocalStorage(STORAGE_DIR)));
  console.log(JSON.stringify(report, null, 2));
  if (report.files.missing) console.warn(`${report.files.missing} file(s) listed in the database were not found in ${STORAGE_DIR}`);
} finally {
  await pool.end();
}
