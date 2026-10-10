/**
 * Sandbox provider: a local stand-in for a real gateway so the whole flow (redirect, webhook, verification,
 * refunds) can be developed and tested without any account. It is NOT a payment provider and is refused
 * in production. Payments are completed by the developer on /sandbox/checkouts/:id.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NormalizedStatus, PaymentProvider, ProviderPayment } from './types.js';

type SandboxPayment = { id: string; status: NormalizedStatus; amountMinor: bigint; currency: string; webhookUrl: string; refunded: bigint };

export type SandboxProvider = PaymentProvider & {
  /** Simulates the customer's action on the hosted page and returns the signed webhook to deliver. */
  complete(providerPaymentId: string, outcome: 'paid' | 'failed' | 'cancelled', amountMinor?: bigint): { body: Buffer; headers: Record<string, string> } | null;
  get(providerPaymentId: string): SandboxPayment | undefined;
};

export function createSandboxProvider(publicBaseUrl: string, secret: string): SandboxProvider {
  const store = new Map<string, SandboxPayment>();
  const sign = (body: Buffer) => createHmac('sha256', secret).update(body).digest('hex');
  const view = (p: SandboxPayment): ProviderPayment => ({
    providerPaymentId: p.id,
    status: p.status,
    providerStatus: p.status,
    amountMinor: p.amountMinor,
    currency: p.currency,
    redirectUrl: `${publicBaseUrl}/sandbox/checkouts/${p.id}`,
  });

  return {
    name: 'sandbox',
    supportsRefunds: true,
    async createPayment(params) {
      const payment: SandboxPayment = {
        id: `sbx_${randomUUID()}`,
        status: 'pending',
        amountMinor: params.amountMinor,
        currency: params.currency,
        webhookUrl: params.webhookUrl,
        refunded: 0n,
      };
      store.set(payment.id, payment);
      return { ...view(payment), redirectUrl: `${publicBaseUrl}/sandbox/checkouts/${payment.id}` };
    },
    async fetchPayment(id) {
      const p = store.get(id);
      if (!p) throw new Error(`Unknown sandbox payment ${id}`);
      return view(p);
    },
    verifyWebhook(rawBody, headers) {
      const sig = headers['x-sandbox-signature'];
      if (typeof sig !== 'string' || sig.length !== 64) return false;
      return timingSafeEqual(Buffer.from(sign(rawBody)), Buffer.from(sig));
    },
    parseWebhook(rawBody) {
      const e = JSON.parse(rawBody.toString('utf8'));
      return { eventId: e.id, eventType: e.type, providerPaymentId: e.data.id };
    },
    async refund({ providerPaymentId, amountMinor }) {
      const p = store.get(providerPaymentId);
      if (!p || p.status !== 'successful' || p.refunded + amountMinor > p.amountMinor) return { providerRefundId: `sbxr_${randomUUID()}`, status: 'failed' };
      p.refunded += amountMinor;
      return { providerRefundId: `sbxr_${randomUUID()}`, status: 'successful' };
    },
    complete(id, outcome, amountMinor) {
      const p = store.get(id);
      if (!p || p.status !== 'pending') return null;
      p.status = outcome === 'paid' ? 'successful' : outcome === 'failed' ? 'failed' : 'cancelled';
      // Lets tests simulate a provider reporting a different amount than requested.
      if (amountMinor !== undefined) p.amountMinor = amountMinor;
      const body = Buffer.from(JSON.stringify({ id: `evt_${randomUUID()}`, type: `checkout.${outcome}`, data: { id } }));
      return { body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': sign(body) } };
    },
    get: (id) => store.get(id),
  };
}
