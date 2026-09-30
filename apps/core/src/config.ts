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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
