import { createDb } from '@aruma/db';
import pino from 'pino';
import { buildApp } from './app.js';
import { expireUnpaidCheckouts } from './modules/orders/payments.js';
import { releaseExpiredReservations } from './modules/inventory/index.js';
import { releaseMaturedBalances } from './modules/finance/index.js';
import { securityAlerts } from './modules/admin/index.js';
import { escalateUnanswered, finalizeDueDisputes } from './modules/disputes/index.js';
import { processSearchQueue, purgeOldQueries, queueAllProducts } from './modules/search/index.js';
import { escalateOverdueReturns } from './modules/returns/index.js';
import { loadConfig } from './config.js';
import { createAnthropicProvider } from './modules/ai/index.js';
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
  secrets: createSecretBox(config.DATA_ENCRYPTION_KEY, config.DATA_ENCRYPTION_KEYS_OLD.split(',').filter(Boolean)),
  storage: createLocalStorage(config.STORAGE_DIR),
  messages: createLogMessageSender(pino({ level: config.LOG_LEVEL })),
  payments: createHttpPaymentsClient({ baseUrl: config.PAYMENTS_URL, token: config.PAYMENTS_SERVICE_TOKEN }),
  paymentEventsSecret: config.PAYMENTS_EVENTS_SECRET,
  storefrontUrl: config.STOREFRONT_URL,
  // Courier API integrations. None is real yet: couriers are used with hand-entered tracking (docs/SHIPPING.md).
  couriers: (config.COURIER_SANDBOX ? { sandbox: createSandboxCourier() } : {}) as CourierRegistry,
  // Optional AI layer: off unless AI_PROVIDER is set; then each feature is switched on in the Admin Panel.
  ai: {
    provider: config.AI_PROVIDER === 'anthropic' ? createAnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY!, model: config.AI_MODEL }) : null,
    timeoutMs: config.AI_TIMEOUT_MS,
    dailyTokenBudget: config.AI_DAILY_TOKEN_BUDGET,
    userHourlyLimit: config.AI_USER_HOURLY_LIMIT,
  },
};
const app = buildApp(db, services, {
  // Credentials and codes never reach the logs, even if a request object is logged in full.
  logger: {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-payments-signature"]', '*.password', '*.newPassword', '*.currentPassword', '*.token', '*.code', '*.challengeToken', '*.accountNumber', '*.documentNumber'],
      censor: '[redacted]',
    },
  },
  trustProxy: config.TRUST_PROXY,
  authRateLimitMax: config.AUTH_RATE_LIMIT_MAX,
  globalRateLimitMax: config.GLOBAL_RATE_LIMIT_MAX,
  staffMfaRequired: config.STAFF_MFA_REQUIRED,
  hsts: config.HSTS,
});

// Background jobs: unpaid online checkouts expire after an hour; expired stock holds are released;
// merchant balances leave the hold period; return requests and disputes left unanswered go to ARUMA;
// dispute decisions become final when the appeal window ends.
const jobs = setInterval(() => {
  expireUnpaidCheckouts(db, { payments: services.payments }, 60).catch((e) => app.log.error(e, 'checkout expiry failed'));
  releaseExpiredReservations(db).catch((e) => app.log.error(e, 'reservation expiry failed'));
  // Merchant money becomes available when the hold period (returns window) ends.
  releaseMaturedBalances(db).catch((e) => app.log.error(e, 'balance release failed'));
  escalateOverdueReturns(db).catch((e) => app.log.error(e, 'return escalation failed'));
  escalateUnanswered(db).catch((e) => app.log.error(e, 'dispute escalation failed'));
  finalizeDueDisputes(db, { payments: services.payments }).catch((e) => app.log.error(e, 'dispute finalization failed'));
}, 5 * 60_000);

// Search index: products changed (prices, stock, names, reviews…) are re-indexed within seconds; every
// product once a day (popularity); search history older than 180 days is deleted.
let indexing = false;
const searchJob = setInterval(() => {
  if (indexing) return;
  indexing = true;
  processSearchQueue(db)
    .catch((e) => app.log.error(e, 'search indexing failed'))
    .finally(() => (indexing = false));
}, 5_000);
const searchDaily = setInterval(() => {
  queueAllProducts(db).catch((e) => app.log.error(e, 'search daily re-index failed'));
  purgeOldQueries(db).catch((e) => app.log.error(e, 'search history purge failed'));
  app.ai.cache.purge().catch((e) => app.log.error(e, 'AI cache purge failed'));
}, 24 * 3600_000);

// Security monitoring: high and medium alerts go to the log (an alerting service watches for "security_alert").
const monitoring = setInterval(() => {
  securityAlerts(db)
    .then((alerts) => alerts.filter((a) => a.severity !== 'info').forEach((a) => app.log.warn({ security_alert: a }, `security alert: ${a.code}`)))
    .catch((e) => app.log.error(e, 'security monitoring failed'));
}, 15 * 60_000);

const shutdown = async () => {
  clearInterval(jobs);
  clearInterval(monitoring);
  clearInterval(searchJob);
  clearInterval(searchDaily);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
