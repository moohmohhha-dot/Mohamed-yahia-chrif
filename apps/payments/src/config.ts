import { z } from 'zod';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PAYMENTS_DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(3200),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Public URL of this service (providers send webhooks and customers come back here). */
    PAYMENTS_PUBLIC_URL: z.string().url(),
    /** Shared secret ARUMA CORE uses to call this service (Authorization: Bearer …). At least 32 characters. */
    PAYMENTS_SERVICE_TOKEN: z.string().min(32),
    /** Where events are delivered, and the secret used to sign them (also known to ARUMA CORE). */
    CORE_EVENTS_URL: z.string().url(),
    PAYMENTS_EVENTS_SECRET: z.string().min(32),
    /** Online provider: chargily in real use; sandbox for local development only. */
    ONLINE_PROVIDER: z.enum(['chargily', 'sandbox']).default('sandbox'),
    CHARGILY_MODE: z.enum(['test', 'live']).default('test'),
    CHARGILY_SECRET_KEY: z.string().optional(),
    CHARGILY_AMOUNT_UNIT: z.enum(['major', 'minor']).default('major'),
  })
  .superRefine((v, ctx) => {
    if (v.ONLINE_PROVIDER === 'chargily' && !v.CHARGILY_SECRET_KEY) {
      ctx.addIssue({ code: 'custom', path: ['CHARGILY_SECRET_KEY'], message: 'Required when ONLINE_PROVIDER=chargily' });
    }
    if (v.NODE_ENV === 'production' && v.ONLINE_PROVIDER === 'sandbox') {
      ctx.addIssue({ code: 'custom', path: ['ONLINE_PROVIDER'], message: 'The sandbox cannot run in production' });
    }
    if (v.NODE_ENV === 'production' && v.CHARGILY_MODE !== 'live' && v.ONLINE_PROVIDER === 'chargily') {
      ctx.addIssue({ code: 'custom', path: ['CHARGILY_MODE'], message: 'Production must use Chargily live mode' });
    }
  });

export type PaymentsConfig = z.infer<typeof env>;
export const loadPaymentsConfig = (e: NodeJS.ProcessEnv = process.env) => env.parse(e);
