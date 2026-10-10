import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { AppError, badRequest, conflict, isUniqueViolation, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { requireMembership } from '../merchants/index.js';
import { audit, recordEvent } from '../platform/index.js';
import { ensureDefaultLocation, setOnHand } from '../inventory/index.js';

export type OfferInput = {
  variantId: string;
  /** Merchant SKU; defaults to the variant SKU when the offer is created. */
  sku?: string;
  /** On-hand stock at the merchant's default location (a stock count). Omit to leave stock unchanged. */
  stockQuantity?: number;
  lowStockThreshold?: number | null;
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

  try {
    return await db.transaction(async (tx) => {
    await requireMembership(tx, merchantId, actor.userId);

    const [merchant] = await tx.select().from(s.merchants).where(eq(s.merchants.id, merchantId));
    if (merchant?.verificationStatus !== 'verified' || merchant.status !== 'active') {
      throw new AppError(403, 'MERCHANT_NOT_VERIFIED', 'The merchant must be verified before selling');
    }

    const [variant] = await tx
      .select({ id: s.productVariants.id, sku: s.productVariants.sku, storeId: s.products.storeId })
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

    const [existing] = await tx
      .select()
      .from(s.offers)
      .where(and(eq(s.offers.variantId, variant.id), eq(s.offers.merchantId, merchantId)))
      .for('update');
    const fields = {
      status: input.status,
      ...(input.sku ? { sku: input.sku } : {}),
      ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
    };
    const [saved] = existing
      ? await tx.update(s.offers).set(fields).where(eq(s.offers.id, existing.id)).returning()
      : await tx
          .insert(s.offers)
          .values({ storeId: variant.storeId, variantId: variant.id, merchantId, sku: variant.sku, ...fields })
          .returning();

    // Stock lives in the inventory module: the given quantity becomes on-hand at the default location.
    if (!existing || input.stockQuantity !== undefined) {
      const location = await ensureDefaultLocation(tx, merchantId);
      await setOnHand(tx, saved!.id, location.id, input.stockQuantity ?? 0, {
        merchantId,
        reason: existing ? 'correction' : 'initial',
        actorUserId: actor.userId,
      });
    }
    const [offer] = await tx.select().from(s.offers).where(eq(s.offers.id, saved!.id));

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
      metadata: { sku: offer!.sku, stockQuantity: input.stockQuantity ?? null, status: input.status, prices: input.prices },
    });
    await recordEvent(tx, {
      type: 'offers.offer.upserted',
      aggregateType: 'offer',
      aggregateId: offer!.id,
      payload: { storeId: variant.storeId, variantId: variant.id, merchantId },
    });
    return serializeOffer(offer!, prices);
  });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('SKU_TAKEN', 'You already use this SKU for another offer; choose another one');
    throw error;
  }
}

/** The merchant's offers with what they are for (product name, SKU, store) and their prices. */
export async function listMerchantOffers(db: Database, userId: string, merchantId: string) {
  await requireMembership(db, merchantId, userId);
  const rows = await db
    .select({
      offer: s.offers,
      sku: s.productVariants.sku,
      options: s.productVariants.options,
      productId: s.products.id,
      productSlug: s.products.slug,
      storeSlug: s.stores.slug,
      storeDefaultLocale: s.stores.defaultLocale,
    })
    .from(s.offers)
    .innerJoin(s.productVariants, eq(s.productVariants.id, s.offers.variantId))
    .innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
    .innerJoin(s.stores, eq(s.stores.id, s.offers.storeId))
    .where(eq(s.offers.merchantId, merchantId))
    .orderBy(asc(s.products.slug), asc(s.productVariants.position));
  if (rows.length === 0) return [];
  const [prices, names] = await Promise.all([
    db.select().from(s.offerPrices).where(inArray(s.offerPrices.offerId, rows.map((r) => r.offer.id))),
    db
      .select()
      .from(s.productTranslations)
      .where(inArray(s.productTranslations.productId, rows.map((r) => r.productId))),
  ]);
  return rows.map((r) => ({
    ...serializeOffer(r.offer, prices.filter((p) => p.offerId === r.offer.id)),
    sku: r.sku,
    options: r.options,
    product: {
      id: r.productId,
      slug: r.productSlug,
      names: Object.fromEntries(names.filter((n) => n.productId === r.productId).map((n) => [n.locale, n.name])),
    },
    storeSlug: r.storeSlug,
  }));
}
