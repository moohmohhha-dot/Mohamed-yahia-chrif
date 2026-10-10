import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Application-level encryption (AES-256-GCM) for sensitive data at rest: ID numbers, bank account
 * numbers, two-step verification secrets, courier credentials and every uploaded document.
 *
 * Format v2: 0x02 + key id (8 bytes) + 12-byte IV + 16-byte auth tag + ciphertext.
 * Format v1 (before key rotation existed): 0x01 + IV + tag + ciphertext, sealed with the first key.
 *
 * Key rotation: the new key becomes DATA_ENCRYPTION_KEY, the old ones go to DATA_ENCRYPTION_KEYS_OLD;
 * everything is then re-sealed with the new key (scripts/rotate-encryption-key.ts), after which the old
 * keys can be removed. New data is always sealed with the current key.
 */
export type SecretBox = {
  sealBytes(plain: Buffer): Buffer;
  openBytes(sealed: Buffer): Buffer;
  seal(plain: string): string;
  open(sealed: string): string;
  /** True when the value was sealed with an old key (the rotation script re-seals it). */
  needsRotation(sealed: Buffer): boolean;
};

const keyId = (key: Buffer) => createHash('sha256').update(key).digest().subarray(0, 8);

function parseKey(base64: string) {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== 32) throw new Error('Encryption keys must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

function decrypt(key: Buffer, iv: Buffer, tag: Buffer, body: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function createSecretBox(currentKeyBase64: string, oldKeysBase64: string[] = []): SecretBox {
  const keys = [currentKeyBase64, ...oldKeysBase64].map(parseKey);
  const current = keys[0]!;
  const currentId = keyId(current);
  const byId = new Map(keys.map((k) => [keyId(k).toString('hex'), k]));

  const sealBytes = (plain: Buffer) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', current, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([2]), currentId, iv, cipher.getAuthTag(), body]);
  };
  const openBytes = (sealed: Buffer) => {
    if (sealed[0] === 2) {
      const key = byId.get(sealed.subarray(1, 9).toString('hex'));
      if (!key) throw new Error('Sealed with an unknown key: add it to DATA_ENCRYPTION_KEYS_OLD');
      return decrypt(key, sealed.subarray(9, 21), sealed.subarray(21, 37), sealed.subarray(37));
    }
    if (sealed[0] === 1) {
      // No key id: try each key (the authentication tag tells the right one).
      for (const key of keys) {
        try {
          return decrypt(key, sealed.subarray(1, 13), sealed.subarray(13, 29), sealed.subarray(29));
        } catch {
          /* next key */
        }
      }
      throw new Error('No key opens this value');
    }
    throw new Error('Unknown secret format');
  };
  return {
    sealBytes,
    openBytes,
    seal: (plain) => sealBytes(Buffer.from(plain, 'utf8')).toString('base64'),
    open: (sealed) => openBytes(Buffer.from(sealed, 'base64')).toString('utf8'),
    needsRotation: (sealed) => !(sealed[0] === 2 && sealed.subarray(1, 9).equals(currentId)),
  };
}
