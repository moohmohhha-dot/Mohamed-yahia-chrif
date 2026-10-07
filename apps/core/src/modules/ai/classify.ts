/**
 * Product classification for merchants adding a product: suggests the category, brand, gender and
 * concentration from the name and description. Rules find what is written ("Eau de Parfum", "pour
 * homme", a brand or category name); the AI (when switched on) also reads between the lines. Only
 * existing categories and brands can be suggested. It is a suggestion: the merchant fills the product
 * form as usual, and the product still goes through the normal checks.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, type Database } from '@aruma/db';
import { notFound } from '../../shared/errors.js';
import { requireMembership } from '../merchants/index.js';
import { normalizeText } from '../search/index.js';
import { data, type AiLayer } from './gateway.js';

const GENDER: Record<'men' | 'women' | 'unisex', string[]> = {
  men: ['homme', 'hommes', 'men', 'man', 'masculin', 'رجالي', 'رجال', 'للرجال'],
  women: ['femme', 'femmes', 'women', 'woman', 'feminin', 'نسايي', 'نساء', 'نسايه'],
  unisex: ['mixte', 'unisex', 'unisexe', 'للجنسين'],
};
const CONCENTRATION: [RegExp, string][] = [
  [/\b(extrait|parfum extrait)\b/, 'extrait'],
  [/\b(edp|eau de parfum)\b|ماء عطر/, 'edp'],
  [/\b(edt|eau de toilette)\b/, 'edt'],
  [/\b(edc|eau de cologne|cologne)\b|كولونيا/, 'edc'],
];

const aiSchema = z.object({
  categories: z.array(z.string().max(96)).max(3),
  brand: z.string().max(96).nullish(),
  gender: z.enum(['men', 'women', 'unisex']).nullish(),
  concentration: z.enum(['edp', 'edt', 'edc', 'extrait', 'parfum']).nullish(),
});

export async function classifyProduct(db: Database, ai: AiLayer, userId: string, merchantId: string, input: { storeSlug: string; name: string; description?: string; locale: string }) {
  await requireMembership(db, merchantId, userId);
  const [store] = await db.select({ id: s.stores.id }).from(s.stores).where(eq(s.stores.slug, input.storeSlug));
  if (!store) throw notFound('Store');
  const categories = await db.select({ id: s.categories.id, slug: s.categories.slug }).from(s.categories).where(and(eq(s.categories.storeId, store.id), eq(s.categories.status, 'active')));
  const names = categories.length ? await db.select().from(s.categoryTranslations).where(inArray(s.categoryTranslations.categoryId, categories.map((c) => c.id))) : [];
  const brands = await db.select({ slug: s.brands.slug, name: s.brands.name }).from(s.brands).where(eq(s.brands.storeId, store.id));
  const catalog = categories.map((c) => ({ slug: c.slug, names: Object.fromEntries(names.filter((n) => n.categoryId === c.id).map((n) => [n.locale, n.name])) as Record<string, string> }));

  const text = ` ${normalizeText(`${input.name} ${input.description ?? ''}`)} `;
  const has = (phrase: string) => {
    const p = normalizeText(phrase);
    return p.length > 1 && text.includes(` ${p} `);
  };
  let result = {
    categories: catalog.filter((c) => [c.slug.replace(/-/g, ' '), ...Object.values(c.names)].some(has)).map((c) => c.slug).slice(0, 3),
    brand: brands.find((b) => has(b.name) || has(b.slug.replace(/-/g, ' ')))?.slug ?? null,
    gender: (Object.entries(GENDER).find(([, words]) => words.some((w) => text.includes(` ${w} `)))?.[0] ?? null) as 'men' | 'women' | 'unisex' | null,
    concentration: CONCENTRATION.find(([re]) => re.test(text))?.[1] ?? null,
  };
  let source: 'rules' | 'ai' = 'rules';

  const out = await ai.json({
    feature: 'product_classification',
    scope: { merchantId, userId },
    system: 'You classify a perfume listing. Choose up to 3 category slugs and at most one brand slug ONLY from the lists given (or none), and the gender and concentration if the text implies them. Return {"categories": [slugs], "brand": slug|null, "gender": men|women|unisex|null, "concentration": edp|edt|edc|extrait|parfum|null}.',
    prompt: [data('categories', catalog), data('brands', brands), data('product', { name: input.name, description: input.description ?? '' })].join('\n'),
    schema: aiSchema,
    maxTokens: 200,
  });
  if (out) {
    // Only what exists in this store; what the rules read in the text stays when the AI has nothing.
    result = {
      categories: out.categories.filter((slug) => catalog.some((c) => c.slug === slug)).slice(0, 3),
      brand: out.brand && brands.some((b) => b.slug === out.brand) ? out.brand : result.brand,
      gender: out.gender ?? result.gender,
      concentration: out.concentration ?? result.concentration,
    };
    if (!result.categories.length) result.categories = catalog.filter((c) => [c.slug, ...Object.values(c.names)].some(has)).map((c) => c.slug).slice(0, 3);
    source = 'ai';
  }
  const label = (c: (typeof catalog)[number]) => c.names[input.locale] ?? c.names.fr ?? Object.values(c.names)[0] ?? c.slug;
  return {
    categories: result.categories.map((slug) => catalog.find((c) => c.slug === slug)!).map((c) => ({ slug: c.slug, name: label(c) })),
    brand: result.brand ? brands.find((b) => b.slug === result.brand)! : null,
    attributes: { gender: result.gender, concentration: result.concentration },
    source,
  };
}
