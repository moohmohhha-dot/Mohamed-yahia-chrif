/**
 * Merchant insights: sales analysis, demand prediction, pricing and promotion suggestions.
 * Everything is computed from the merchant's own orders and offers (rules and statistics, no AI needed).
 * With AI switched on, a short written analysis is added; it is given only these totals (no customer
 * name, phone or address).
 *
 * All of it is ADVICE. Nothing here changes a price, a stock level or a promotion: the merchant decides
 * and acts in the normal screens (offers, stock), where the usual permissions and records apply.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@aruma/db';
import { requireMembership } from '../merchants/index.js';
import { answerIn, data, type AiLayer } from './gateway.js';

/** Days of sales used to predict demand. */
const DEMAND_WINDOW = 28;
/** Reorder to cover this many days. */
const COVER_DAYS = 30;

const analysisSchema = z.object({
  headline: z.string().min(1).max(200),
  points: z.array(z.string().min(1).max(240)).max(5),
  actions: z.array(z.string().min(1).max(240)).max(3),
});

type Options = { days: number; currency: string; locale: string };

const name = (names: Record<string, string> | null, locale: string, fallback: string) => (names ? (names[locale] ?? names.fr ?? names.ar ?? Object.values(names)[0]) : null) ?? fallback;

export async function salesAnalysis(db: Database, merchantId: string, o: Options) {
  const period = (from: number, to: number) => sql`o.placed_at > now() - make_interval(days => ${from}) and o.placed_at <= now() - make_interval(days => ${to})`;
  const totals = async (from: number, to: number) => {
    const { rows } = await db.execute<{ orders: number; cancelled: number; returned: number; revenue: string; units: number }>(sql`
      select count(*) filter (where o.status <> 'cancelled')::int as orders,
             count(*) filter (where o.status = 'cancelled')::int as cancelled,
             count(*) filter (where o.status in ('returned', 'refunded'))::int as returned,
             coalesce(sum(o.subtotal_minor) filter (where o.status not in ('cancelled', 'returned', 'refunded')), 0)::text as revenue,
             coalesce((select sum(l.quantity) from order_lines l join orders o2 on o2.id = l.order_id
                       where o2.merchant_id = ${merchantId} and o2.currency = ${o.currency} and o2.status <> 'cancelled'
                         and o2.placed_at > now() - make_interval(days => ${from}) and o2.placed_at <= now() - make_interval(days => ${to})), 0)::int as units
      from orders o where o.merchant_id = ${merchantId} and o.currency = ${o.currency} and ${period(from, to)}`);
    const r = rows[0]!;
    return { orders: r.orders, cancelled: r.cancelled, returned: r.returned, revenueMinor: Number(r.revenue), units: r.units, averageOrderMinor: r.orders ? Math.round(Number(r.revenue) / r.orders) : 0 };
  };
  const current = await totals(o.days, 0);
  const previous = await totals(o.days * 2, o.days);
  const byDay = await db.execute<{ day: string; orders: number; revenue: string }>(sql`
    select to_char(d.day, 'YYYY-MM-DD') as day, count(o.id)::int as orders, coalesce(sum(o.subtotal_minor), 0)::text as revenue
    from generate_series(date_trunc('day', now()) - make_interval(days => ${o.days - 1}), date_trunc('day', now()), interval '1 day') d(day)
    left join orders o on o.merchant_id = ${merchantId} and o.currency = ${o.currency} and o.status not in ('cancelled', 'returned', 'refunded')
      and o.placed_at >= d.day and o.placed_at < d.day + interval '1 day'
    group by d.day order by d.day`);
  const top = await db.execute<{ sku: string; names: Record<string, string>; units: number; revenue: string }>(sql`
    select l.sku, (array_agg(l.product_names))[1] as names, sum(l.quantity)::int as units, sum(l.line_total_minor)::text as revenue
    from order_lines l join orders o on o.id = l.order_id
    where o.merchant_id = ${merchantId} and o.currency = ${o.currency} and o.status not in ('cancelled', 'returned', 'refunded')
      and o.placed_at > now() - make_interval(days => ${o.days})
    group by l.sku order by units desc, l.sku limit 10`);
  return {
    current,
    previous,
    change: {
      revenuePct: previous.revenueMinor ? Math.round(((current.revenueMinor - previous.revenueMinor) / previous.revenueMinor) * 100) : null,
      ordersPct: previous.orders ? Math.round(((current.orders - previous.orders) / previous.orders) * 100) : null,
    },
    cancellationRatePct: current.orders + current.cancelled ? Math.round((current.cancelled / (current.orders + current.cancelled)) * 100) : 0,
    byDay: byDay.rows.map((r) => ({ day: r.day, orders: r.orders, revenueMinor: Number(r.revenue) })),
    topProducts: top.rows.map((r) => ({ sku: r.sku, name: name(r.names, o.locale, r.sku), units: r.units, revenueMinor: Number(r.revenue) })),
  };
}

/** Per active offer: stock, recent sales, days of stock left, how much to reorder. */
export async function demandForecast(db: Database, merchantId: string, locale: string) {
  const { rows } = await db.execute<{ offer_id: string; sku: string; names: Record<string, string> | null; available: number; sold: number; first_sale: string | null }>(sql`
    select f.id as offer_id, f.sku, (select jsonb_object_agg(t.locale, t.name) from product_translations t where t.product_id = v.product_id) as names,
           f.available_quantity as available,
           coalesce((select sum(l.quantity) from order_lines l join orders o on o.id = l.order_id
                     where l.offer_id = f.id and o.status <> 'cancelled' and o.placed_at > now() - make_interval(days => ${DEMAND_WINDOW})), 0)::int as sold,
           (select min(o.placed_at)::text from order_lines l join orders o on o.id = l.order_id where l.offer_id = f.id) as first_sale
    from offers f join product_variants v on v.id = f.variant_id
    where f.merchant_id = ${merchantId} and f.status = 'active'
    order by f.sku`);
  return rows.map((r) => {
    // A product on sale for less than the window is measured over the days it has been selling.
    const sellingDays = r.first_sale ? Math.min(DEMAND_WINDOW, Math.max(7, Math.ceil((Date.now() - Date.parse(r.first_sale)) / 86_400_000))) : DEMAND_WINDOW;
    const perDay = r.sold / sellingDays;
    const daysLeft = perDay > 0 ? Math.floor(r.available / perDay) : null;
    const reorder = perDay > 0 ? Math.max(0, Math.ceil(perDay * COVER_DAYS) - r.available) : 0;
    const status = r.sold === 0 ? 'no_sales' : r.available === 0 ? 'out' : daysLeft !== null && daysLeft <= 7 ? 'low' : daysLeft !== null && daysLeft > 120 ? 'overstock' : 'ok';
    return { offerId: r.offer_id, sku: r.sku, name: name(r.names, locale, r.sku), available: r.available, soldLast28Days: r.sold, perDay: Math.round(perDay * 100) / 100, daysLeft, reorder, status };
  });
}

/** Where the merchant's price stands against other sellers of the same item in the same store. */
export async function pricePositions(db: Database, merchantId: string, currency: string, locale: string) {
  const { rows } = await db.execute<{ offer_id: string; sku: string; names: Record<string, string> | null; price: string; others: string[] | null; sold: number }>(sql`
    select f.id as offer_id, f.sku, (select jsonb_object_agg(t.locale, t.name) from product_translations t where t.product_id = v.product_id) as names,
           p.amount_minor::text as price,
           (select array_agg(p2.amount_minor::text order by p2.amount_minor)
              from offers f2 join offer_prices p2 on p2.offer_id = f2.id and p2.currency = ${currency}
              join merchants m2 on m2.id = f2.merchant_id
              join store_merchants sm on sm.store_id = f2.store_id and sm.merchant_id = f2.merchant_id
             where f2.variant_id = f.variant_id and f2.store_id = f.store_id and f2.merchant_id <> f.merchant_id and f2.status = 'active'
               and m2.status = 'active' and m2.verification_status = 'verified' and sm.status = 'active') as others,
           coalesce((select sum(l.quantity) from order_lines l join orders o on o.id = l.order_id
                     where l.offer_id = f.id and o.status <> 'cancelled' and o.placed_at > now() - interval '30 days'), 0)::int as sold
    from offers f join product_variants v on v.id = f.variant_id
    join offer_prices p on p.offer_id = f.id and p.currency = ${currency}
    where f.merchant_id = ${merchantId} and f.status = 'active'
    order by f.sku`);
  return rows.map((r) => {
    const price = Number(r.price);
    const others = (r.others ?? []).map(Number);
    const lowest = others.length ? others[0]! : null;
    const median = others.length ? others[Math.floor((others.length - 1) / 2)]! : null;
    const gapPct = lowest ? Math.round(((price - lowest) / lowest) * 100) : null;
    const position = !others.length ? 'only_seller' : price <= lowest! ? 'lowest' : 'above';
    // Advice only: a higher price that does not sell may be worth reviewing; nothing is changed here.
    const suggestion = position === 'above' && gapPct! >= 10 && r.sold === 0 ? 'review_price' : null;
    return { offerId: r.offer_id, sku: r.sku, name: name(r.names, locale, r.sku), priceMinor: price, otherSellers: others.length, lowestOtherMinor: lowest, medianOtherMinor: median, gapPct, soldLast30Days: r.sold, position, suggestion };
  });
}

/** Products worth promoting: in stock, listed for a while, not selling (or far too much stock). */
export function promotionIdeas(demand: Awaited<ReturnType<typeof demandForecast>>, listedDays: Map<string, number>, bestSeller: string | null) {
  return demand
    .filter((d) => d.available > 0 && ((d.status === 'no_sales' && (listedDays.get(d.offerId) ?? 0) >= 14) || d.status === 'overstock'))
    .map((d) => ({
      offerId: d.offerId,
      sku: d.sku,
      name: d.name,
      available: d.available,
      reason: d.status === 'overstock' ? 'overstock' : 'no_sales_30_days',
      // Coupons and promotions arrive in phase 2: until then, ideas the merchant can act on today.
      ideas: [d.status === 'overstock' ? 'limited_time_price' : 'improve_listing', ...(bestSeller && bestSeller !== d.sku ? ['bundle_with_best_seller'] : [])],
    }));
}

export async function merchantInsights(db: Database, ai: AiLayer, userId: string, merchantId: string, o: Options) {
  await requireMembership(db, merchantId, userId, ['owner', 'manager']);
  const sales = await salesAnalysis(db, merchantId, o);
  const demand = await demandForecast(db, merchantId, o.locale);
  const pricing = await pricePositions(db, merchantId, o.currency, o.locale);
  const { rows: ages } = await db.execute<{ id: string; days: number }>(sql`select id, extract(day from now() - created_at)::int as days from offers where merchant_id = ${merchantId} and status = 'active'`);
  const promotions = promotionIdeas(demand, new Map(ages.map((a) => [a.id, a.days])), sales.topProducts[0]?.sku ?? null);

  let analysis: (z.infer<typeof analysisSchema> & { generatedByAi: true }) | null = null;
  if (await ai.enabled('sales_analysis')) {
    const facts = {
      days: o.days,
      currency: o.currency,
      current: sales.current,
      previous: sales.previous,
      cancellationRatePct: sales.cancellationRatePct,
      topProducts: sales.topProducts.slice(0, 5).map(({ name: n, units, revenueMinor }) => ({ name: n, units, revenueMinor })),
      stock: demand.filter((d) => d.status !== 'ok').slice(0, 10).map(({ name: n, status, daysLeft, reorder }) => ({ name: n, status, daysLeft, reorder })),
      pricesToReview: pricing.filter((p) => p.suggestion).length,
      slowMovers: promotions.length,
    };
    const key = ai.cache.key('sales', merchantId, o, facts);
    const cached = await ai.cache.get<z.infer<typeof analysisSchema>>(key);
    const out =
      cached ??
      (await ai.json({
        feature: 'sales_analysis',
        scope: { merchantId, userId },
        system: `You are a retail analyst helping a small perfume merchant. From the figures, write {"headline": one sentence, "points": what changed and why it matters, "actions": up to 3 concrete next steps the merchant can take in the app}. Amounts are in minor units of ${o.currency} (divide by 100). ${answerIn(o.locale)}`,
        prompt: data('figures', facts),
        schema: analysisSchema,
        skipEnabledCheck: true,
      }));
    if (out) {
      if (!cached) await ai.cache.set(key, 'sales_analysis', out, 6);
      analysis = { ...out, generatedByAi: true };
    }
  }
  return { currency: o.currency, days: o.days, sales, demand, pricing, promotions, analysis };
}
