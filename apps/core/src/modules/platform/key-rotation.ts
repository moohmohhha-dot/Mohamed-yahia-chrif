/**
 * Re-seals every encrypted value and file with the current key (after DATA_ENCRYPTION_KEY changed and the
 * previous key moved to DATA_ENCRYPTION_KEYS_OLD). Safe to run twice: values already on the current key are
 * skipped. Run it, check the counts, then remove the old key from the configuration.
 */
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import type { SecretBox } from './secret-box.js';
import type { FileStorage } from './storage.js';

export type RotationReport = { values: { resealed: number; current: number }; files: { resealed: number; current: number; missing: number } };

export async function rotateEncryption(db: Executor, secrets: SecretBox, storage: FileStorage): Promise<RotationReport> {
  const report: RotationReport = { values: { resealed: 0, current: 0 }, files: { resealed: 0, current: 0, missing: 0 } };
  const reseal = (value: string) => {
    if (!secrets.needsRotation(Buffer.from(value, 'base64'))) {
      report.values.current++;
      return null;
    }
    report.values.resealed++;
    return secrets.seal(secrets.open(value));
  };

  for (const row of await db.select({ id: s.merchantIdentities.merchantId, v: s.merchantIdentities.documentNumberEncrypted }).from(s.merchantIdentities)) {
    const v = reseal(row.v);
    if (v) await db.update(s.merchantIdentities).set({ documentNumberEncrypted: v }).where(eq(s.merchantIdentities.merchantId, row.id));
  }
  for (const row of await db.select({ id: s.merchantPayoutMethods.id, v: s.merchantPayoutMethods.accountNumberEncrypted }).from(s.merchantPayoutMethods)) {
    const v = reseal(row.v);
    if (v) await db.update(s.merchantPayoutMethods).set({ accountNumberEncrypted: v }).where(eq(s.merchantPayoutMethods.id, row.id));
  }
  for (const row of await db.select({ id: s.courierAccounts.id, v: s.courierAccounts.credentialsEncrypted }).from(s.courierAccounts)) {
    const v = reseal(row.v);
    if (v) await db.update(s.courierAccounts).set({ credentialsEncrypted: v }).where(eq(s.courierAccounts.id, row.id));
  }
  for (const row of await db.select({ id: s.userMfa.userId, v: s.userMfa.secretEncrypted }).from(s.userMfa)) {
    const v = reseal(row.v);
    if (v) await db.update(s.userMfa).set({ secretEncrypted: v }).where(eq(s.userMfa.userId, row.id));
  }

  const keys = await db.execute<{ key: string }>(sql`
    select storage_key as key from merchant_documents
    union all select storage_key from return_evidence
    union all select storage_key from dispute_files
    union all select storage_key from review_media`);
  for (const { key } of keys.rows) {
    let sealed: Buffer;
    try {
      sealed = await storage.get(key);
    } catch {
      report.files.missing++;
      continue;
    }
    if (!secrets.needsRotation(sealed)) {
      report.files.current++;
      continue;
    }
    await storage.replace(key, secrets.sealBytes(secrets.openBytes(sealed)));
    report.files.resealed++;
  }
  return report;
}
