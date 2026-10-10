import pg from 'pg';
import { isNull } from 'drizzle-orm';
import { createDb, runMigrations, schema, seed } from '@aruma/db';
import { runPaymentsMigrations } from '@aruma/payments';
import { testDatabaseUrl } from './helpers.js';

/** Wipes the test database, applies migrations and loads the seed data once per run. */
export default async function setup() {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS payments CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  await runMigrations(testDatabaseUrl);
  await runPaymentsMigrations(testDatabaseUrl);
  const { db, pool } = createDb(testDatabaseUrl);
  await seed(db);
  // Other modules' tests move cash-on-delivery orders straight to "processing"; cod.test.ts turns the
  // confirmation back on for its store (production keeps the platform default: confirmation required).
  await db.update(schema.codPolicies).set({ requireConfirmation: false }).where(isNull(schema.codPolicies.storeId));
  await pool.end();
}
