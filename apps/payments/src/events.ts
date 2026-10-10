/**
 * Events from the payments service to its client (ARUMA CORE), written in the same transaction as the
 * change (outbox), then delivered with retries. Each delivery is signed:
 *   X-Aruma-Timestamp: <unix seconds>
 *   X-Aruma-Signature: hex HMAC-SHA256(PAYMENTS_EVENTS_SECRET, "<timestamp>.<raw body>")
 * The receiver rejects old timestamps (replay) and de-duplicates by event id.
 */
import { createHmac } from 'node:crypto';
import { and, asc, isNull, lte } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { PaymentsDb, PaymentsTx } from './db/client.js';
import * as t from './db/schema.js';

export async function enqueueEvent(tx: PaymentsTx, client: string, type: string, payload: Record<string, unknown>) {
  await tx.insert(t.outboundEvents).values({ client, type, payload });
}

export function signEvent(secret: string, timestamp: number, body: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Sends an HTTP request; injectable so tests can deliver in-process. */
export type Transport = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;

export const httpTransport: Transport = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', body, headers });
  return { status: res.status };
};

const BACKOFF_SECONDS = [10, 30, 60, 300, 900, 3600];

/** Delivers due events, oldest first. Returns how many were delivered. Run it every few seconds. */
export async function deliverEvents(
  db: PaymentsDb,
  targets: Record<string, { url: string; secret: string }>,
  transport: Transport,
  now = new Date(),
): Promise<number> {
  const due = await db
    .select()
    .from(t.outboundEvents)
    .where(and(isNull(t.outboundEvents.deliveredAt), lte(t.outboundEvents.nextAttemptAt, now)))
    .orderBy(asc(t.outboundEvents.createdAt))
    .limit(100);
  let delivered = 0;
  for (const event of due) {
    const target = targets[event.client];
    if (!target) continue;
    const body = JSON.stringify({ id: event.id, type: event.type, createdAt: event.createdAt, data: event.payload });
    const timestamp = Math.floor(Date.now() / 1000);
    let error: string | null = null;
    try {
      const res = await transport(target.url, body, {
        'content-type': 'application/json',
        'x-aruma-timestamp': String(timestamp),
        'x-aruma-signature': signEvent(target.secret, timestamp, body),
      });
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message;
    }
    const attempts = event.attempts + 1;
    await db
      .update(t.outboundEvents)
      .set(
        error
          ? { attempts, lastError: error, nextAttemptAt: new Date(now.getTime() + 1000 * BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!) }
          : { attempts, deliveredAt: new Date(), lastError: null },
      )
      .where(eq(t.outboundEvents.id, event.id));
    if (!error) delivered++;
    // Keep order per client: stop at the first failure so later events wait for earlier ones.
    else break;
  }
  return delivered;
}
