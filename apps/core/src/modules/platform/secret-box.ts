import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level encryption (AES-256-GCM) for sensitive data at rest:
 * ID numbers, bank account numbers, identity document files.
 * Format: v1 + 12-byte IV + 16-byte auth tag + ciphertext. The version byte allows key rotation later.
 */
export type SecretBox = {
  sealBytes(plain: Buffer): Buffer;
  openBytes(sealed: Buffer): Buffer;
  seal(plain: string): string;
  open(sealed: string): string;
};

const VERSION = 1;

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');

  const sealBytes = (plain: Buffer) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  };
  const openBytes = (sealed: Buffer) => {
    if (sealed[0] !== VERSION) throw new Error('Unknown secret format');
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13));
    decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  };
  return {
    sealBytes,
    openBytes,
    seal: (plain) => sealBytes(Buffer.from(plain, 'utf8')).toString('base64'),
    open: (sealed) => openBytes(Buffer.from(sealed, 'base64')).toString('utf8'),
  };
}
