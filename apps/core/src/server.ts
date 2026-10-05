import { createDb } from '@aruma/db';
import pino from 'pino';
import { buildApp } from './app.js';
import { expireUnpaidCheckouts } from './modules/orders/payments.js';
import { releaseExpiredReservations } from './modules/inventory/index.js';
import { releaseMaturedBalances } from './modules/finance/index.js';
import { escalateOverdueReturns } from './modules/returns/index.js';
import { loadConfig } from './config.js';
import { createHttpPaymentsClient } from './modules/payments/index.js';
import { createLocalStorage, createLogMessageSender, createSecretBox } from './modules/platform/index.js';
import { createSandboxCourier, type CourierRegistry } from './modules/shipping/index.js';

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
  payments: createHttpPaymentsClient({ baseUrl: config.PAYMENTS_URL, token: config.PAYMENTS_SERVICE_TOKEN }),
  paymentEventsSecret: config.PAYMENTS_EVENTS_SECRET,
  storefrontUrl: config.STOREFRONT_URL,
  // Courier API integrations. None is real yet: couriers are used with hand-entered tracking (docs/SHIPPING.md).
  couriers: (config.COURIER_SANDBOX ? { sandbox: createSandboxCourier() } : {}) as CourierRegistry,
};
const app = buildApp(db, services, {
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY,
  authRateLimitMax: config.AUTH_RATE_LIMIT_MAX,
});

// Background jobs: unpaid online checkouts expire after an hour; expired stock holds are released;
// merchant balances leave the hold period; return requests left unanswered go to ARUMA.
const jobs = setInterval(() => {
  expireUnpaidCheckouts(db, { payments: services.payments }, 60).catch((e) => app.log.error(e, 'checkout expiry failed'));
  releaseExpiredReservations(db).catch((e) => app.log.error(e, 'reservation expiry failed'));
  // Merchant money becomes available when the hold period (returns window) ends.
  releaseMaturedBalances(db).catch((e) => app.log.error(e, 'balance release failed'));
  escalateOverdueReturns(db).catch((e) => app.log.error(e, 'return escalation failed'));
}, 5 * 60_000);

const shutdown = async () => {
  clearInterval(jobs);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
