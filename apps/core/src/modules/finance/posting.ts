/**
 * How money events become ledger entries.
 *
 * Example — order of 10 000 DZD, 8 % commission, paid online:
 *   paid       provider_clearing  +10 000   order_funds_held   +10 000
 *   delivered  order_funds_held   −10 000   merchant_pending   + 9 200   commission_revenue +800
 *   +7 days    merchant_pending   − 9 200   merchant_available + 9 200
 *   settlement merchant_available − 9 200   merchant_settled   + 9 200
 *   payout     merchant_settled   − 9 200   payouts_in_transit + 9 200 → bank − 9 200 (when confirmed)
 *
 * Cash on delivery: the merchant collected the 10 000 at the door, so the merchant owes ARUMA the
 * commission: merchant_pending −800 / commission_revenue +800 (netted against future payouts).
 *
 * Delivery price: with 10 000 of goods + 500 delivery, the commission is still 800 (8 % of the goods)
 * and the merchant is due 9 700.
 */
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Executor } from '../../shared/db.js';
import { move, postEntry, type Line } from './ledger.js';
import { getSetting, percentOf } from './rules.js';

type Order = typeof s.orders.$inferSelect;
const DAY_MS = 24 * 3600 * 1000;

/** Online payment received for an order (once per order). */
export async function postOrderPaid(db: Executor, order: Order) {
  if (order.paymentMethod !== 'online') return null;
  return postEntry(db, {
    kind: 'order_paid',
    sourceType: 'order',
    sourceId: order.id,
    currency: order.currency,
    merchantId: order.merchantId,
    orderId: order.id,
    description: `Payment received for order ${order.number}`,
    metadata: { amount: Number(order.totalMinor - order.creditAppliedMinor) },
    // Only the part paid with money: store credit spent on the order was moved in at checkout.
    lines: move(order.totalMinor - order.creditAppliedMinor, { purpose: 'provider_clearing' }, { purpose: 'order_funds_held' }),
  });
}

/** Sale recognized at delivery: merchant due, ARUMA commission and fee. Starts the hold period. */
export async function postOrderDelivered(db: Executor, order: Order, deliveredAt = new Date()) {
  // What the customer finally pays (refunds before delivery reduce it). The commission applies to the
  // goods only: the delivery price goes to the merchant, who pays the courier or delivers itself.
  const base = order.totalMinor - order.refundedMinor - order.creditReturnedMinor;
  const commissionable = base < order.subtotalMinor ? base : order.subtotalMinor;
  const commission = percentOf(commissionable, order.commissionBps);
  const fee = order.merchantFeeMinor;
  const due = base - commission - fee;
  const merchant = { purpose: 'merchant_pending' as const, merchantId: order.merchantId };

  const lines: Line[] =
    order.paymentMethod === 'online'
      ? [
          { purpose: 'order_funds_held', debit: base },
          ...(due >= 0n ? [{ ...merchant, credit: due }] : [{ ...merchant, debit: -due }]),
          { purpose: 'commission_revenue', credit: commission },
          { purpose: 'fee_revenue', credit: fee },
        ]
      : [
          // Cash on delivery: the merchant already holds the cash and owes ARUMA its share; the part
          // paid with store credit (held by ARUMA since checkout) is owed to the merchant.
          { purpose: 'order_funds_held', debit: order.creditAppliedMinor },
          ...(order.creditAppliedMinor >= commission + fee
            ? [{ ...merchant, credit: order.creditAppliedMinor - commission - fee }]
            : [{ ...merchant, debit: commission + fee - order.creditAppliedMinor }]),
          { purpose: 'commission_revenue', credit: commission },
          { purpose: 'fee_revenue', credit: fee },
        ];
  const entry = await postEntry(db, {
    kind: 'order_delivered',
    sourceType: 'order',
    sourceId: order.id,
    currency: order.currency,
    merchantId: order.merchantId,
    orderId: order.id,
    description: `Order ${order.number} delivered`,
    metadata: {
      base: Number(base),
      shipping: Number(order.shippingMinor),
      commissionable: Number(commissionable),
      commissionBps: order.commissionBps,
      commission: Number(commission),
      fee: Number(fee),
      due: Number(due),
      paymentMethod: order.paymentMethod,
      creditApplied: Number(order.creditAppliedMinor),
    },
    lines,
  });
  const holdDays = await getSetting(db, 'hold_days', deliveredAt);
  await db
    .insert(s.balanceHolds)
    .values({ orderId: order.id, merchantId: order.merchantId, currency: order.currency, availableAt: new Date(deliveredAt.getTime() + holdDays * DAY_MS) })
    .onConflictDoNothing();
  return entry;
}

/**
 * Money returned to the customer for an order (full or partial).
 * - Before delivery (online): the held funds go back to the provider.
 * - After delivery: the merchant and ARUMA give back their shares in proportion (the fee is kept).
 *   Online, the money leaves the provider account; for cash on delivery the merchant refunded the
 *   customer directly, so ARUMA credits back its commission share to the merchant.
 */
export async function postOrderRefund(
  db: Executor,
  order: Order,
  refund: { id: string; amountMinor: bigint; reason?: string | null },
  /** 'store_credit': the value goes to the customer's store credit instead of back through the provider. */
  to: 'provider' | 'store_credit' = 'provider',
) {
  const [delivered] = await db
    .select()
    .from(s.journalEntries)
    .where(and(eq(s.journalEntries.kind, 'order_delivered'), eq(s.journalEntries.sourceType, 'order'), eq(s.journalEntries.sourceId, order.id)));
  const R = refund.amountMinor;
  const toCredit = to === 'store_credit';
  const base = {
    kind: toCredit ? ('store_credit_issued' as const) : ('refund' as const),
    sourceType: toCredit ? 'store_credit' : 'payment_refund',
    sourceId: refund.id,
    currency: order.currency,
    merchantId: order.merchantId,
    orderId: order.id,
  };
  const destination = { purpose: toCredit ? ('store_credit' as const) : ('provider_clearing' as const) };

  if (!delivered) {
    if (order.paymentMethod !== 'online' && !toCredit) return null; // no money was taken
    return postEntry(db, {
      ...base,
      description: `${toCredit ? 'Store credit' : 'Refund'} before delivery, order ${order.number}`,
      metadata: { amount: Number(R), beforeDelivery: true, reason: refund.reason ?? null },
      lines: move(R, { purpose: 'order_funds_held' }, destination),
    });
  }

  const meta = delivered.metadata as { base: number; commission: number };
  const commissionShare = meta.base > 0 ? (R * BigInt(meta.commission) + BigInt(meta.base) / 2n) / BigInt(meta.base) : 0n;
  const merchantShare = R - commissionShare;
  // Lock the hold so a release cannot run between reading it and posting.
  const [hold] = await db.select().from(s.balanceHolds).where(eq(s.balanceHolds.orderId, order.id)).for('update');
  const merchantAccount = { purpose: hold?.releasedAt ? ('merchant_available' as const) : ('merchant_pending' as const), merchantId: order.merchantId };

  // Online, or any return given as store credit: the merchant and ARUMA give back their shares, which
  // leave through the provider (refund) or become credit ARUMA owes the customer. Cash on delivery
  // refunded in cash: the merchant paid the customer back, ARUMA returns its commission share.
  const lines: Line[] =
    order.paymentMethod === 'online' || toCredit
      ? [
          { ...merchantAccount, debit: merchantShare },
          { purpose: 'commission_revenue', debit: commissionShare },
          { ...destination, credit: R },
        ]
      : move(commissionShare, { purpose: 'commission_revenue' }, merchantAccount);
  return postEntry(db, {
    ...base,
    description: `${toCredit ? 'Store credit' : 'Refund'} for order ${order.number}`,
    metadata: { amount: Number(R), merchantShare: Number(merchantShare), commissionShare: Number(commissionShare), reason: refund.reason ?? null },
    lines,
  });
}

/** Ends the hold period of delivered orders: their net pending amount becomes available. */
export async function releaseMaturedBalances(db: Database, now = new Date()) {
  const due = await db
    .select({ orderId: s.balanceHolds.orderId })
    .from(s.balanceHolds)
    .where(and(isNull(s.balanceHolds.releasedAt), lte(s.balanceHolds.availableAt, now)));
  let released = 0;
  for (const { orderId } of due) {
    await db.transaction(async (tx) => {
      const [hold] = await tx.select().from(s.balanceHolds).where(eq(s.balanceHolds.orderId, orderId)).for('update');
      if (!hold || hold.releasedAt) return;
      const [net] = await tx
        .select({ value: sql<string>`coalesce(sum(${s.journalLines.creditMinor} - ${s.journalLines.debitMinor}), 0)::text` })
        .from(s.journalLines)
        .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.journalLines.accountId))
        .where(and(eq(s.journalLines.orderId, orderId), eq(s.ledgerAccounts.purpose, 'merchant_pending')));
      const amount = BigInt(net!.value);
      const merchant = { merchantId: hold.merchantId, orderId };
      await postEntry(tx, {
        kind: 'balance_release',
        sourceType: 'order',
        sourceId: orderId,
        currency: hold.currency,
        merchantId: hold.merchantId,
        orderId,
        description: 'Hold period ended',
        metadata: { amount: Number(amount) },
        lines: move(amount, { purpose: 'merchant_pending', ...merchant }, { purpose: 'merchant_available', ...merchant }),
      });
      await tx.update(s.balanceHolds).set({ releasedAt: now }).where(eq(s.balanceHolds.orderId, orderId));
      released++;
    });
  }
  return released;
}
