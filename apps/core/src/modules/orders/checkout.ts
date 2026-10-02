/**
 * Placing an order. Prices always come from the server (never from the client), stock is reserved in
 * the same transaction, and the whole checkout succeeds or fails as one unit. Retrying with the same
 * Idempotency-Key returns the orders already created instead of creating new ones.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import type { Transaction } from '../../shared/db.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { getSetting, resolveCommissionBps } from '../finance/index.js';
import { reserveStock } from '../inventory/index.js';
import { loadSellableOffers } from '../offers/index.js';
import { audit, evaluateFlags, recordEvent } from '../platform/index.js';
import { getActiveStore, resolveCurrency } from '../stores/index.js';

export type CheckoutInput = {
  lines: { offerId: string; quantity: number }[];
  currency?: string;
  paymentMethod: 'cash_on_delivery' | 'online';
  shippingAddress: typeof s.orders.$inferInsert.shippingAddress;
  customerNote?: string;
};

async function nextOrderNumber(tx: Transaction) {
  const [row] = await tx.execute<{ n: string }>(sql`select nextval('order_number_seq')::text as n`).then((r) => r.rows);
  return `${new Date().getUTCFullYear()}-${row!.n.padStart(6, '0')}`;
}

async function existingCheckout(db: Database | Transaction, customerUserId: string, key: string) {
  const [checkout] = await db
    .select()
    .from(s.checkouts)
    .where(and(eq(s.checkouts.customerUserId, customerUserId), eq(s.checkouts.idempotencyKey, key)));
  if (!checkout) return null;
  const orders = await db.select().from(s.orders).where(eq(s.orders.checkoutId, checkout.id));
  return { checkoutId: checkout.id, orderIds: orders.map((o) => o.id), replayed: true };
}

export async function placeOrders(
  db: Database,
  customer: { userId: string; ip: string | null },
  storeSlug: string,
  idempotencyKey: string,
  input: CheckoutInput,
) {
  const replay = await existingCheckout(db, customer.userId, idempotencyKey);
  if (replay) return replay;

  const store = await getActiveStore(db, storeSlug);
  const currency = resolveCurrency(store, input.currency);
  const flags = await evaluateFlags(db, store.id);
  const flag = input.paymentMethod === 'online' ? 'checkout.online_payment' : 'checkout.cash_on_delivery';
  if (!flags[flag]) throw badRequest('PAYMENT_METHOD_UNAVAILABLE', `This payment method is not available in this store`);
  const [shipsTo] = await db
    .select()
    .from(s.storeCountries)
    .where(and(eq(s.storeCountries.storeId, store.id), eq(s.storeCountries.country, input.shippingAddress.country)));
  if (!shipsTo) throw badRequest('COUNTRY_NOT_SERVED', 'This store does not deliver to that country');

  const quantities = new Map<string, number>();
  for (const line of input.lines) quantities.set(line.offerId, (quantities.get(line.offerId) ?? 0) + line.quantity);

  try {
    return await db.transaction(async (tx) => {
      const [checkout] = await tx
        .insert(s.checkouts)
        .values({ storeId: store.id, customerUserId: customer.userId, idempotencyKey })
        .returning();

      // Variant ids of the requested offers, then the sellable view (verified merchant, priced, active).
      const requested = await tx
        .select({ id: s.offers.id, variantId: s.offers.variantId, storeId: s.offers.storeId, sku: s.offers.sku })
        .from(s.offers)
        .where(inArray(s.offers.id, [...quantities.keys()]));
      const sellable = await loadSellableOffers(
        tx,
        store.id,
        requested.map((r) => r.variantId),
        currency.code,
      );
      const unavailable = [...quantities.keys()].filter((id) => !sellable.some((o) => o.offerId === id));
      if (unavailable.length) {
        throw new AppError(409, 'OFFER_UNAVAILABLE', 'Some items are no longer for sale', { offerIds: unavailable });
      }

      const variants = await tx
        .select({ id: s.productVariants.id, productId: s.productVariants.productId, options: s.productVariants.options })
        .from(s.productVariants)
        .where(inArray(s.productVariants.id, requested.map((r) => r.variantId)));
      const names = await tx
        .select()
        .from(s.productTranslations)
        .where(inArray(s.productTranslations.productId, variants.map((v) => v.productId)));
      const orderFee = BigInt(await getSetting(tx, 'order_fee_minor'));

      // One order per merchant.
      const byMerchant = new Map<string, typeof sellable>();
      for (const offer of sellable.filter((o) => quantities.has(o.offerId))) {
        byMerchant.set(offer.merchantId, [...(byMerchant.get(offer.merchantId) ?? []), offer]);
      }

      const orderIds: string[] = [];
      for (const [merchantId, offers] of [...byMerchant.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const lines = offers.map((offer) => {
          const variant = variants.find((v) => v.id === offer.variantId)!;
          const quantity = quantities.get(offer.offerId)!;
          return {
            offerId: offer.offerId,
            variantId: offer.variantId,
            sku: requested.find((r) => r.id === offer.offerId)!.sku,
            productNames: Object.fromEntries(names.filter((n) => n.productId === variant.productId).map((n) => [n.locale, n.name])),
            options: variant.options,
            quantity,
            unitPriceMinor: offer.amountMinor,
            lineTotalMinor: offer.amountMinor * BigInt(quantity),
          };
        });
        const subtotal = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0n);
        const shipping = 0n; // delivery pricing arrives with the shipping module
        const [order] = await tx
          .insert(s.orders)
          .values({
            number: await nextOrderNumber(tx),
            checkoutId: checkout!.id,
            storeId: store.id,
            merchantId,
            customerUserId: customer.userId,
            currency: currency.code,
            subtotalMinor: subtotal,
            shippingMinor: shipping,
            totalMinor: subtotal + shipping,
            // Commission and fee in force now are frozen in the order (configurable, see finance rules).
            commissionBps: await resolveCommissionBps(tx, store.id, merchantId),
            merchantFeeMinor: orderFee,
            paymentMethod: input.paymentMethod,
            shippingAddress: input.shippingAddress,
            customerNote: input.customerNote ?? null,
          })
          .returning();
        await tx.insert(s.orderLines).values(lines.map((l) => ({ orderId: order!.id, ...l })));
        await tx.insert(s.orderStatusHistory).values({
          orderId: order!.id,
          fromStatus: null,
          toStatus: 'new',
          actorType: 'customer',
          actorUserId: customer.userId,
        });
        // Throws OUT_OF_STOCK (and rolls back the whole checkout) if any line cannot be reserved.
        await reserveStock(tx, {
          reference: { type: 'order', id: order!.id },
          lines: lines.map((l) => ({ offerId: l.offerId, quantity: l.quantity })),
          actorUserId: customer.userId,
        });
        await audit(tx, customer, { action: 'orders.order.placed', entityType: 'order', entityId: order!.id });
        await recordEvent(tx, {
          type: 'orders.order.placed',
          aggregateType: 'order',
          aggregateId: order!.id,
          payload: { number: order!.number, merchantId, storeId: store.id, total: String(order!.totalMinor), currency: currency.code },
        });
        orderIds.push(order!.id);
      }
      return { checkoutId: checkout!.id, orderIds, replayed: false };
    });
  } catch (error) {
    // Two identical submissions at the same moment: the second one returns the first one's orders.
    const again = await existingCheckout(db, customer.userId, idempotencyKey);
    if (again) return again;
    throw error;
  }
}
