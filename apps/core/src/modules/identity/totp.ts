/**
 * Time-based one-time passwords (RFC 6238 / RFC 4226): HMAC-SHA1, 6 digits, 30-second steps — what every
 * authenticator app uses. Implemented with node:crypto only; no external service, nothing to pay.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
/** Accept the previous and next step too (clock drift of a phone). */
const WINDOW = 1;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (the form authenticator apps expect). */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepAt = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, '0');
}

/**
 * The step a code belongs to, or null. A step at or before `lastUsedStep` is refused, so an intercepted
 * code cannot be used again.
 */
export function verifyTotp(secret: string, code: string, lastUsedStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** otpauth:// link: authenticator apps add the account from it (or from its QR code). */
export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`ARUMA:${account}`)}?secret=${secret}&issuer=ARUMA&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
