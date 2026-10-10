/** What every online payment provider adapter must do. ARUMA never sees card numbers: customers pay on the provider's page. */
export type NormalizedStatus = 'pending' | 'successful' | 'failed' | 'cancelled';

export type CreatePaymentParams = {
  intentId: string;
  attemptId: string;
  amountMinor: bigint;
  currency: string;
  description?: string | null;
  locale?: string | null;
  successUrl: string;
  failureUrl?: string | null;
  webhookUrl: string;
  options?: Record<string, unknown>;
};

export type ProviderPayment = {
  providerPaymentId: string;
  status: NormalizedStatus;
  /** The provider's own status word, kept for support. */
  providerStatus: string;
  amountMinor: bigint;
  currency: string;
  redirectUrl?: string;
};

export type WebhookEvent = { eventId: string; eventType: string; providerPaymentId: string };

export interface PaymentProvider {
  readonly name: string;
  readonly supportsRefunds: boolean;
  createPayment(params: CreatePaymentParams): Promise<ProviderPayment & { redirectUrl: string }>;
  /** Asks the provider for the real state of a payment (used to verify every webhook and redirect). */
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: Buffer): WebhookEvent;
  refund?(input: { providerPaymentId: string; amountMinor: bigint; idempotencyKey: string }): Promise<{ providerRefundId: string; status: 'pending' | 'successful' | 'failed' }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;
