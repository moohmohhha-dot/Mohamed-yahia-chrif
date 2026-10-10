/**
 * Client for the independent Payment Service (apps/payments). ARUMA CORE never talks to a payment
 * provider and never holds provider secrets: it asks the Payment Service, which returns redirect URLs
 * and later sends signed events (see events.ts).
 */
import { AppError } from '../../shared/errors.js';

export type PaymentIntent = {
  id: string;
  referenceType: string;
  referenceId: string;
  method: 'online' | 'cash_on_delivery';
  provider: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  status: 'pending' | 'successful' | 'failed' | 'cancelled' | 'refunded';
  failureReason: string | null;
  redirectUrl: string | null;
  refunds: { id: string; amountMinor: number; status: string; method: string; scope: string | null; externalReference: string | null }[];
};

export type CreateIntentRequest = {
  referenceType: 'checkout' | 'order';
  referenceId: string;
  method: 'online' | 'cash_on_delivery';
  amountMinor: number;
  currency: string;
  description?: string;
  returnUrl?: string;
  failureUrl?: string;
  locale?: 'ar' | 'fr' | 'en';
  providerOptions?: { paymentMethod?: 'edahabia' | 'cib' };
};

export interface PaymentsClient {
  createIntent(idempotencyKey: string, body: CreateIntentRequest): Promise<PaymentIntent>;
  getIntent(id: string): Promise<PaymentIntent>;
  retry(id: string): Promise<PaymentIntent>;
  verify(id: string): Promise<PaymentIntent>;
  cancel(id: string, reason: string): Promise<PaymentIntent>;
  cashCollected(id: string, amountMinor: number, collectedBy: string): Promise<PaymentIntent>;
  /** Paid / refunded payments created in [from, to), with their refunds (for finance reconciliation). */
  reconciliation(from: Date, to: Date): Promise<(PaymentIntent & { refunds: { id: string; amountMinor: number; scope: string | null; method: string }[] })[]>;
  refund(
    id: string,
    idempotencyKey: string,
    body: { amountMinor: number; reason: string; requestedBy: string; externalReference?: string; scope?: string },
  ): Promise<{ refundId: string; intent: PaymentIntent }>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>;

export function createHttpPaymentsClient(options: { baseUrl: string; token: string; fetch?: Fetch; timeoutMs?: number }): PaymentsClient {
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) }));

  async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'The payment service is unavailable; please try again');
    }
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) {
      // Pass business errors through (e.g. REFUND_EXCEEDS_PAYMENT); hide internal ones.
      if (res.status >= 500 && json.error?.code !== 'PROVIDER_UNAVAILABLE' && json.error?.code !== 'REFUND_FAILED') {
        throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'The payment service is unavailable; please try again');
      }
      throw new AppError(res.status === 401 ? 503 : res.status, json.error?.code ?? 'PAYMENT_ERROR', json.error?.message ?? 'Payment error', json.error?.details);
    }
    return json.data as T;
  }

  return {
    createIntent: (key, body) => call('POST', '/v1/payment-intents', body, key),
    getIntent: (id) => call('GET', `/v1/payment-intents/${id}`),
    retry: (id) => call('POST', `/v1/payment-intents/${id}/retry`),
    verify: (id) => call('POST', `/v1/payment-intents/${id}/verify`),
    cancel: (id, reason) => call('POST', `/v1/payment-intents/${id}/cancel`, { reason }),
    cashCollected: (id, amountMinor, collectedBy) => call('POST', `/v1/payment-intents/${id}/cash-collected`, { amountMinor, collectedBy }),
    refund: (id, key, body) => call('POST', `/v1/payment-intents/${id}/refunds`, body, key),
    reconciliation: (from, to) =>
      call('GET', `/v1/reconciliation?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
  };
}
