import { defineConfig } from 'drizzle-kit';

// The payments service owns its own Postgres schema ("payments") and migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  schemaFilter: ['payments'],
  migrations: { schema: 'payments' },
  dbCredentials: { url: process.env.PAYMENTS_DATABASE_URL ?? 'postgres://aruma:aruma@localhost:5432/aruma' },
});
