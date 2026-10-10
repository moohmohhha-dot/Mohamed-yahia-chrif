import pg from 'pg';
import { runPaymentsMigrations } from '../src/db/migrate.js';
import { testDatabaseUrl } from './helpers.js';

export default async function setup() {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS payments CASCADE');
  await client.end();
  await runPaymentsMigrations(testDatabaseUrl);
}
