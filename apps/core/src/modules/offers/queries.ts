import { and, eq, inArray } from 'drizzle-orm';
import { schema as s } from '@aruma/db';
import type { Executor } from '../../shared/db.js';

export type SellableOffer = {
  offerId: string;
  variantId: string;
  merchant: { slug: string; name: string };
  stockQuantity: number;
  amountMinor: bigint;
  compareAtMinor: bigint | null;
};

/**
 * Offers a customer may buy from: active offer, active + verified merchant, merchant allowed in the store,
 * and priced in the requested currency. This is the single definition of "sellable" used by the storefront.
 */
export async function loadSellableOffers(
  db: Executor,
  storeId: string,
  variantIds: string[],
  currency: string,
): Promise<SellableOffer[]> {
  if (variantIds.length === 0) return [];
  const rows = await db
    .select({
      offerId: s.offers.id,
      variantId: s.offers.variantId,
      merchantSlug: s.merchants.slug,
      merchantName: s.merchants.name,
      stockQuantity: s.offers.stockQuantity,
      amountMinor: s.offerPrices.amountMinor,
      compareAtMinor: s.offerPrices.compareAtMinor,
    })
    .from(s.offers)
    .innerJoin(s.offerPrices, and(eq(s.offerPrices.offerId, s.offers.id), eq(s.offerPrices.currency, currency)))
    .innerJoin(s.merchants, eq(s.merchants.id, s.offers.merchantId))
    .innerJoin(
      s.storeMerchants,
      and(eq(s.storeMerchants.storeId, s.offers.storeId), eq(s.storeMerchants.merchantId, s.offers.merchantId)),
    )
    .where(
      and(
        eq(s.offers.storeId, storeId),
        inArray(s.offers.variantId, variantIds),
        eq(s.offers.status, 'active'),
        eq(s.merchants.status, 'active'),
        eq(s.merchants.verificationStatus, 'verified'),
        eq(s.storeMerchants.status, 'active'),
      ),
    );
  return rows.map(({ merchantSlug, merchantName, ...r }) => ({ ...r, merchant: { slug: merchantSlug, name: merchantName } }));
}

/** The offer shown by default: cheapest in-stock offer, otherwise the cheapest offer. */
export function pickBestOffer(offers: SellableOffer[]): SellableOffer | undefined {
  const cheapest = (list: SellableOffer[]) =>
    list.reduce<SellableOffer | undefined>((best, o) => (!best || o.amountMinor < best.amountMinor ? o : best), undefined);
  return cheapest(offers.filter((o) => o.stockQuantity > 0)) ?? cheapest(offers);
}
