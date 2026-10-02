/**
 * Reconciliation: checks that the ledger agrees with itself, with the orders, and with the Payment
 * Service (the record of real money received and returned). Every run is stored with its findings.
 * Bank statements are reconciled through payouts ("paid" requires the bank reference) and provider
 * settlements (recorded with the provider's reference and fees).
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Actor } from '../../shared/request-context.js';
import type { PaymentsClient } from '../payments/index.js';
import { audit } from '../platform/index.js';

type Discrepancy = { check: string; reference: string; expected?: number; actual?: number; detail: string };

export async function runReconciliation(db: Database, payments: PaymentsClient, actor: Actor, from: Date, to: Date) {
  const discrepancies: Discrepancy[] = [];

  // 1. The ledger balances: every entry, and every currency overall.
  const unbalanced = await db.execute<{ entry_id: string; d: string; c: string }>(sql`
    select entry_id, sum(debit_minor)::text as d, sum(credit_minor)::text as c
    from journal_lines group by entry_id having sum(debit_minor) <> sum(credit_minor)`);
  for (const r of unbalanced.rows) discrepancies.push({ check: 'entry_balanced', reference: r.entry_id, expected: Number(r.d), actual: Number(r.c), detail: 'Debits and credits differ' });

  // Ledger entries per order and kind, for the period's orders.
  const periodOrders = await db.select().from(s.orders).where(and(gte(s.orders.placedAt, from), lt(s.orders.placedAt, to)));
  const ids = periodOrders.map((o) => o.id);
  const entries = ids.length
    ? await db.select().from(s.journalEntries).where(inArray(s.journalEntries.orderId, ids))
    : [];
  const entry = (orderId: string, kind: string) => entries.find((e) => e.orderId === orderId && e.kind === kind);
  const refundEntries = (orderId: string) => entries.filter((e) => e.orderId === orderId && e.kind === 'refund');
  const deliveredIds = new Set(
    ids.length
      ? (await db.select({ orderId: s.orderStatusHistory.orderId }).from(s.orderStatusHistory).where(and(inArray(s.orderStatusHistory.orderId, ids), eq(s.orderStatusHistory.toStatus, 'delivered')))).map((r) => r.orderId)
      : [],
  );
  const orderRefunds = ids.length ? await db.select().from(s.orderRefunds).where(inArray(s.orderRefunds.orderId, ids)) : [];

  // 2. Orders ⇄ ledger.
  for (const order of periodOrders) {
    const paid = order.paymentStatus === 'successful' || order.paymentStatus === 'refunded';
    if (order.paymentMethod === 'online' && paid) {
      const e = entry(order.id, 'order_paid');
      if (!e) discrepancies.push({ check: 'order_paid_posted', reference: order.number, expected: Number(order.totalMinor), detail: 'Paid online order without a payment entry' });
      else if ((e.metadata as { amount: number }).amount !== Number(order.totalMinor)) {
        discrepancies.push({ check: 'order_paid_amount', reference: order.number, expected: Number(order.totalMinor), actual: (e.metadata as { amount: number }).amount, detail: 'Payment entry amount differs from the order' });
      }
    }
    if (deliveredIds.has(order.id) && !entry(order.id, 'order_delivered')) {
      discrepancies.push({ check: 'order_delivered_posted', reference: order.number, detail: 'Delivered order without a sale entry' });
    }
    const refunded = orderRefunds.filter((r) => r.orderId === order.id).reduce((n, r) => n + r.amountMinor, 0n);
    const posted = refundEntries(order.id).reduce((n, e) => n + BigInt((e.metadata as { amount: number }).amount), 0n);
    if (refunded !== posted) {
      discrepancies.push({ check: 'refunds_posted', reference: order.number, expected: Number(refunded), actual: Number(posted), detail: 'Refunds on the order and in the ledger differ' });
    }
    if (order.status === 'cancelled' && order.paymentMethod === 'online' && paid && order.refundedMinor < order.totalMinor) {
      discrepancies.push({ check: 'cancelled_paid_not_refunded', reference: order.number, expected: Number(order.totalMinor), actual: Number(order.refundedMinor), detail: 'Cancelled order was paid and not fully refunded' });
    }
  }

  // 3. Payment Service (real money) ⇄ ledger.
  const report = await payments.reconciliation(from, to);
  for (const intent of report) {
    const related = intent.referenceType === 'checkout' ? periodOrders.filter((o) => o.checkoutId === intent.referenceId) : periodOrders.filter((o) => o.id === intent.referenceId);
    if (related.length === 0) {
      discrepancies.push({ check: 'payment_without_order', reference: intent.id, actual: intent.amountMinor, detail: `No order in this period for ${intent.referenceType} ${intent.referenceId}` });
      continue;
    }
    if (intent.method === 'online') {
      const ledgerPaid = related.reduce((n, o) => n + ((entry(o.id, 'order_paid')?.metadata as { amount?: number })?.amount ?? 0), 0);
      if (ledgerPaid !== intent.amountMinor) discrepancies.push({ check: 'payment_amount', reference: intent.id, expected: intent.amountMinor, actual: ledgerPaid, detail: 'Money received differs from the ledger' });
    } else if (!related.every((o) => entry(o.id, 'order_delivered'))) {
      discrepancies.push({ check: 'cash_collected_posted', reference: intent.id, detail: 'Cash collected but the sale is not in the ledger' });
    }
    const ledgerRefunded = related.reduce((n, o) => n + refundEntries(o.id).reduce((m, e) => m + (e.metadata as { amount: number }).amount, 0), 0);
    if (ledgerRefunded !== intent.refundedMinor) {
      discrepancies.push({ check: 'refund_amount', reference: intent.id, expected: intent.refundedMinor, actual: ledgerRefunded, detail: 'Money returned differs from the ledger' });
    }
  }
  const reported = new Set(report.map((i) => i.referenceId));
  for (const order of periodOrders) {
    const ref = order.paymentMethod === 'online' ? order.checkoutId : order.id;
    if (entry(order.id, 'order_paid') && !reported.has(ref)) {
      discrepancies.push({ check: 'ledger_payment_unknown', reference: order.number, detail: 'The ledger records a payment the Payment Service does not report' });
    }
  }

  const summary = {
    orders: periodOrders.length,
    payments: report.length,
    receivedMinor: report.reduce((n, i) => n + i.amountMinor, 0),
    refundedMinor: report.reduce((n, i) => n + i.refundedMinor, 0),
  };
  const [run] = await db
    .insert(s.reconciliationRuns)
    .values({ balanced: discrepancies.length === 0, periodFrom: from, periodTo: to, summary, discrepancies, createdBy: actor.userId })
    .returning();
  await audit(db, actor, { action: 'finance.reconciliation.run', entityType: 'reconciliation_run', entityId: run!.id, metadata: { balanced: run!.balanced, discrepancies: discrepancies.length } });
  return run!;
}
