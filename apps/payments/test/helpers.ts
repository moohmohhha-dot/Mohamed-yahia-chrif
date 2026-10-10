import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildPaymentsApp } from '../src/app.js';
import type { PaymentsDb } from '../src/db/client.js';
import { createChargilyProvider } from '../src/providers/chargily.js';
import { createSandboxProvider } from '../src/providers/sandbox.js';

export const testDatabaseUrl =
  process.env.PAYMENTS_TEST_DATABASE_URL ?? 'postgres://aruma:aruma@localhost:5432/aruma_payments_test';
export const TOKEN = 'test-service-token-0123456789abcdef0123';
export const CHARGILY_SECRET = 'test_sk_chargily_secret';

/**
 * A local stand-in for Chargily's API, implementing only what the official SDKs use:
 * POST /checkouts and GET /checkouts/:id, with Bearer auth.
 */
export async function startChargilyMock() {
  const checkouts = new Map<string, Record<string, unknown>>();
  const requests: { method: string; url: string; auth: string | undefined; body: any }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${CHARGILY_SECRET}`) return res.writeHead(401).end('{"message":"Unauthenticated."}');
      if (req.method === 'POST' && req.url === '/test/api/v2/checkouts') {
        const id = `01h${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const checkout = { id, entity: 'checkout', livemode: false, status: 'pending', ...body, checkout_url: `https://pay.chargily.net/test/checkout/${id}/pay` };
        checkouts.set(id, checkout);
        return res.writeHead(200).end(JSON.stringify(checkout));
      }
      const m = req.url?.match(/^\/test\/api\/v2\/checkouts\/([^/]+)$/);
      if (req.method === 'GET' && m && checkouts.has(m[1]!)) return res.writeHead(200).end(JSON.stringify(checkouts.get(m[1]!)));
      res.writeHead(404).end('{"message":"Not found"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/test/api/v2`,
    checkouts,
    requests,
    /** What Chargily would do when the customer pays: update the checkout and send a signed webhook. */
    settle(id: string, status: 'paid' | 'failed' | 'canceled') {
      const c = checkouts.get(id)!;
      c.status = status;
      const body = Buffer.from(JSON.stringify({ id: `evt_${randomUUID()}`, entity: 'event', livemode: 'false', type: `checkout.${status}`, data: c }));
      return { body, headers: { 'content-type': 'application/json', signature: createHmac('sha256', CHARGILY_SECRET).update(body).digest('hex') } };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function buildTestPaymentsApp(db: PaymentsDb, chargilyBaseUrl: string, defaultOnlineProvider: 'sandbox' | 'chargily' = 'sandbox') {
  const sandbox = createSandboxProvider('http://payments.test', 'sandbox-secret');
  const chargily = createChargilyProvider({ mode: 'test', secretKey: CHARGILY_SECRET, amountUnit: 'major', baseUrl: chargilyBaseUrl });
  const app = buildPaymentsApp({
    db,
    providers: { sandbox, chargily },
    defaultOnlineProvider,
    publicBaseUrl: 'http://payments.test',
    clients: { 'aruma-core': TOKEN },
    sandbox,
  });
  return Object.assign(app, { sandbox });
}

export const auth = { authorization: `Bearer ${TOKEN}` };
