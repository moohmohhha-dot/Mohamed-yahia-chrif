import { and, eq, inArray } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit, recordEvent } from '../platform/index.js';

export type OfferInput = {
  variantId: string;
  stockQuantity: number;
  status: 'active' | 'archived';
  prices: { currency: string; amountMinor: number; compareAtMinor?: number }[];
};

function serializeOffer(offer: typeof s.offers.$inferSelect, prices: (typeof s.offerPrices.$inferSelect)[]) {
  return {
    ...offer,
    prices: prices.map((p) => ({
      currency: p.currency,
      amountMinor: Number(p.amountMinor),
      compareAtMinor: p.compareAtMinor === null ? null : Number(p.compareAtMinor),
    })),
  };
}

/**
 * Creates or updates the merchant's offer for a variant and replaces its prices.
 * The merchant must be verified, active and allowed in the variant's store.
 */
export async function upsertOffer(db: Database, actor: Actor & { userId: string }, merchantId: string, input: OfferInput) {
  const currencies = input.prices.map((p) => p.currency);
  if (new Set(currencies).size !== currencies.length) throw badRequest('DUPLICATE_CURRENCY', 'One price per currency');

  return db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId);

    const [merchant] = await tx.select().from(s.merchants).where(eq(s.merchants.id, merchantId));
    if (merchant?.verificationStatus !== 'verified' || merchant.status !== 'active') {
      throw new AppError(403, 'MERCHANT_NOT_VERIFIED', 'The merchant must be verified before selling');
    }

    const [variant] = await tx
      .select({ id: s.productVariants.id, storeId: s.products.storeId })
      .from(s.productVariants)
      .innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
      .where(eq(s.productVariants.id, input.variantId));
    if (!variant) throw notFound('Variant');

    const [allowed] = await tx
      .select()
      .from(s.storeMerchants)
      .where(
        and(
          eq(s.storeMerchants.storeId, variant.storeId),
          eq(s.storeMerchants.merchantId, merchantId),
          eq(s.storeMerchants.status, 'active'),
        ),
      );
    if (!allowed) throw new AppError(403, 'NOT_ALLOWED_IN_STORE', 'The merchant is not allowed to sell in this store');

    const supported = await tx
      .select({ currency: s.storeCurrencies.currency })
      .from(s.storeCurrencies)
      .where(and(eq(s.storeCurrencies.storeId, variant.storeId), inArray(s.storeCurrencies.currency, currencies)));
    if (supported.length !== currencies.length) {
      throw badRequest('UNSUPPORTED_CURRENCY', 'Every price currency must be enabled in the store');
    }

    const [offer] = await tx
      .insert(s.offers)
      .values({
        storeId: variant.storeId,
        variantId: variant.id,
        merchantId,
        stockQuantity: input.stockQuantity,
        status: input.status,
      })
      .onConflictDoUpdate({
        target: [s.offers.variantId, s.offers.merchantId],
        set: { stockQuantity: input.stockQuantity, status: input.status, updatedAt: new Date() },
      })
      .returning();

    await tx.delete(s.offerPrices).where(eq(s.offerPrices.offerId, offer!.id));
    const prices = await tx
      .insert(s.offerPrices)
      .values(
        input.prices.map((p) => ({
          offerId: offer!.id,
          currency: p.currency,
          amountMinor: BigInt(p.amountMinor),
          compareAtMinor: p.compareAtMinor === undefined ? null : BigInt(p.compareAtMinor),
        })),
      )
      .returning();

    await audit(tx, actor, {
      action: 'offers.offer.upserted',
      entityType: 'offer',
      entityId: offer!.id,
      metadata: { stockQuantity: input.stockQuantity, status: input.status, prices: input.prices },
    });
    await recordEvent(tx, {
      type: 'offers.offer.upserted',
      aggregateType: 'offer',
      aggregateId: offer!.id,
      payload: { storeId: variant.storeId, variantId: variant.id, merchantId },
    });
    return serializeOffer(offer!, prices);
  });
}

export async function listMerchantOffers(db: Database, userId: string, merchantId: string) {
  await requireMembership(db, merchantId, userId);
  const offers = await db.select().from(s.offers).where(eq(s.offers.merchantId, merchantId));
  const prices = offers.length
    ? await db
        .select()
        .from(s.offerPrices)
        .where(
          inArray(
            s.offerPrices.offerId,
            offers.map((o) => o.id),
          ),
        )
    : [];
  return offers.map((o) => serializeOffer(o, prices.filter((p) => p.offerId === o.id)));
}
