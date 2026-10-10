import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPaymentsDb } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function runPaymentsMigrations(connectionString: string) {
  const { db, pool } = createPaymentsDb(connectionString);
  try {
    await migrate(db, { migrationsFolder, migrationsSchema: 'payments', migrationsTable: '__migrations' });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.PAYMENTS_DATABASE_URL;
  if (!url) throw new Error('PAYMENTS_DATABASE_URL is not set');
  await runPaymentsMigrations(url);
  console.log('Payments migrations applied');
}
