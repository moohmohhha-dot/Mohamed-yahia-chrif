import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://aruma:aruma@localhost:5432/aruma_test';

export const uniqueEmail = (prefix = 'user') => `${prefix}-${randomUUID().slice(0, 8)}@example.com`;

export async function registerUser(app: FastifyInstance, email = uniqueEmail(), headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers,
    payload: { email, password: 'correct horse battery', displayName: 'Test User', locale: 'ar', country: 'DZ' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const { data } = res.json();
  return { email, token: data.token as string, userId: data.user.id as string };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
