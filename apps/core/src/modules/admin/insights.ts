/** The Admin Panel's home (work waiting for ARUMA, key numbers), analytics and payments. All from real data. */
import { and, desc, eq, gte, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { schema as s, type Database } from '@aruma/db';
import type { AuthContext, Permission } from '../identity/index.js';

const count = sql<number>`count(*)::int`;
const DAY = 24 * 3600_000;

async function n(db: Database, table: PgTable, where?: SQL) {
  const [row] = await db.select({ n: count }).from(table).where(where);
  return row?.n ?? 0;
}

/** Work waiting for ARUMA, each queue shown only to staff who can act on it. */
export async function overview(db: Database, viewer: AuthContext) {
  const has = (p: Permission) => viewer.permissions.has(p);
  const since7 = new Date(Date.now() - 7 * DAY);
  const queues: { key: string; section: string; count: number }[] = [];
  const queue = async (key: string, section: string, permission: Permission, value: () => Promise<number>) => {
    if (has(permission)) queues.push({ key, section, count: await value() });
  };
  await queue('verifications', 'verification', 'verification.review', () => n(db, s.merchants, eq(s.merchants.verificationStatus, 'under_review')));
  await queue('returnsToDecide', 'returns', 'returns.decide', () => n(db, s.returnRequests, eq(s.returnRequests.status, 'under_review')));
  await queue('disputesToDecide', 'disputes', 'disputes.read', () => n(db, s.disputes, inArray(s.disputes.status, ['under_review', 'appealed'])));
  await queue('disputesOpen', 'disputes', 'disputes.read', () => n(db, s.disputes, eq(s.disputes.status, 'open')));
  await queue('reviewsPending', 'reviews', 'reviews.moderate', () => n(db, s.reviews, eq(s.reviews.status, 'pending')));
  await queue('reviewReports', 'reviews', 'reviews.moderate', () => n(db, s.reviewReports, eq(s.reviewReports.status, 'open')));
  await queue('refundsToSend', 'payments', 'refunds.execute', async () =>
    (await n(db, s.returnRequests, eq(s.returnRequests.status, 'refund_pending'))) + (await n(db, s.disputes, eq(s.disputes.executionStatus, 'pending'))),
  );
  await queue('payoutsToSend', 'payouts', 'payouts.manage', () => n(db, s.payouts, inArray(s.payouts.status, ['requested', 'sent'])));
  await queue('codToConfirm', 'orders', 'orders.manage', () => n(db, s.codOrders, eq(s.codOrders.confirmationStatus, 'pending')));
  await queue('blockedProducts', 'products', 'catalog.moderate', () => n(db, s.products, isNotNull(s.products.blockedAt)));
  await queue('suspendedUsers', 'users', 'users.manage', () => n(db, s.users, eq(s.users.status, 'suspended')));

  const numbers: Record<string, unknown> = {};
  if (has('users.read')) numbers.users = { total: await n(db, s.users), new7d: await n(db, s.users, gte(s.users.createdAt, since7)) };
  if (has('merchants.read')) {
    const rows = await db.select({ status: s.merchants.verificationStatus, n: count }).from(s.merchants).groupBy(s.merchants.verificationStatus);
    numbers.merchants = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
  if (has('orders.read')) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    numbers.orders = {
      today: await n(db, s.orders, gte(s.orders.placedAt, today)),
      last7d: await n(db, s.orders, gte(s.orders.placedAt, since7)),
      inProgress: await n(db, s.orders, inArray(s.orders.status, ['new', 'processing', 'preparing', 'shipping'])),
    };
  }
  if (has('analytics.read') || has('finance.read')) {
    const rows = await db
      .select({ currency: s.orders.currency, totalMinor: sql<string>`sum(${s.orders.totalMinor})::text`, n: count })
      .from(s.orders)
      .where(and(gte(s.orders.placedAt, since7), ne(s.orders.status, 'cancelled')))
      .groupBy(s.orders.currency);
    numbers.sales7d = rows.map((r) => ({ currency: r.currency, totalMinor: Number(r.totalMinor), orders: r.n }));
  }
  return { queues, numbers };
}

/** Daily figures for the last `days` days (orders placed and not cancelled; amounts per currency, never mixed). */
export async function analytics(db: Database, days: number) {
  const from = new Date(new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10));
  const daily = await db.execute<{ day: string; currency: string | null; orders: number; total_minor: string | null; cancelled: number }>(sql`
    select to_char(d.day, 'YYYY-MM-DD') as day, o.currency,
           count(o.id) filter (where o.status <> 'cancelled')::int as orders,
           coalesce(sum(o.total_minor) filter (where o.status <> 'cancelled'), 0)::text as total_minor,
           count(o.id) filter (where o.status = 'cancelled')::int as cancelled
    from generate_series(${from.toISOString()}::date, current_date, interval '1 day') as d(day)
    left join orders o on o.placed_at >= d.day and o.placed_at < d.day + interval '1 day'
    group by d.day, o.currency order by d.day`);
  const signups = await db.execute<{ day: string; users: number; merchants: number }>(sql`
    select to_char(d.day, 'YYYY-MM-DD') as day,
           (select count(*) from users u where u.created_at >= d.day and u.created_at < d.day + interval '1 day')::int as users,
           (select count(*) from merchants m where m.created_at >= d.day and m.created_at < d.day + interval '1 day')::int as merchants
    from generate_series(${from.toISOString()}::date, current_date, interval '1 day') as d(day) order by d.day`);
  const inPeriod = gte(s.orders.placedAt, from);
  const [byStatus, byMethod, topMerchants, refunds] = [
    await db.select({ status: s.orders.status, n: count }).from(s.orders).where(inPeriod).groupBy(s.orders.status),
    await db.select({ method: s.orders.paymentMethod, n: count }).from(s.orders).where(inPeriod).groupBy(s.orders.paymentMethod),
    await db
      .select({ merchantId: s.orders.merchantId, name: s.merchants.name, currency: s.orders.currency, orders: count, totalMinor: sql<string>`sum(${s.orders.totalMinor})::text` })
      .from(s.orders)
      .innerJoin(s.merchants, eq(s.merchants.id, s.orders.merchantId))
      .where(and(inPeriod, ne(s.orders.status, 'cancelled')))
      .groupBy(s.orders.merchantId, s.merchants.name, s.orders.currency)
      .orderBy(desc(sql`sum(${s.orders.totalMinor})`))
      .limit(10),
    await db.select({ currency: s.orders.currency, refundedMinor: sql<string>`sum(${s.orders.refundedMinor})::text` }).from(s.orders).where(inPeriod).groupBy(s.orders.currency),
  ];
  const days_: Record<string, { day: string; users: number; merchants: number; orders: number; cancelled: number; sales: Record<string, number> }> = {};
  for (const r of signups.rows) days_[r.day] = { day: r.day, users: r.users, merchants: r.merchants, orders: 0, cancelled: 0, sales: {} };
  for (const r of daily.rows) {
    const d = days_[r.day];
    if (!d || !r.currency) continue;
    d.orders += r.orders;
    d.cancelled += r.cancelled;
    d.sales[r.currency] = (d.sales[r.currency] ?? 0) + Number(r.total_minor);
  }
  return {
    from,
    days: Object.values(days_),
    ordersByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    ordersByPaymentMethod: Object.fromEntries(byMethod.map((r) => [r.method, r.n])),
    topMerchants: topMerchants.map((m) => ({ ...m, totalMinor: Number(m.totalMinor) })),
    refunded: refunds.map((r) => ({ currency: r.currency, refundedMinor: Number(r.refundedMinor) })),
  };
}

/** Payments as recorded on orders (the Payment Service keeps the provider side; card data never reaches ARUMA). */
export async function listPayments(db: Database, q: { status?: 'pending' | 'successful' | 'failed' | 'cancelled' | 'refunded'; method?: 'cash_on_delivery' | 'online'; q?: string; page: number; pageSize: number }) {
  const where: SQL[] = [];
  if (q.status) where.push(eq(s.orders.paymentStatus, q.status));
  if (q.method) where.push(eq(s.orders.paymentMethod, q.method));
  if (q.q) where.push(eq(s.orders.number, q.q.trim()));
  const rows = await db
    .select({
      orderId: s.orders.id,
      number: s.orders.number,
      merchantName: s.merchants.name,
      status: s.orders.status,
      method: s.orders.paymentMethod,
      paymentStatus: s.orders.paymentStatus,
      paymentIntentId: s.orders.paymentIntentId,
      currency: s.orders.currency,
      totalMinor: s.orders.totalMinor,
      creditAppliedMinor: s.orders.creditAppliedMinor,
      refundedMinor: s.orders.refundedMinor,
      placedAt: s.orders.placedAt,
    })
    .from(s.orders)
    .innerJoin(s.merchants, eq(s.merchants.id, s.orders.merchantId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.orders.placedAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const summary = await db
    .select({ method: s.orders.paymentMethod, status: s.orders.paymentStatus, currency: s.orders.currency, n: count, totalMinor: sql<string>`sum(${s.orders.totalMinor} - ${s.orders.creditAppliedMinor})::text`, refundedMinor: sql<string>`sum(${s.orders.refundedMinor})::text` })
    .from(s.orders)
    .groupBy(s.orders.paymentMethod, s.orders.paymentStatus, s.orders.currency);
  return {
    summary: summary.map((r) => ({ ...r, totalMinor: Number(r.totalMinor), refundedMinor: Number(r.refundedMinor) })),
    payments: rows.map((r) => ({ ...r, totalMinor: Number(r.totalMinor), creditAppliedMinor: Number(r.creditAppliedMinor), refundedMinor: Number(r.refundedMinor), amountDueMinor: Number(r.totalMinor - r.creditAppliedMinor) })),
  };
}
