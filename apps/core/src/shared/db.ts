import type { Database } from '@aruma/db';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Executor = Database | Transaction;

/**
 * Awaits Drizzle queries one after another. Use instead of Promise.all when the executor may be a
 * transaction: a transaction is a single connection, which must not run queries concurrently.
 * (Drizzle query builders are lazy, so nothing starts until it is awaited here.)
 */
export async function sequential<T extends readonly unknown[]>(queries: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results: unknown[] = [];
  for (const query of queries) results.push(await query);
  return results as { -readonly [K in keyof T]: Awaited<T[K]> };
}
