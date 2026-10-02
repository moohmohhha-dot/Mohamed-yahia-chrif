/**
 * Chargily Pay (V2) — Algerian payment gateway for CIB (SATIM) and EDAHABIA (Algérie Poste) cards.
 *
 * Built from Chargily's official SDKs (github.com/Chargily/chargily-pay-javascript, chargily-pay-go):
 *   base URL   test: https://pay.chargily.net/test/api/v2   live: https://pay.chargily.net/api/v2
 *   auth       Authorization: Bearer <secret key>
 *   create     POST checkouts { amount, currency, success_url, failure_url?, webhook_endpoint?, description?,
 *                               locale?: ar|en|fr, payment_method?: edahabia|cib, metadata? } → { id, status, checkout_url, … }
 *   read       GET checkouts/{id} → status: pending | processing | paid | failed | canceled
 *   webhook    header "signature" = hex HMAC-SHA256(raw body, secret key); body { id, type, data: <checkout> },
 *              types include checkout.paid and checkout.failed
 *   refunds    no refund endpoint in the official SDKs → refunds are done outside the API and recorded
 *              in ARUMA as manual refunds with their reference.
 *
 * Amount unit: CHARGILY_AMOUNT_UNIT. The official examples send whole dinars (amount: 5000, currency: "dzd");
 * "major" (default) sends dinars. Confirm with one sandbox payment before going live.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError, type Fetch, type NormalizedStatus, type PaymentProvider, type ProviderPayment } from './types.js';

export type ChargilyConfig = {
  mode: 'test' | 'live';
  secretKey: string;
  amountUnit: 'major' | 'minor';
  fetch?: Fetch;
  /** Overrides the base URL (tests point it at a local mock server). */
  baseUrl?: string;
};

const BASE_URLS = { test: 'https://pay.chargily.net/test/api/v2', live: 'https://pay.chargily.net/api/v2' };

const STATUS: Record<string, NormalizedStatus> = {
  pending: 'pending',
  processing: 'pending',
  paid: 'successful',
  failed: 'failed',
  canceled: 'cancelled',
};

type ChargilyCheckout = { id: string; status: string; amount: number; currency: string; checkout_url: string };

export function createChargilyProvider(config: ChargilyConfig): PaymentProvider {
  const baseUrl = config.baseUrl ?? BASE_URLS[config.mode];
  const doFetch = config.fetch ?? fetch;

  const toProviderAmount = (minor: bigint) => {
    if (config.amountUnit === 'minor') return Number(minor);
    if (minor % 100n !== 0n) throw new ProviderError('Chargily takes whole dinars; amount has centimes', false);
    return Number(minor / 100n);
  };
  const fromProviderAmount = (amount: number) => (config.amountUnit === 'minor' ? BigInt(amount) : BigInt(amount) * 100n);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ProviderError(`Chargily unreachable: ${(error as Error).message}`, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`Chargily ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500);
    }
    return (await res.json()) as T;
  }

  const normalize = (c: ChargilyCheckout): ProviderPayment => ({
    providerPaymentId: c.id,
    status: STATUS[c.status] ?? 'pending',
    providerStatus: c.status,
    amountMinor: fromProviderAmount(c.amount),
    currency: String(c.currency).toUpperCase(),
    redirectUrl: c.checkout_url,
  });

  return {
    name: 'chargily',
    supportsRefunds: false,
    async createPayment(p) {
      if (p.currency !== 'DZD') throw new ProviderError('Chargily only accepts DZD', false);
      const method = p.options?.paymentMethod;
      const checkout = await request<ChargilyCheckout>('POST', 'checkouts', {
        amount: toProviderAmount(p.amountMinor),
        currency: 'dzd',
        success_url: p.successUrl,
        ...(p.failureUrl ? { failure_url: p.failureUrl } : {}),
        webhook_endpoint: p.webhookUrl,
        ...(p.description ? { description: p.description.slice(0, 255) } : {}),
        ...(p.locale && ['ar', 'en', 'fr'].includes(p.locale) ? { locale: p.locale } : {}),
        ...(method === 'edahabia' || method === 'cib' ? { payment_method: method } : {}),
        metadata: { aruma_intent_id: p.intentId, aruma_attempt_id: p.attemptId },
      });
      const payment = normalize(checkout);
      if (!payment.redirectUrl) throw new ProviderError('Chargily returned no checkout_url', true);
      return { ...payment, redirectUrl: payment.redirectUrl };
    },
    async fetchPayment(id) {
      return normalize(await request<ChargilyCheckout>('GET', `checkouts/${encodeURIComponent(id)}`));
    },
    verifyWebhook(rawBody, headers) {
      const signature = headers.signature;
      if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
      const expected = createHmac('sha256', config.secretKey).update(rawBody).digest('hex');
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()));
    },
    parseWebhook(rawBody) {
      const event = JSON.parse(rawBody.toString('utf8')) as { id?: string; type?: string; data?: { id?: string } };
      if (!event.id || !event.type || !event.data?.id) throw new ProviderError('Malformed Chargily webhook', false);
      return { eventId: event.id, eventType: event.type, providerPaymentId: event.data.id };
    },
  };
}
