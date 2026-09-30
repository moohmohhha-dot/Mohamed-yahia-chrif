import { createDb } from '@aruma/db';
import pino from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLocalStorage, createLogMessageSender, createSecretBox } from './modules/platform/index.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  // The log sender would write verification codes to the logs: refuse to run without a real provider.
  throw new Error('No SMS/email provider is configured yet; production start is disabled');
}
const { db, pool } = createDb(config.DATABASE_URL);
const services = {
  secrets: createSecretBox(config.DATA_ENCRYPTION_KEY),
  storage: createLocalStorage(config.STORAGE_DIR),
  messages: createLogMessageSender(pino({ level: config.LOG_LEVEL })),
};
const app = buildApp(db, services, {
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
  authRateLimitMax: config.AUTH_RATE_LIMIT_MAX,
});

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
