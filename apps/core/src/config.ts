import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** true only behind a trusted reverse proxy (so the real client IP comes from X-Forwarded-For). */
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** 32 random bytes, base64. Generate with: openssl rand -base64 32. Losing it makes encrypted data unreadable. */
  DATA_ENCRYPTION_KEY: z.string().min(40),
  /** Directory for uploaded files (local storage driver). */
  STORAGE_DIR: z.string().default('./storage'),
  /** The independent Payment Service (apps/payments). */
  PAYMENTS_URL: z.string().url().default('http://localhost:3200'),
  /** Same value as PAYMENTS_SERVICE_TOKEN in the Payment Service. */
  PAYMENTS_SERVICE_TOKEN: z.string().min(32),
  /** Same value as PAYMENTS_EVENTS_SECRET in the Payment Service. */
  PAYMENTS_EVENTS_SECRET: z.string().min(32),
  /** Customer-facing store; customers come back here after paying online. */
  STOREFRONT_URL: z.string().url().default('http://localhost:5174'),
  /** Development only: registers the fake "sandbox" courier API (refused in production). */
  COURIER_SANDBOX: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Requests per IP per minute on every route. */
  GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  /** ARUMA staff must use two-step verification. Can be switched off only outside production (local tests). */
  STAFF_MFA_REQUIRED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Send Strict-Transport-Security: set to true when the API is served over HTTPS. */
  HSTS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Previous encryption keys (comma-separated), kept only to read data sealed before a key rotation. */
  DATA_ENCRYPTION_KEYS_OLD: z.string().default(''),
});

export type Config = z.infer<typeof envSchema>;

/** Values that are acceptable on a laptop but never on a production server. */
export function productionProblems(config: Config): string[] {
  if (config.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (!config.STAFF_MFA_REQUIRED) problems.push('STAFF_MFA_REQUIRED must be true');
  if (!config.HSTS) problems.push('HSTS must be true (serve the API over HTTPS only)');
  if (config.COURIER_SANDBOX) problems.push('COURIER_SANDBOX must be false');
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') problems.push('LOG_LEVEL must not be debug/trace');
  const localDb = /@(localhost|127\.0\.0\.1)[:/]/.test(config.DATABASE_URL);
  if (!localDb && !/sslmode=(require|verify-ca|verify-full)/.test(config.DATABASE_URL)) {
    problems.push('DATABASE_URL must use TLS (sslmode=require or verify-full) for a remote database');
  }
  if (!config.STOREFRONT_URL.startsWith('https://')) problems.push('STOREFRONT_URL must be https');
  const weak = (v: string) => new Set(v).size < 10;
  if (weak(config.PAYMENTS_SERVICE_TOKEN) || weak(config.PAYMENTS_EVENTS_SECRET)) problems.push('service secrets look weak: generate them with openssl rand -hex 32');
  return problems;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = envSchema.parse(env);
  const problems = productionProblems(config);
  if (problems.length) throw new Error(`Unsafe production configuration:\n- ${problems.join('\n- ')}`);
  return config;
}
