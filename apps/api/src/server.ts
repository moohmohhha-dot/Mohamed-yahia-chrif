import { createDb } from '@aruma/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const app = buildApp(db, { logger: { level: config.LOG_LEVEL } });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
