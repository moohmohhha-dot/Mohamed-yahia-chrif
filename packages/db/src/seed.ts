/**
 * Seeds reference data and the MB Parfum store with SAMPLE products.
 * The perfumes below are placeholders for development; replace them with the real catalog.
 * Safe to run more than once: it does nothing if the store already exists.
 */
import { eq } from 'drizzle-orm';
import { createDb, type Database } from './client.js';
import * as s from './schema/index.js';

type SamplePerfume = {
  slug: string;
  brand: string;
  category: string;
  attributes: Record<string, unknown>;
  names: Record<'ar' | 'fr' | 'en', string>;
  descriptions: Record<'ar' | 'fr' | 'en', string>;
  variants: { sizeMl: number; stock: number; prices: Record<'DZD' | 'EUR' | 'USD', number> }[];
};

const samplePerfumes: SamplePerfume[] = [
  {
    slug: 'oud-royal',
    brand: 'mb-signature',
    category: 'oriental',
    attributes: {
      gender: 'unisex',
      concentration: 'EDP',
      notes: { top: ['saffron', 'bergamot'], heart: ['rose', 'oud'], base: ['amber', 'musk'] },
    },
    names: { ar: 'عود رويال', fr: 'Oud Royal', en: 'Oud Royal' },
    descriptions: {
      ar: 'عطر شرقي فاخر بنفحات العود والزعفران.',
      fr: 'Un parfum oriental luxueux aux notes de oud et de safran.',
      en: 'A luxurious oriental fragrance with oud and saffron notes.',
    },
    variants: [
      { sizeMl: 50, stock: 20, prices: { DZD: 850000, EUR: 5900, USD: 6400 } },
      { sizeMl: 100, stock: 12, prices: { DZD: 1400000, EUR: 9500, USD: 10400 } },
    ],
  },
  {
    slug: 'fleur-de-jasmin',
    brand: 'mb-signature',
    category: 'floral',
    attributes: {
      gender: 'women',
      concentration: 'EDP',
      notes: { top: ['pear'], heart: ['jasmine', 'orange blossom'], base: ['vanilla'] },
    },
    names: { ar: 'زهرة الياسمين', fr: 'Fleur de Jasmin', en: 'Jasmine Blossom' },
    descriptions: {
      ar: 'عطر زهري ناعم يغلب عليه الياسمين.',
      fr: 'Un floral délicat dominé par le jasmin.',
      en: 'A soft floral fragrance led by jasmine.',
    },
    variants: [{ sizeMl: 75, stock: 30, prices: { DZD: 690000, EUR: 4900, USD: 5300 } }],
  },
  {
    slug: 'bois-marin',
    brand: 'mb-signature',
    category: 'fresh',
    attributes: {
      gender: 'men',
      concentration: 'EDT',
      notes: { top: ['lemon', 'sea salt'], heart: ['lavender'], base: ['cedar', 'vetiver'] },
    },
    names: { ar: 'خشب البحر', fr: 'Bois Marin', en: 'Marine Wood' },
    descriptions: {
      ar: 'عطر منعش بنفحات بحرية وخشبية.',
      fr: 'Un parfum frais aux accents marins et boisés.',
      en: 'A fresh fragrance with marine and woody accents.',
    },
    variants: [{ sizeMl: 100, stock: 0, prices: { DZD: 590000, EUR: 3900, USD: 4200 } }],
  },
];

const categoryNames: Record<string, Record<'ar' | 'fr' | 'en', string>> = {
  oriental: { ar: 'شرقي', fr: 'Oriental', en: 'Oriental' },
  floral: { ar: 'زهري', fr: 'Floral', en: 'Floral' },
  fresh: { ar: 'منعش', fr: 'Frais', en: 'Fresh' },
};

export async function seed(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(s.currencies)
      .values([
        { code: 'DZD', name: 'Algerian Dinar', minorUnits: 2 },
        { code: 'EUR', name: 'Euro', minorUnits: 2 },
        { code: 'USD', name: 'US Dollar', minorUnits: 2 },
      ])
      .onConflictDoNothing();
    await tx
      .insert(s.locales)
      .values([
        { code: 'ar', name: 'العربية', direction: 'rtl' },
        { code: 'fr', name: 'Français', direction: 'ltr' },
        { code: 'en', name: 'English', direction: 'ltr' },
      ])
      .onConflictDoNothing();
    await tx
      .insert(s.countries)
      .values([
        { code: 'DZ', name: 'Algeria', defaultCurrency: 'DZD' },
        { code: 'FR', name: 'France', defaultCurrency: 'EUR' },
      ])
      .onConflictDoNothing();

    await tx
      .insert(s.featureFlags)
      .values([
        { key: 'checkout.cash_on_delivery', description: 'Cash on delivery at checkout', enabledByDefault: true },
        { key: 'checkout.online_payment', description: 'Online card payment at checkout', enabledByDefault: false },
      ])
      .onConflictDoNothing();

    const existing = await tx.select({ id: s.stores.id }).from(s.stores).where(eq(s.stores.slug, 'mb-parfum'));
    if (existing.length > 0) return;

    const [store] = await tx
      .insert(s.stores)
      .values({
        slug: 'mb-parfum',
        name: 'MB Parfum',
        vertical: 'perfume',
        status: 'active',
        defaultLocale: 'ar',
        defaultCurrency: 'DZD',
      })
      .returning();
    const [merchant] = await tx
      .insert(s.merchants)
      .values({
        type: 'business',
        slug: 'mb-parfum',
        name: 'MB Parfum',
        country: 'DZ',
        activityCode: 'perfume_retail',
        status: 'active',
        verificationStatus: 'verified',
      })
      .returning();
    if (!store || !merchant) throw new Error('Failed to create store or merchant');
    // Development data: the house merchant is marked verified without real documents.
    await tx.insert(s.merchantVerifications).values(
      (['phone', 'email', 'identity', 'business', 'payout'] as const).map((kind) => ({
        merchantId: merchant.id,
        kind,
        status: 'verified' as const,
        reviewedAt: new Date(),
        note: 'Seed data',
      })),
    );

    await tx.insert(s.storeLocales).values(['ar', 'fr', 'en'].map((locale) => ({ storeId: store.id, locale })));
    await tx.insert(s.storeCurrencies).values(['DZD', 'EUR', 'USD'].map((currency) => ({ storeId: store.id, currency })));
    await tx.insert(s.storeCountries).values([{ storeId: store.id, country: 'DZ' }]);
    await tx.insert(s.storeMerchants).values({ storeId: store.id, merchantId: merchant.id });
    const [location] = await tx
      .insert(s.inventoryLocations)
      .values({ merchantId: merchant.id, code: 'MAIN', name: 'Entrepôt principal', country: 'DZ', isDefault: true })
      .returning();
    if (!location) throw new Error('Failed to create location');

    const [brand] = await tx
      .insert(s.brands)
      .values({ storeId: store.id, slug: 'mb-signature', name: 'MB Signature' })
      .returning();
    if (!brand) throw new Error('Failed to create brand');

    const categoryIds = new Map<string, string>();
    let position = 0;
    for (const [slug, names] of Object.entries(categoryNames)) {
      const [category] = await tx
        .insert(s.categories)
        .values({ storeId: store.id, slug, position: position++ })
        .returning();
      if (!category) throw new Error(`Failed to create category ${slug}`);
      categoryIds.set(slug, category.id);
      await tx.insert(s.categoryTranslations).values(
        Object.entries(names).map(([locale, name]) => ({ categoryId: category.id, locale, name })),
      );
    }

    for (const perfume of samplePerfumes) {
      const [product] = await tx
        .insert(s.products)
        .values({
          storeId: store.id,
          createdByMerchantId: merchant.id,
          brandId: brand.id,
          slug: perfume.slug,
          status: 'active',
          attributes: perfume.attributes,
        })
        .returning();
      if (!product) throw new Error(`Failed to create product ${perfume.slug}`);

      await tx.insert(s.productTranslations).values(
        (['ar', 'fr', 'en'] as const).map((locale) => ({
          productId: product.id,
          locale,
          name: perfume.names[locale],
          description: perfume.descriptions[locale],
        })),
      );
      await tx.insert(s.productCategories).values({ productId: product.id, categoryId: categoryIds.get(perfume.category)! });

      for (const [i, v] of perfume.variants.entries()) {
        const [variant] = await tx
          .insert(s.productVariants)
          .values({
            productId: product.id,
            sku: `${perfume.slug}-${v.sizeMl}ml`.toUpperCase(),
            options: { sizeMl: v.sizeMl },
            position: i,
          })
          .returning();
        if (!variant) throw new Error('Failed to create variant');
        const [offer] = await tx
          .insert(s.offers)
          .values({ storeId: store.id, variantId: variant.id, merchantId: merchant.id, sku: variant.sku })
          .returning();
        if (!offer) throw new Error('Failed to create offer');
        // Opening stock at the main warehouse; offer totals are filled in by the database trigger.
        await tx.insert(s.inventoryLevels).values({ offerId: offer.id, locationId: location.id, onHand: v.stock });
        await tx.insert(s.inventoryMovements).values({
          offerId: offer.id,
          merchantId: merchant.id,
          locationId: location.id,
          delta: v.stock,
          quantityAfter: v.stock,
          reason: 'initial',
          note: 'Seed data',
        });
        await tx.insert(s.offerPrices).values(
          Object.entries(v.prices).map(([currency, amount]) => ({
            offerId: offer.id,
            currency,
            amountMinor: BigInt(amount),
          })),
        );
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { db, pool } = createDb(url);
  try {
    await seed(db);
    console.log('Seed complete');
  } finally {
    await pool.end();
  }
}
