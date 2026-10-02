import pg from 'pg';
import { createDb, runMigrations, seed } from '@aruma/db';
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
  await pool.end();
}
