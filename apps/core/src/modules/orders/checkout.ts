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
import { openCodRecord } from '../cod/index.js';
import { spendStoreCredit, storeCreditBalance } from '../finance/index.js';
import { codCheckout } from './cod-flow.js';
import { chooseDelivery, deliveryOptions, resolveAddress, resolveLocality, type AddressInput } from '../shipping/index.js';
import { getActiveStore, resolveCurrency } from '../stores/index.js';

/** The customer's delivery choice for one merchant of the cart. */
export type DeliveryChoice = { merchantId: string; methodId: string; pickupPointId?: string };

export type CheckoutInput = {
  lines: { offerId: string; quantity: number }[];
  currency?: string;
  paymentMethod: 'cash_on_delivery' | 'online';
  shippingAddress: AddressInput;
  /** One choice per merchant in the cart. */
  delivery: DeliveryChoice[];
  /** Pay with the customer's store credit first (the rest online or in cash). */
  useStoreCredit?: boolean;
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
  return {
    checkoutId: checkout.id,
    orderIds: orders.map((o) => o.id),
    replayed: true,
    codConfirmationRequired: false,
    amountToPayMinor: orders.reduce((sum, o) => sum + o.totalMinor - o.creditAppliedMinor, 0n),
  };
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
  // Wilaya, Daïra and Commune are checked and filled by the server; the phone is normalized.
  const address = await resolveAddress(db, input.shippingAddress);
  // Cash on delivery: the store's rules and the customer's track record (by phone and account).
  const cod = input.paymentMethod === 'cash_on_delivery' ? await codCheckout(db, store.id, customer.userId, address.phone) : null;

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
      // Store credit available for this checkout (row locked until commit, so it cannot be spent twice).
      let credit = input.useStoreCredit ? await storeCreditBalance(tx, customer.userId, currency.code, true) : 0n;
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
        // Shipping is priced by the server from the merchant's rates, never taken from the browser.
        const choice = input.delivery.find((d) => d.merchantId === merchantId);
        if (!choice) {
          throw new AppError(400, 'DELIVERY_METHOD_REQUIRED', 'Choose how each seller delivers', {
            merchantIds: [...byMerchant.keys()].filter((m) => !input.delivery.some((d) => d.merchantId === m)),
          });
        }
        const { priceMinor: shipping, delivery } = await chooseDelivery(tx, {
          merchantId,
          methodId: choice.methodId,
          pickupPointId: choice.pickupPointId,
          address,
          subtotalMinor: subtotal,
          currency: currency.code,
          paymentMethod: input.paymentMethod,
          pickupPoints: Boolean(flags['shipping.pickup_points']),
        });
        const total = subtotal + shipping;
        const creditApplied = credit < total ? credit : total;
        credit -= creditApplied;
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
            totalMinor: total,
            creditAppliedMinor: creditApplied,
            // Fully paid with store credit: nothing left to pay online or in cash.
            ...(creditApplied === total ? { paymentStatus: 'successful' as const } : {}),
            // Commission and fee in force now are frozen in the order (configurable, see finance rules).
            commissionBps: await resolveCommissionBps(tx, store.id, merchantId),
            merchantFeeMinor: orderFee,
            paymentMethod: input.paymentMethod,
            shippingAddress: address,
            shippingMethodId: delivery.methodId,
            delivery,
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
        await spendStoreCredit(tx, order!);
        if (cod && creditApplied < total) {
          if (cod.policy.maxAmountMinor !== null && order!.totalMinor > cod.policy.maxAmountMinor) {
            throw new AppError(409, 'COD_AMOUNT_TOO_HIGH', 'This order is above the cash-on-delivery limit; pay online', {
              merchantId,
              maxAmountMinor: Number(cod.policy.maxAmountMinor),
            });
          }
          await openCodRecord(tx, order!, { requireConfirmation: cod.policy.requireConfirmation, risk: cod.risk });
        }
        await audit(tx, customer, { action: 'orders.order.placed', entityType: 'order', entityId: order!.id });
        await recordEvent(tx, {
          type: 'orders.order.placed',
          aggregateType: 'order',
          aggregateId: order!.id,
          payload: { number: order!.number, merchantId, storeId: store.id, total: String(order!.totalMinor), currency: currency.code, deliveryType: delivery.type },
        });
        orderIds.push(order!.id);
      }
      const toPay = (await tx.select({ total: s.orders.totalMinor, credit: s.orders.creditAppliedMinor }).from(s.orders).where(eq(s.orders.checkoutId, checkout!.id))).reduce(
        (sum, o) => sum + o.total - o.credit,
        0n,
      );
      return { checkoutId: checkout!.id, orderIds, replayed: false, codConfirmationRequired: Boolean(cod?.policy.requireConfirmation) && toPay > 0n, amountToPayMinor: toPay };
    });
  } catch (error) {
    // Two identical submissions at the same moment: the second one returns the first one's orders.
    const again = await existingCheckout(db, customer.userId, idempotencyKey);
    if (again) return again;
    throw error;
  }
}

/**
 * Delivery choices for a cart before checkout: the cart split by seller, and for each seller every way
 * it can deliver to this Commune with its price and delay.
 */
export async function previewDelivery(
  db: Database,
  storeSlug: string,
  input: { lines: { offerId: string; quantity: number }[]; currency?: string; country: string; localityId?: string },
) {
  const store = await getActiveStore(db, storeSlug);
  const currency = resolveCurrency(store, input.currency);
  const flags = await evaluateFlags(db, store.id);
  const area = { country: input.country, ...(await resolveLocality(db, input.country, input.localityId)) };
  const quantities = new Map<string, number>();
  for (const line of input.lines) quantities.set(line.offerId, (quantities.get(line.offerId) ?? 0) + line.quantity);
  const requested = await db.select({ id: s.offers.id, variantId: s.offers.variantId }).from(s.offers).where(inArray(s.offers.id, [...quantities.keys()]));
  const sellable = (await loadSellableOffers(db, store.id, requested.map((r) => r.variantId), currency.code)).filter((o) => quantities.has(o.offerId));
  const merchants = [...new Set(sellable.map((o) => o.merchantId))].sort();
  const names = merchants.length ? await db.select({ id: s.merchants.id, name: s.merchants.name }).from(s.merchants).where(inArray(s.merchants.id, merchants)) : [];
  const result = [];
  for (const merchantId of merchants) {
    const subtotal = sellable.filter((o) => o.merchantId === merchantId).reduce((sum, o) => sum + o.amountMinor * BigInt(quantities.get(o.offerId)!), 0n);
    const options = await deliveryOptions(db, { merchantId, address: area, subtotalMinor: subtotal, currency: currency.code, pickupPoints: Boolean(flags['shipping.pickup_points']) });
    result.push({
      merchantId,
      merchantName: names.find((n) => n.id === merchantId)?.name ?? null,
      subtotalMinor: Number(subtotal),
      options: options.map((o) => ({ ...o, priceMinor: Number(o.priceMinor), freeAboveMinor: o.freeAboveMinor === null ? null : Number(o.freeAboveMinor) })),
    });
  }
  return { currency: currency.code, sellers: result, unavailableOfferIds: [...quantities.keys()].filter((id) => !sellable.some((o) => o.offerId === id)) };
}

/**
 * A free replacement for returned items: a new order (total 0, nothing to pay) to the same address with
 * the same delivery method, linked to the original. Stock is reserved now; it fails if none is left.
 */
export async function placeReplacementOrder(
  tx: Transaction,
  original: typeof s.orders.$inferSelect,
  input: { returnId: string; returnNumber: string; lines: { orderLineId: string; quantity: number }[] },
) {
  const [checkout] = await tx
    .insert(s.checkouts)
    .values({ storeId: original.storeId, customerUserId: original.customerUserId, idempotencyKey: `replacement:${input.returnId}` })
    .returning();
  const originalLines = await tx.select().from(s.orderLines).where(eq(s.orderLines.orderId, original.id));
  const [order] = await tx
    .insert(s.orders)
    .values({
      number: await nextOrderNumber(tx),
      checkoutId: checkout!.id,
      storeId: original.storeId,
      merchantId: original.merchantId,
      customerUserId: original.customerUserId,
      currency: original.currency,
      subtotalMinor: 0n,
      shippingMinor: 0n,
      totalMinor: 0n,
      commissionBps: original.commissionBps,
      merchantFeeMinor: 0n,
      paymentMethod: original.paymentMethod,
      paymentStatus: 'successful', // nothing to pay
      shippingAddress: original.shippingAddress,
      shippingMethodId: original.shippingMethodId,
      delivery: original.delivery,
      replacementForOrderId: original.id,
      customerNote: `Replacement — return ${input.returnNumber}`,
    })
    .returning();
  const lines = input.lines.map((l) => {
    const line = originalLines.find((o) => o.id === l.orderLineId)!;
    return {
      orderId: order!.id,
      offerId: line.offerId,
      variantId: line.variantId,
      sku: line.sku,
      productNames: line.productNames,
      options: line.options,
      quantity: l.quantity,
      unitPriceMinor: 0n,
      lineTotalMinor: 0n,
    };
  });
  await tx.insert(s.orderLines).values(lines);
  await tx.insert(s.orderStatusHistory).values({ orderId: order!.id, fromStatus: null, toStatus: 'new', actorType: 'system', note: `Replacement for ${original.number}` });
  // Throws OUT_OF_STOCK when nothing is left to send.
  await reserveStock(tx, { reference: { type: 'order', id: order!.id }, lines: lines.map((l) => ({ offerId: l.offerId, quantity: l.quantity })), actorUserId: null });
  await recordEvent(tx, {
    type: 'orders.order.placed',
    aggregateType: 'order',
    aggregateId: order!.id,
    payload: { number: order!.number, merchantId: original.merchantId, storeId: original.storeId, total: '0', currency: original.currency, replacementFor: original.id },
  });
  return order!;
}
