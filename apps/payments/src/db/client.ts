import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type PaymentsDb = NodePgDatabase<typeof schema>;
export type PaymentsTx = Parameters<Parameters<PaymentsDb['transaction']>[0]>[0];

export function createPaymentsDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
