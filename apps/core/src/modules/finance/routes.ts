import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../shared/request-context.js';
import { authOf, can, requireAuth } from '../identity/index.js';
import { assertNoConflictOfInterest, requireMembership } from '../merchants/index.js';
import { releaseMaturedBalances } from './posting.js';
import { runReconciliation } from './reconciliation.js';
import { storeCreditStatement } from './store-credit.js';
import { addCommissionRule, addSetting, listRules } from './rules.js';
import {
  createSettlement,
  listPayouts,
  listSettlements,
  merchantBalances,
  merchantStatement,
  recordProviderSettlement,
  trialBalance,
  updatePayout,
} from './settlements.js';
import { schema as s } from '@aruma/db';
import { desc, eq } from 'drizzle-orm';

const merchantParams = z.object({ merchantId: z.uuid() });

/** Merchants can read their finances; they can change nothing. Finance actions are for administrators. */
export async function financeRoutes(app: FastifyInstance) {
  const member = { preHandler: requireAuth };
  const actor = (req: FastifyRequest) => ({ ...actorFrom(req), userId: authOf(req).userId });
  const asMember = async (req: FastifyRequest) => {
    const { merchantId } = merchantParams.parse(req.params);
    // Money matters are for owners and managers, not all staff.
    await requireMembership(app.db, merchantId, authOf(req).userId, ['owner', 'manager']);
    return merchantId;
  };

  // --- Customer -----------------------------------------------------------------------------------------

  /** The customer's store credit: balance per currency and movements. */
  app.get('/v1/me/store-credit', member, async (req) => ({ data: await storeCreditStatement(app.db, authOf(req).userId) }));

  // --- Merchant (read-only) ------------------------------------------------------------------------
  app.get('/v1/merchants/:merchantId/finance/balance', member, async (req) => ({ data: await merchantBalances(app.db, await asMember(req)) }));
  app.get('/v1/merchants/:merchantId/finance/statement', member, async (req) => ({ data: await merchantStatement(app.db, await asMember(req)) }));
  app.get('/v1/merchants/:merchantId/finance/settlements', member, async (req) => ({ data: await listSettlements(app.db, await asMember(req)) }));
  app.get('/v1/merchants/:merchantId/finance/payouts', member, async (req) => ({ data: await listPayouts(app.db, { merchantId: await asMember(req) }) }));

  // --- Administration ------------------------------------------------------------------------------
  app.get('/v1/admin/finance/rules', can('finance.read', 'commission.manage'), async () => ({ data: await listRules(app.db) }));

  app.post('/v1/admin/finance/commission-rules', can('commission.manage'), async (req, reply) => {
    const body = z
      .object({
        storeId: z.uuid().optional(),
        bps: z.number().int().min(0).max(10000),
        effectiveFrom: z.iso.datetime().transform((v) => new Date(v)),
        reason: z.string().trim().min(3).max(500),
      })
      .parse(req.body);
    return reply.status(201).send({ data: await addCommissionRule(app.db, actorFrom(req), body) });
  });

  app.post('/v1/admin/finance/settings', can('finance.manage'), async (req, reply) => {
    const body = z
      .object({
        key: z.enum(['hold_days', 'order_fee_minor']),
        value: z.number().int().min(0).max(100_000_000),
        effectiveFrom: z.iso.datetime().transform((v) => new Date(v)),
        reason: z.string().trim().min(3).max(500),
      })
      .parse(req.body);
    return reply.status(201).send({ data: await addSetting(app.db, actorFrom(req), body) });
  });

  app.get('/v1/admin/finance/merchants/:merchantId', can('finance.read'), async (req) => {
    const { merchantId } = merchantParams.parse(req.params);
    return { data: { balances: await merchantBalances(app.db, merchantId), statement: await merchantStatement(app.db, merchantId) } };
  });

  app.post('/v1/admin/finance/release', can('finance.manage'), async () => ({ data: { released: await releaseMaturedBalances(app.db) } }));

  app.post('/v1/admin/finance/settlements', can('finance.manage'), async (req, reply) => {
    const body = z.object({ merchantId: z.uuid(), currency: z.string().length(3).toUpperCase() }).parse(req.body);
    await assertNoConflictOfInterest(app.db, authOf(req).userId, body.merchantId);
    return reply.status(201).send({ data: await createSettlement(app.db, actor(req), body.merchantId, body.currency) });
  });

  app.get('/v1/admin/finance/payouts', can('finance.read', 'payouts.manage'), async (req) => {
    const q = z.object({ merchantId: z.uuid().optional(), status: z.enum(['requested', 'sent', 'paid', 'failed']).optional() }).parse(req.query);
    return { data: await listPayouts(app.db, q) };
  });

  app.post('/v1/admin/finance/payouts/:payoutId/status', can('payouts.manage'), async (req) => {
    const { payoutId } = z.object({ payoutId: z.uuid() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(['sent', 'paid', 'failed']),
        externalReference: z.string().trim().min(1).max(128).optional(),
        reason: z.string().trim().min(3).max(500).optional(),
      })
      .parse(req.body);
    const [payout] = await app.db.select({ merchantId: s.payouts.merchantId }).from(s.payouts).where(eq(s.payouts.id, payoutId));
    if (payout) await assertNoConflictOfInterest(app.db, authOf(req).userId, payout.merchantId);
    return { data: await updatePayout(app.db, actor(req), payoutId, body) };
  });

  app.post('/v1/admin/finance/provider-settlements', can('finance.manage'), async (req, reply) => {
    const body = z
      .object({
        provider: z.string().trim().min(2).max(32),
        reference: z.string().trim().min(1).max(100),
        currency: z.string().length(3).toUpperCase(),
        grossMinor: z.number().int().positive(),
        feesMinor: z.number().int().min(0),
      })
      .parse(req.body);
    return reply.status(201).send({ data: await recordProviderSettlement(app.db, actor(req), body) });
  });

  app.get('/v1/admin/finance/store-credit/:userId', can('finance.read'), async (req) => {
    const { userId } = z.object({ userId: z.uuid() }).parse(req.params);
    return { data: await storeCreditStatement(app.db, userId) };
  });

  app.get('/v1/admin/finance/trial-balance', can('finance.read'), async () => ({ data: await trialBalance(app.db) }));

  app.post('/v1/admin/finance/reconciliation', can('finance.manage'), async (req, reply) => {
    const body = z.object({ from: z.iso.datetime(), to: z.iso.datetime() }).parse(req.body);
    return reply.status(201).send({ data: await runReconciliation(app.db, app.payments, actorFrom(req), new Date(body.from), new Date(body.to)) });
  });

  app.get('/v1/admin/finance/reconciliation', can('finance.read'), async () => ({
    data: await app.db.select().from(s.reconciliationRuns).orderBy(desc(s.reconciliationRuns.createdAt)).limit(50),
  }));
}
