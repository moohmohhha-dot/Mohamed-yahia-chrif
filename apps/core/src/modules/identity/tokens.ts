import { createHash, randomBytes } from 'node:crypto';

/** Opaque session token handed to the client. Only its SHA-256 hash is stored. */
export const generateToken = () => `aru_${randomBytes(32).toString('base64url')}`;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
