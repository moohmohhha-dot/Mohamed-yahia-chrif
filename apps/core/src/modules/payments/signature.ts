import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SECONDS = 300;

/** Checks an event from the Payment Service: HMAC-SHA256(secret, "<timestamp>.<raw body>") and a recent timestamp. */
export function verifyPaymentEvent(secret: string, rawBody: string, timestampHeader: unknown, signatureHeader: unknown, now = Date.now()) {
  if (typeof timestampHeader !== 'string' || typeof signatureHeader !== 'string' || !/^[0-9a-f]{64}$/.test(signatureHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp) || Math.abs(now / 1000 - timestamp) > MAX_AGE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
