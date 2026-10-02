/**
 * Payment rules.
 *
 *   pending ──► successful ──► refunded   (refunded when refunds reach the full amount;
 *      │  ▲          ▲                      partial refunds keep "successful" with refundedMinor > 0)
 *      ▼  │ retry    │ late payment
 *    failed ──► cancelled
 *
 * - Webhooks and redirects are never trusted on their own: the payment is re-read from the provider
 *   (verification) and its amount and currency must match the intent.
 * - Creating an intent and a refund requires an idempotency key; webhooks are de-duplicated by event id.
 * - Every status change is recorded (append-only) and announced to the client as a signed event.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { PaymentsDb, PaymentsTx } from './db/client.js';
import * as t from './db/schema.js';
import { enqueueEvent } from './events.js';
import { ProviderError, type PaymentProvider } from './providers/types.js';

export class PaymentError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type Intent = typeof t.paymentIntents.$inferSelect;
type Status = Intent['status'];
type Source = 'api' | 'webhook' | 'verification' | 'cash_on_delivery' | 'refund';

export type Deps = {
  db: PaymentsDb;
  providers: Record<string, PaymentProvider>;
  defaultOnlineProvider: string;
  publicBaseUrl: string;
};

const ALLOWED: Record<Status, Status[]> = {
  pending: ['successful', 'failed', 'cancelled'],
  failed: ['pending', 'successful', 'cancelled'],
  // A provider may report a payment after we cancelled (customer paid on an old tab): keep the money's truth.
  cancelled: ['successful'],
  successful: ['refunded'],
  refunded: [],
};

const EVENT_FOR: Partial<Record<Status, string>> = {
  successful: 'payment.succeeded',
  failed: 'payment.failed',
  cancelled: 'payment.cancelled',
  refunded: 'payment.refunded',
};

export const publicIntent = (i: Intent) => ({
  id: i.id,
  referenceType: i.referenceType,
  referenceId: i.referenceId,
  method: i.method,
  provider: i.provider,
  amountMinor: Number(i.amountMinor),
  refundedMinor: Number(i.refundedMinor),
  currency: i.currency,
  status: i.status,
  failureReason: i.failureReason,
  paidAt: i.paidAt,
  createdAt: i.createdAt,
});

const eventPayload = (i: Intent, extra: Record<string, unknown> = {}) => ({ intent: publicIntent(i), ...extra });

async function lockIntent(tx: PaymentsTx, client: string, intentId: string): Promise<Intent> {
  const [intent] = await tx
    .select()
    .from(t.paymentIntents)
    .where(and(eq(t.paymentIntents.id, intentId), eq(t.paymentIntents.client, client)))
    .for('update');
  if (!intent) throw new PaymentError(404, 'NOT_FOUND', 'Payment not found');
  return intent;
}

/** The only place an intent's status changes: validates, writes history, announces it. */
async function setStatus(
  tx: PaymentsTx,
  intent: Intent,
  to: Status,
  source: Source,
  details: Record<string, unknown> = {},
  changes: Partial<typeof t.paymentIntents.$inferInsert> = {},
): Promise<Intent> {
  if (intent.status === to) return intent;
  if (!ALLOWED[intent.status].includes(to)) {
    throw new PaymentError(409, 'INVALID_PAYMENT_TRANSITION', `A payment cannot go from ${intent.status} to ${to}`);
  }
  const [updated] = await tx
    .update(t.paymentIntents)
    .set({ status: to, ...(to === 'successful' ? { paidAt: new Date() } : {}), ...changes })
    .where(eq(t.paymentIntents.id, intent.id))
    .returning();
  await tx.insert(t.statusHistory).values({ intentId: intent.id, fromStatus: intent.status, toStatus: to, source, details });
  const type = EVENT_FOR[to];
  if (type) await enqueueEvent(tx, updated!.client, type, eventPayload(updated!, { lateAfterCancel: intent.status === 'cancelled' }));
  return updated!;
}

export type CreateIntentInput = {
  referenceType: string;
  referenceId: string;
  method: 'online' | 'cash_on_delivery';
  amountMinor: bigint;
  currency: string;
  description?: string;
  returnUrl?: string;
  failureUrl?: string;
  locale?: string;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

async function startAttempt(deps: Deps, intent: Intent) {
  const provider = deps.providers[intent.provider];
  if (!provider) throw new PaymentError(500, 'PROVIDER_NOT_CONFIGURED', `Provider ${intent.provider} is not configured`);

  const attempt = await deps.db.transaction(async (tx) => {
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${t.paymentAttempts.number}), 0)`.mapWith(Number) })
      .from(t.paymentAttempts)
      .where(eq(t.paymentAttempts.intentId, intent.id));
    const [row] = await tx
      .insert(t.paymentAttempts)
      .values({ intentId: intent.id, number: last!.n + 1, provider: provider.name })
      .returning();
    return row!;
  });

  try {
    // Called outside any transaction: a slow provider never holds database locks.
    const created = await provider.createPayment({
      intentId: intent.id,
      attemptId: attempt.id,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      description: intent.description,
      locale: intent.locale,
      successUrl: intent.returnUrl ?? `${deps.publicBaseUrl}/return`,
      failureUrl: intent.failureUrl,
      webhookUrl: `${deps.publicBaseUrl}/webhooks/${provider.name}`,
      options: (intent.metadata.providerOptions as Record<string, unknown>) ?? {},
    });
    const [updated] = await deps.db
      .update(t.paymentAttempts)
      .set({ providerPaymentId: created.providerPaymentId, redirectUrl: created.redirectUrl, providerStatus: created.providerStatus })
      .where(eq(t.paymentAttempts.id, attempt.id))
      .returning();
    return updated!;
  } catch (error) {
    const reason = error instanceof ProviderError ? error.message : 'Provider error';
    await deps.db.transaction(async (tx) => {
      await tx.update(t.paymentAttempts).set({ status: 'failed', failureReason: reason }).where(eq(t.paymentAttempts.id, attempt.id));
      const locked = await lockIntent(tx, intent.client, intent.id);
      if (locked.status === 'pending') await setStatus(tx, locked, 'failed', 'api', { attemptId: attempt.id, reason }, { failureReason: reason });
    });
    throw new PaymentError(502, 'PROVIDER_UNAVAILABLE', 'The payment provider could not start the payment; try again', { retryable: true });
  }
}

/** Creates (or, for a repeated idempotency key, returns) a payment. Online payments get a redirect URL. */
export async function createIntent(deps: Deps, client: string, idempotencyKey: string, input: CreateIntentInput) {
  const [existing] = await deps.db
    .select()
    .from(t.paymentIntents)
    .where(and(eq(t.paymentIntents.client, client), eq(t.paymentIntents.idempotencyKey, idempotencyKey)));
  if (existing) {
    const same =
      existing.amountMinor === input.amountMinor &&
      existing.currency === input.currency &&
      existing.method === input.method &&
      existing.referenceId === input.referenceId;
    if (!same) throw new PaymentError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different payment');
    return getIntent(deps, client, existing.id);
  }

  const provider = input.method === 'cash_on_delivery' ? 'cash_on_delivery' : deps.defaultOnlineProvider;
  let intent: Intent;
  try {
    intent = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(t.paymentIntents)
        .values({
          client,
          idempotencyKey,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          method: input.method,
          provider,
          amountMinor: input.amountMinor,
          currency: input.currency,
          description: input.description ?? null,
          returnUrl: input.returnUrl ?? null,
          failureUrl: input.failureUrl ?? null,
          locale: input.locale ?? null,
          metadata: { ...(input.metadata ?? {}), ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}) },
        })
        .returning();
      await tx.insert(t.statusHistory).values({ intentId: row!.id, fromStatus: null, toStatus: 'pending', source: 'api' });
      return row!;
    });
  } catch (error) {
    // The same key submitted twice at once: return the one that won.
    const [winner] = await deps.db
      .select()
      .from(t.paymentIntents)
      .where(and(eq(t.paymentIntents.client, client), eq(t.paymentIntents.idempotencyKey, idempotencyKey)));
    if (winner) return getIntent(deps, client, winner.id);
    throw error;
  }

  if (input.method === 'online') await startAttempt(deps, intent).catch((e) => (e instanceof PaymentError ? undefined : Promise.reject(e)));
  return getIntent(deps, client, intent.id);
}

export async function getIntent(deps: Deps, client: string, intentId: string) {
  const [intent] = await deps.db
    .select()
    .from(t.paymentIntents)
    .where(and(eq(t.paymentIntents.id, intentId), eq(t.paymentIntents.client, client)));
  if (!intent) throw new PaymentError(404, 'NOT_FOUND', 'Payment not found');
  const attempts = await deps.db.select().from(t.paymentAttempts).where(eq(t.paymentAttempts.intentId, intent.id)).orderBy(asc(t.paymentAttempts.number));
  const refundRows = await deps.db.select().from(t.refunds).where(eq(t.refunds.intentId, intent.id)).orderBy(asc(t.refunds.createdAt));
  const history = await deps.db.select().from(t.statusHistory).where(eq(t.statusHistory.intentId, intent.id)).orderBy(asc(t.statusHistory.createdAt), asc(t.statusHistory.id));
  const current = attempts.at(-1);
  return {
    ...publicIntent(intent),
    redirectUrl: intent.status === 'pending' && current?.status === 'pending' ? current.redirectUrl : null,
    attempts: attempts.map((a) => ({ number: a.number, status: a.status, providerStatus: a.providerStatus, failureReason: a.failureReason, createdAt: a.createdAt })),
    refunds: refundRows.map((r) => ({
      id: r.id,
      amountMinor: Number(r.amountMinor),
      status: r.status,
      method: r.method,
      reason: r.reason,
      externalReference: r.externalReference,
      scope: r.scope,
      createdAt: r.createdAt,
    })),
    history: history.map((h) => ({ from: h.fromStatus, to: h.toStatus, source: h.source, details: h.details, at: h.createdAt })),
  };
}

/** Payment Retry: after a failure, starts a new attempt (a fresh provider checkout page). */
export async function retryIntent(deps: Deps, client: string, intentId: string) {
  const intent = await deps.db.transaction(async (tx) => {
    const locked = await lockIntent(tx, client, intentId);
    if (locked.method !== 'online') throw new PaymentError(409, 'NOT_RETRYABLE', 'Only online payments can be retried');
    if (locked.status !== 'failed') throw new PaymentError(409, 'NOT_RETRYABLE', `A ${locked.status} payment cannot be retried`);
    return setStatus(tx, locked, 'pending', 'api', { retry: true }, { failureReason: null });
  });
  await startAttempt(deps, intent);
  return getIntent(deps, client, intentId);
}

/**
 * Payment Verification: reads the real state from the provider and applies it.
 * The amount and currency reported by the provider must equal the intent's, otherwise the payment fails
 * and is flagged for review.
 */
async function applyProviderState(deps: Deps, attemptId: string, source: Source, details: Record<string, unknown> = {}) {
  const [attempt] = await deps.db.select().from(t.paymentAttempts).where(eq(t.paymentAttempts.id, attemptId));
  if (!attempt?.providerPaymentId) return;
  const provider = deps.providers[attempt.provider]!;
  const remote = await provider.fetchPayment(attempt.providerPaymentId);

  await deps.db.transaction(async (tx) => {
    const [intentRow] = await tx.select().from(t.paymentIntents).where(eq(t.paymentIntents.id, attempt.intentId));
    let intent = await lockIntent(tx, intentRow!.client, attempt.intentId);
    const [current] = await tx.select().from(t.paymentAttempts).where(eq(t.paymentAttempts.id, attemptId)).for('update');
    if (current!.status === remote.status) return; // already applied (duplicate or verification of a known state)

    const mismatch = remote.status === 'successful' && (remote.amountMinor !== intent.amountMinor || remote.currency !== intent.currency);
    const attemptStatus = mismatch ? 'failed' : remote.status;
    await tx
      .update(t.paymentAttempts)
      .set({ status: attemptStatus, providerStatus: remote.providerStatus, ...(mismatch ? { failureReason: 'AMOUNT_MISMATCH' } : {}) })
      .where(eq(t.paymentAttempts.id, attemptId));

    if (mismatch) {
      await enqueueEvent(tx, intent.client, 'payment.needs_review', eventPayload(intent, {
        reason: 'AMOUNT_MISMATCH',
        reported: { amountMinor: Number(remote.amountMinor), currency: remote.currency },
      }));
      if (intent.status === 'pending') {
        await setStatus(tx, intent, 'failed', source, { ...details, attemptId, reason: 'AMOUNT_MISMATCH' }, { failureReason: 'AMOUNT_MISMATCH' });
      }
      return;
    }

    if (remote.status === 'successful') {
      if (intent.status === 'successful' || intent.status === 'refunded') {
        // Paid twice (e.g. two tabs, two attempts): money must be returned, a human decides.
        await enqueueEvent(tx, intent.client, 'payment.needs_review', eventPayload(intent, { reason: 'DUPLICATE_PAYMENT', attemptId }));
        return;
      }
      intent = await setStatus(tx, intent, 'successful', source, { ...details, attemptId, providerStatus: remote.providerStatus });
    } else if (remote.status === 'failed' || remote.status === 'cancelled') {
      // A failed or abandoned checkout page means the payment failed; the customer may retry.
      const latest = await tx.select({ id: t.paymentAttempts.id }).from(t.paymentAttempts).where(eq(t.paymentAttempts.intentId, intent.id)).orderBy(desc(t.paymentAttempts.number)).limit(1);
      if (intent.status === 'pending' && latest[0]?.id === attemptId) {
        await setStatus(tx, intent, 'failed', source, { ...details, attemptId, providerStatus: remote.providerStatus }, { failureReason: `Provider: ${remote.providerStatus}` });
      }
    }
  });
}

export async function verifyIntent(deps: Deps, client: string, intentId: string) {
  const [latest] = await deps.db
    .select()
    .from(t.paymentAttempts)
    .innerJoin(t.paymentIntents, eq(t.paymentIntents.id, t.paymentAttempts.intentId))
    .where(and(eq(t.paymentAttempts.intentId, intentId), eq(t.paymentIntents.client, client)))
    .orderBy(desc(t.paymentAttempts.number))
    .limit(1);
  if (latest) await applyProviderState(deps, latest.payment_attempts.id, 'verification');
  return getIntent(deps, client, intentId);
}

export async function cancelIntent(deps: Deps, client: string, intentId: string, reason: string) {
  await deps.db.transaction(async (tx) => {
    const intent = await lockIntent(tx, client, intentId);
    if (intent.status === 'cancelled') return;
    if (intent.status !== 'pending' && intent.status !== 'failed') {
      throw new PaymentError(409, 'NOT_CANCELLABLE', `A ${intent.status} payment cannot be cancelled; refund it instead`);
    }
    await setStatus(tx, intent, 'cancelled', 'api', { reason });
  });
  return getIntent(deps, client, intentId);
}

/** Cash on Delivery: the carrier or merchant collected the money at the door. */
export async function collectCash(deps: Deps, client: string, intentId: string, input: { amountMinor: bigint; collectedBy: string }) {
  await deps.db.transaction(async (tx) => {
    const intent = await lockIntent(tx, client, intentId);
    if (intent.method !== 'cash_on_delivery') throw new PaymentError(409, 'NOT_CASH_ON_DELIVERY', 'This payment is not cash on delivery');
    if (intent.status === 'successful') return; // already recorded
    if (input.amountMinor !== intent.amountMinor) {
      throw new PaymentError(409, 'AMOUNT_MISMATCH', 'The collected amount must equal the amount due', { due: Number(intent.amountMinor) });
    }
    await setStatus(tx, intent, 'successful', 'cash_on_delivery', { collectedBy: input.collectedBy });
  });
  return getIntent(deps, client, intentId);
}

export type RefundInput = {
  amountMinor: bigint;
  reason: string;
  requestedBy: string;
  externalReference?: string;
  scope?: string;
};

/**
 * Refund or Partial Refund. Goes through the provider when it supports refunds; otherwise (Chargily, cash)
 * the refund is made outside ARUMA and recorded here with its proof (externalReference).
 */
export async function refundIntent(deps: Deps, client: string, intentId: string, idempotencyKey: string, input: RefundInput) {
  const prepared = await deps.db.transaction(async (tx) => {
    const intent = await lockIntent(tx, client, intentId);
    const [existing] = await tx
      .select()
      .from(t.refunds)
      .where(and(eq(t.refunds.intentId, intentId), eq(t.refunds.idempotencyKey, idempotencyKey)));
    if (existing) {
      if (existing.amountMinor !== input.amountMinor) throw new PaymentError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different refund');
      return { refund: existing, intent, replay: true };
    }
    if (intent.status !== 'successful') throw new PaymentError(409, 'NOT_REFUNDABLE', `A ${intent.status} payment cannot be refunded`);

    const [pending] = await tx
      .select({ sum: sql<string>`coalesce(sum(${t.refunds.amountMinor}), 0)::text` })
      .from(t.refunds)
      .where(and(eq(t.refunds.intentId, intentId), eq(t.refunds.status, 'pending')));
    const refundable = intent.amountMinor - intent.refundedMinor - BigInt(pending!.sum);
    if (input.amountMinor > refundable) {
      throw new PaymentError(409, 'REFUND_EXCEEDS_PAYMENT', `At most ${refundable} can still be refunded`, { refundableMinor: Number(refundable) });
    }

    const provider = deps.providers[intent.provider];
    const viaProvider = intent.method === 'online' && provider?.supportsRefunds && provider.refund;
    if (!viaProvider && !input.externalReference) {
      throw new PaymentError(400, 'EXTERNAL_REFERENCE_REQUIRED', 'This payment is refunded outside ARUMA: give the transfer or receipt reference');
    }
    const [refund] = await tx
      .insert(t.refunds)
      .values({
        intentId,
        idempotencyKey,
        amountMinor: input.amountMinor,
        reason: input.reason,
        method: viaProvider ? 'provider' : 'manual',
        requestedBy: input.requestedBy,
        scope: input.scope ?? null,
        externalReference: viaProvider ? null : input.externalReference!,
      })
      .returning();
    return { refund: refund!, intent, replay: false };
  });
  if (prepared.replay) return { refundId: prepared.refund.id, intent: await getIntent(deps, client, intentId) };

  // Ask the provider outside the transaction, then record the outcome.
  let outcome: { status: 'successful' | 'failed' | 'pending'; reference: string | null; failure?: string };
  if (prepared.refund.method === 'provider') {
    const attempts = await deps.db.select().from(t.paymentAttempts).where(and(eq(t.paymentAttempts.intentId, intentId), eq(t.paymentAttempts.status, 'successful')));
    try {
      const r = await deps.providers[prepared.intent.provider]!.refund!({
        providerPaymentId: attempts[0]!.providerPaymentId!,
        amountMinor: input.amountMinor,
        idempotencyKey: prepared.refund.id,
      });
      outcome = { status: r.status, reference: r.providerRefundId };
    } catch (error) {
      outcome = { status: 'failed', reference: null, failure: (error as Error).message };
    }
  } else {
    outcome = { status: 'successful', reference: prepared.refund.externalReference };
  }

  await deps.db.transaction(async (tx) => {
    let intent = await lockIntent(tx, client, intentId);
    await tx
      .update(t.refunds)
      .set({ status: outcome.status, externalReference: outcome.reference, failureReason: outcome.failure ?? null, completedAt: outcome.status === 'pending' ? null : new Date() })
      .where(eq(t.refunds.id, prepared.refund.id));
    if (outcome.status !== 'successful') {
      if (outcome.status === 'failed') {
        await enqueueEvent(tx, intent.client, 'payment.refund_failed', eventPayload(intent, { refund: { id: prepared.refund.id, amountMinor: Number(input.amountMinor), scope: input.scope ?? null } }));
      }
      return;
    }
    const refundedMinor = intent.refundedMinor + input.amountMinor;
    const refundInfo = { id: prepared.refund.id, amountMinor: Number(input.amountMinor), scope: input.scope ?? null, reason: input.reason };
    if (refundedMinor === intent.amountMinor) {
      intent = await setStatus(tx, intent, 'refunded', 'refund', { refundId: prepared.refund.id }, { refundedMinor });
      // setStatus announced payment.refunded; add the refund details to it through a dedicated event too.
      await enqueueEvent(tx, intent.client, 'payment.refund_succeeded', eventPayload(intent, { refund: refundInfo }));
    } else {
      const [updated] = await tx.update(t.paymentIntents).set({ refundedMinor }).where(eq(t.paymentIntents.id, intentId)).returning();
      await tx.insert(t.statusHistory).values({
        intentId,
        fromStatus: intent.status,
        toStatus: intent.status,
        source: 'refund',
        details: { refundId: prepared.refund.id, partial: true, amountMinor: Number(input.amountMinor) },
      });
      await enqueueEvent(tx, intent.client, 'payment.refund_succeeded', eventPayload(updated!, { refund: refundInfo }));
    }
  });
  if (outcome.status === 'failed') throw new PaymentError(502, 'REFUND_FAILED', 'The provider refused the refund', { refundId: prepared.refund.id });
  return { refundId: prepared.refund.id, intent: await getIntent(deps, client, intentId) };
}

/**
 * Webhooks: every delivery is stored; the signature is checked; an event id is processed once;
 * the payment's state is then re-read from the provider (never taken from the webhook body).
 */
export async function handleWebhook(deps: Deps, providerName: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  const provider = deps.providers[providerName];
  if (!provider) throw new PaymentError(404, 'NOT_FOUND', 'Unknown provider');
  const valid = provider.verifyWebhook(rawBody, headers);
  let parsed: ReturnType<PaymentProvider['parseWebhook']> | null = null;
  try {
    parsed = provider.parseWebhook(rawBody);
  } catch {
    parsed = null;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = { raw: rawBody.toString('utf8').slice(0, 2000) };
  }

  if (!valid || !parsed) {
    await deps.db.insert(t.webhookEvents).values({
      provider: providerName,
      providerEventId: null,
      eventType: parsed?.eventType ?? null,
      signatureValid: valid ? 1 : 0,
      payload,
      error: valid ? 'Malformed payload' : 'Invalid signature',
    });
    throw new PaymentError(valid ? 400 : 401, valid ? 'MALFORMED_WEBHOOK' : 'INVALID_SIGNATURE', 'Webhook rejected');
  }

  let [stored] = await deps.db
    .insert(t.webhookEvents)
    .values({ provider: providerName, providerEventId: parsed.eventId, eventType: parsed.eventType, signatureValid: 1, payload })
    .onConflictDoNothing()
    .returning();
  if (!stored) {
    // Seen before: done if it was processed; otherwise the earlier try failed, so process it now.
    [stored] = await deps.db
      .select()
      .from(t.webhookEvents)
      .where(and(eq(t.webhookEvents.provider, providerName), eq(t.webhookEvents.providerEventId, parsed.eventId)));
    if (stored!.processedAt) return { duplicate: true };
  }

  const [attempt] = await deps.db
    .select()
    .from(t.paymentAttempts)
    .where(and(eq(t.paymentAttempts.provider, providerName), eq(t.paymentAttempts.providerPaymentId, parsed.providerPaymentId)));
  try {
    if (!attempt) throw new Error(`No payment for provider id ${parsed.providerPaymentId}`);
    await applyProviderState(deps, attempt.id, 'webhook', { webhookEventId: parsed.eventId, eventType: parsed.eventType });
    await deps.db.update(t.webhookEvents).set({ processedAt: new Date(), error: null }).where(eq(t.webhookEvents.id, stored!.id));
  } catch (error) {
    await deps.db.update(t.webhookEvents).set({ error: (error as Error).message }).where(eq(t.webhookEvents.id, stored!.id));
    // Unknown payment: acknowledge (the provider would retry forever). Provider errors: ask for a retry.
    if (!attempt) return { duplicate: false, ignored: true };
    throw new PaymentError(503, 'TRY_AGAIN', 'Could not verify the payment with the provider yet');
  }
  return { duplicate: false };
}

