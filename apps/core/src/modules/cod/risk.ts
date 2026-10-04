/**
 * Customer risk signals for cash on delivery, from the customer's COD history on ARUMA (by phone number
 * and by account, so a new account with the same phone keeps its history).
 *
 * Merchants see a level and the reasons, never which merchants or products were involved.
 * Score: +3 per refusal at the door, +2 per parcel returned after failed attempts, +1 per order the
 * customer declined or could not be reached for, +2 when the phone is used by several accounts, +2 with
 * 3 or more COD orders still open; −2 for a good history (3+ deliveries, no refusal).
 * Level: 5 and above = high, 2 to 4 = medium, below 2 = low.
 */
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { schema as s, type CodRisk } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import type { CodPolicy } from './policy.js';

export type CodHistory = {
  orders: number;
  delivered: number;
  refused: number;
  failed: number;
  declined: number;
  unreachable: number;
  open: number;
  accounts: number;
};

export type CustomerAssessment = CodRisk & {
  history: CodHistory;
  /** COD is not offered: blocked by ARUMA staff, or too many refusals under the store's policy. */
  blocked: boolean;
  blockReason: 'manual' | 'refusals' | null;
};

export async function codHistory(db: Executor, who: { phone: string; customerUserId?: string }, excludeOrderId?: string): Promise<CodHistory> {
  const n = (cond: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${cond})::int`;
  const [row] = await db
    .select({
      orders: sql<number>`count(*)::int`,
      delivered: n(sql`${s.codOrders.outcome} = 'delivered'`),
      refused: n(sql`${s.codOrders.outcome} = 'refused'`),
      failed: n(sql`${s.codOrders.outcome} = 'failed'`),
      declined: n(sql`${s.codOrders.confirmationStatus} = 'declined'`),
      unreachable: n(sql`${s.codOrders.confirmationStatus} = 'unreachable'`),
      open: n(sql`${s.codOrders.outcome} = 'open'`),
      accounts: sql<number>`count(distinct ${s.codOrders.customerUserId}) filter (where ${s.codOrders.phone} = ${who.phone})::int`,
    })
    .from(s.codOrders)
    .where(
      and(
        who.customerUserId ? or(eq(s.codOrders.phone, who.phone), eq(s.codOrders.customerUserId, who.customerUserId)) : eq(s.codOrders.phone, who.phone),
        excludeOrderId ? ne(s.codOrders.orderId, excludeOrderId) : undefined,
      ),
    );
  return row!;
}

export function scoreHistory(h: CodHistory, accountsWithPhone: number): CodRisk {
  const reasons: CodRisk['reasons'] = [];
  let score = 0;
  const add = (points: number, code: string, count?: number) => {
    score += points;
    reasons.push(count === undefined ? { code } : { code, count });
  };
  if (h.refused) add(3 * h.refused, 'previous_refusals', h.refused);
  if (h.failed) add(2 * h.failed, 'failed_deliveries', h.failed);
  if (h.declined) add(h.declined, 'declined_before', h.declined);
  if (h.unreachable) add(h.unreachable, 'unreachable_before', h.unreachable);
  if (accountsWithPhone > 1) add(2, 'shared_phone', accountsWithPhone);
  if (h.open >= 3) add(2, 'many_open_orders', h.open);
  if (h.delivered >= 3 && h.refused === 0) add(-2, 'good_history', h.delivered);
  if (h.orders === 0) reasons.push({ code: 'first_order' });
  const level = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { level, score, reasons };
}

export async function activeBlock(db: Executor, phone: string) {
  const [block] = await db.select().from(s.codBlocks).where(and(eq(s.codBlocks.phone, phone), isNull(s.codBlocks.liftedAt)));
  return block ?? null;
}

/** Risk level, reasons and whether COD may be offered to this customer under this policy. */
export async function assessCustomer(
  db: Executor,
  who: { phone: string; customerUserId?: string },
  policy: Pick<CodPolicy, 'blockAfterRefusals'>,
  excludeOrderId?: string,
): Promise<CustomerAssessment> {
  const history = await codHistory(db, who, excludeOrderId);
  // This order's account counts too when the phone is new to it.
  let accounts = history.accounts;
  if (who.customerUserId && history.accounts > 0) {
    const [mine] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.codOrders)
      .where(and(eq(s.codOrders.phone, who.phone), eq(s.codOrders.customerUserId, who.customerUserId), excludeOrderId ? ne(s.codOrders.orderId, excludeOrderId) : undefined));
    if (mine!.n === 0) accounts += 1;
  }
  const risk = scoreHistory(history, accounts);
  const manual = await activeBlock(db, who.phone);
  const tooManyRefusals = policy.blockAfterRefusals > 0 && history.refused >= policy.blockAfterRefusals;
  return { ...risk, history, blocked: Boolean(manual) || tooManyRefusals, blockReason: manual ? 'manual' : tooManyRefusals ? 'refusals' : null };
}
