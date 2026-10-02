import pino from 'pino';
import { buildPaymentsApp } from './app.js';
import { loadPaymentsConfig } from './config.js';
import { createPaymentsDb } from './db/client.js';
import { deliverEvents, httpTransport } from './events.js';
import { createChargilyProvider } from './providers/chargily.js';
import { createSandboxProvider } from './providers/sandbox.js';
import type { PaymentProvider } from './providers/types.js';

const config = loadPaymentsConfig();
const log = pino({ level: config.LOG_LEVEL });
const { db, pool } = createPaymentsDb(config.PAYMENTS_DATABASE_URL);

const providers: Record<string, PaymentProvider> = {};
const sandbox = config.NODE_ENV === 'production' ? undefined : createSandboxProvider(config.PAYMENTS_PUBLIC_URL, config.PAYMENTS_SERVICE_TOKEN);
if (sandbox) providers.sandbox = sandbox;
if (config.CHARGILY_SECRET_KEY) {
  providers.chargily = createChargilyProvider({ mode: config.CHARGILY_MODE, secretKey: config.CHARGILY_SECRET_KEY, amountUnit: config.CHARGILY_AMOUNT_UNIT });
}

const app = buildPaymentsApp({
  logger: { level: config.LOG_LEVEL },
  db,
  providers,
  defaultOnlineProvider: config.ONLINE_PROVIDER,
  publicBaseUrl: config.PAYMENTS_PUBLIC_URL,
  clients: { 'aruma-core': config.PAYMENTS_SERVICE_TOKEN },
  sandbox,
});

const targets = { 'aruma-core': { url: config.CORE_EVENTS_URL, secret: config.PAYMENTS_EVENTS_SECRET } };
const timer = setInterval(() => {
  deliverEvents(db, targets, httpTransport).catch((e) => log.error(e, 'event delivery failed'));
}, 3000);

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ port: config.PORT, host: config.HOST });
