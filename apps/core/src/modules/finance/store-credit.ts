/**
 * Store credit: value ARUMA owes a customer, spendable on any later order in the same currency.
 *
 * - Issued when a return is resolved with credit: the merchant and ARUMA give back their shares exactly
 *   as for a refund, but the value becomes credit instead of leaving through the payment provider.
 * - Spent at checkout: the credit pays part (or all) of the order; ARUMA holds it like an online payment
 *   until delivery.
 * - Restored when an order paid with credit is cancelled before delivery.
 *
 * Each change is a row in store_credit_transactions (append-only) and a ledger entry; the reconciliation
 * checks that the customers' balances equal the store credit liability in the ledger.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { move, postEntry } from './ledger.js';
import { postOrderRefund } from './posting.js';

type Order = typeof s.orders.$inferSelect;
type Kind = (typeof s.storeCreditKind.enumValues)[number];

export async function storeCreditBalance(db: Executor, customerUserId: string, currency: string, lock = false): Promise<bigint> {
  await db.insert(s.storeCreditAccounts).values({ customerUserId, currency }).onConflictDoNothing();
  const query = db
    .select({ balance: s.storeCreditAccounts.balanceMinor })
    .from(s.storeCreditAccounts)
    .where(and(eq(s.storeCreditAccounts.customerUserId, customerUserId), eq(s.storeCreditAccounts.currency, currency)));
  const [row] = lock ? await query.for('update') : await query;
  return row?.balance ?? 0n;
}

async function moveCredit(
  db: Executor,
  input: { customerUserId: string; currency: string; amountMinor: bigint; kind: Kind; orderId?: string | null; sourceType?: string; sourceId?: string; note?: string; createdBy?: string | null },
) {
  const balance = await storeCreditBalance(db, input.customerUserId, input.currency, true);
  const after = balance + input.amountMinor;
  if (after < 0n) throw new AppError(409, 'INSUFFICIENT_CREDIT', 'Not enough store credit', { balanceMinor: Number(balance) });
  await db.insert(s.storeCreditTransactions).values({
    customerUserId: input.customerUserId,
    currency: input.currency,
    kind: input.kind,
    amountMinor: input.amountMinor,
    balanceAfterMinor: after,
    orderId: input.orderId ?? null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    note: input.note ?? null,
    createdBy: input.createdBy ?? null,
  });
  await db
    .update(s.storeCreditAccounts)
    .set({ balanceMinor: after, updatedAt: new Date() })
    .where(and(eq(s.storeCreditAccounts.customerUserId, input.customerUserId), eq(s.storeCreditAccounts.currency, input.currency)));
  return after;
}

/** At checkout (inside its transaction): the credit applied to a new order leaves the customer's balance. */
export async function spendStoreCredit(db: Executor, order: Order) {
  if (order.creditAppliedMinor <= 0n) return;
  await moveCredit(db, { customerUserId: order.customerUserId, currency: order.currency, amountMinor: -order.creditAppliedMinor, kind: 'used', orderId: order.id });
  await postEntry(db, {
    kind: 'store_credit_used',
    sourceType: 'order',
    sourceId: order.id,
    currency: order.currency,
    merchantId: order.merchantId,
    orderId: order.id,
    description: `Store credit spent on order ${order.number}`,
    metadata: { amount: Number(order.creditAppliedMinor) },
    lines: move(order.creditAppliedMinor, { purpose: 'store_credit' }, { purpose: 'order_funds_held' }),
  });
}

/** Order cancelled before delivery: the credit spent on it goes back to the customer. Returns the order. */
export async function restoreStoreCredit(db: Executor, order: Order, actorUserId: string | null): Promise<Order> {
  const amount = order.creditAppliedMinor - order.creditReturnedMinor;
  if (amount <= 0n) return order;
  await moveCredit(db, { customerUserId: order.customerUserId, currency: order.currency, amountMinor: amount, kind: 'restored', orderId: order.id, createdBy: actorUserId, note: `Order ${order.number} cancelled` });
  await postEntry(db, {
    kind: 'store_credit_restored',
    sourceType: 'order',
    sourceId: order.id,
    currency: order.currency,
    merchantId: order.merchantId,
    orderId: order.id,
    description: `Store credit given back, order ${order.number} cancelled`,
    metadata: { amount: Number(amount) },
    lines: move(amount, { purpose: 'order_funds_held' }, { purpose: 'store_credit' }),
  });
  const [updated] = await db
    .update(s.orders)
    .set({ creditReturnedMinor: sql`${s.orders.creditReturnedMinor} + ${amount}` })
    .where(eq(s.orders.id, order.id))
    .returning();
  return updated!;
}

/**
 * Gives value back to the customer as store credit for a delivered order (a return resolved with
 * credit). `sourceId` identifies the event (the return), so it is issued once.
 */
export async function issueStoreCredit(db: Executor, order: Order, input: { amountMinor: bigint; sourceType: string; sourceId: string; reason: string; actorUserId: string | null }) {
  // Once per source (e.g. per return): issuing again changes nothing.
  const [already] = await db
    .select({ id: s.storeCreditTransactions.id })
    .from(s.storeCreditTransactions)
    .where(and(eq(s.storeCreditTransactions.sourceType, input.sourceType), eq(s.storeCreditTransactions.sourceId, input.sourceId), eq(s.storeCreditTransactions.kind, 'issued')));
  if (already) return order;
  const returnable = order.totalMinor - order.refundedMinor - order.creditReturnedMinor;
  if (input.amountMinor <= 0n || input.amountMinor > returnable) {
    throw new AppError(409, 'CREDIT_EXCEEDS_ORDER', `At most ${returnable} can be given back for this order`, { returnableMinor: Number(returnable) });
  }
  await postOrderRefund(db, order, { id: input.sourceId, amountMinor: input.amountMinor, reason: input.reason }, 'store_credit');
  await moveCredit(db, {
    customerUserId: order.customerUserId,
    currency: order.currency,
    amountMinor: input.amountMinor,
    kind: 'issued',
    orderId: order.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    note: input.reason,
    createdBy: input.actorUserId,
  });
  const [updated] = await db
    .update(s.orders)
    .set({ creditReturnedMinor: sql`${s.orders.creditReturnedMinor} + ${input.amountMinor}` })
    .where(eq(s.orders.id, order.id))
    .returning();
  return updated!;
}

/** The customer's balances and movements. */
export async function storeCreditStatement(db: Executor, customerUserId: string) {
  const [accounts, movements] = [
    await db.select().from(s.storeCreditAccounts).where(eq(s.storeCreditAccounts.customerUserId, customerUserId)),
    await db
      .select({
        id: s.storeCreditTransactions.id,
        kind: s.storeCreditTransactions.kind,
        currency: s.storeCreditTransactions.currency,
        amountMinor: s.storeCreditTransactions.amountMinor,
        balanceAfterMinor: s.storeCreditTransactions.balanceAfterMinor,
        orderNumber: s.orders.number,
        note: s.storeCreditTransactions.note,
        createdAt: s.storeCreditTransactions.createdAt,
      })
      .from(s.storeCreditTransactions)
      .leftJoin(s.orders, eq(s.orders.id, s.storeCreditTransactions.orderId))
      .where(eq(s.storeCreditTransactions.customerUserId, customerUserId))
      .orderBy(desc(s.storeCreditTransactions.createdAt))
      .limit(100),
  ];
  return {
    balances: accounts.map((a) => ({ currency: a.currency, balanceMinor: Number(a.balanceMinor) })),
    movements: movements.map((m) => ({ ...m, amountMinor: Number(m.amountMinor), balanceAfterMinor: Number(m.balanceAfterMinor) })),
  };
}
