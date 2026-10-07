/**
 * Gift ideas: "pour ma mère qui aime la vanille, moins de 10 000 DA" → women's perfumes with vanilla,
 * at most 10 000 DZD, in stock, best sellers first.
 * Rules understand who the gift is for (mother, father, wife… in three languages), prices and words; the
 * AI (when switched on) reads longer descriptions. If nothing matches the words, the filters alone are
 * used (and `relaxed` says so), so the shopper always gets ideas when the budget allows.
 */
import { z } from 'zod';
import type { Database } from '@aruma/db';
import { normalizeText, queryWords, rulesInterpreter, search } from '../search/index.js';
import type { StoreContext } from '../stores/index.js';
import { data, type AiLayer } from './gateway.js';

const FOR_WOMEN = ['ام', 'امي', 'والدتي', 'زوجتي', 'اختي', 'بنتي', 'ابنتي', 'خطيبتي', 'صديقتي', 'maman', 'mere', 'epouse', 'femme', 'soeur', 'fille', 'copine', 'mother', 'mom', 'mum', 'wife', 'sister', 'daughter', 'girlfriend', 'her'];
const FOR_MEN = ['اب', 'ابي', 'والدي', 'زوجي', 'اخي', 'ابني', 'خطيبي', 'صديقي', 'papa', 'pere', 'mari', 'frere', 'fils', 'copain', 'father', 'dad', 'husband', 'brother', 'son', 'boyfriend', 'him'];
const GIFT_WORDS = ['هديه', 'هدايا', 'cadeau', 'cadeaux', 'gift', 'gifts', 'offrir', 'aime', 'adore', 'likes', 'loves', 'يحب', 'تحب', 'qui', 'who'];

export type GiftInput = {
  forWhom?: string;
  gender?: 'men' | 'women' | 'unisex';
  budgetMin?: number;
  budgetMax?: number;
  likes?: string[];
  locale: string;
  currency: { code: string; minorUnits: number };
};

const aiSchema = z.object({
  gender: z.enum(['men', 'women', 'unisex']).nullish(),
  budgetMin: z.number().min(0).max(1e9).nullish(),
  budgetMax: z.number().min(0).max(1e9).nullish(),
  likes: z.array(z.string().min(1).max(32)).max(5),
});

export async function giftIdeas(db: Database, ai: AiLayer, store: StoreContext, input: GiftInput, userId?: string, options: { useAi?: boolean } = {}) {
  const text = (input.forWhom ?? '').slice(0, 300);
  const nl = text ? await rulesInterpreter.interpret(text, { locale: input.locale, currency: input.currency.code }) : { text: '', understood: [] };
  const words = queryWords(nl.text);
  const gender = words.some((w) => FOR_WOMEN.includes(w)) ? 'women' : words.some((w) => FOR_MEN.includes(w)) ? 'men' : nl.gender;
  let wanted = {
    gender: input.gender ?? gender,
    budgetMin: input.budgetMin ?? nl.priceMin,
    budgetMax: input.budgetMax ?? nl.priceMax,
    likes: [...(input.likes ?? []).map(normalizeText), ...words.filter((w) => !FOR_WOMEN.includes(w) && !FOR_MEN.includes(w) && !GIFT_WORDS.includes(w))].filter(Boolean).slice(0, 6),
  };
  let source: 'rules' | 'ai' = 'rules';

  if (options.useAi !== false && queryWords(text).length >= 3 && (await ai.enabled('gift_recommendations', store.id))) {
    const out = await ai.json({
      feature: 'gift_recommendations',
      scope: { storeId: store.id, userId },
      system: `A shopper describes who a perfume gift is for. Return {"gender": men|women|unisex|null, "budgetMin": number|null, "budgetMax": number|null (store currency ${input.currency.code}, major units), "likes": up to 5 single scent words the person likes (e.g. vanille, oud, rose, fresh), in the shopper's language}.`,
      prompt: data('gift', text),
      schema: aiSchema,
      maxTokens: 200,
      skipEnabledCheck: true,
    });
    if (out) {
      // What the shopper chose in the form always wins over what the AI understood.
      wanted = {
        gender: input.gender ?? out.gender ?? wanted.gender,
        budgetMin: input.budgetMin ?? out.budgetMin ?? wanted.budgetMin,
        budgetMax: input.budgetMax ?? out.budgetMax ?? wanted.budgetMax,
        likes: [...(input.likes ?? []), ...out.likes].map(normalizeText).filter(Boolean).slice(0, 6),
      };
      source = 'ai';
    }
  }

  const find = (q: string) =>
    search(db, store, {
      q,
      understand: false,
      log: false,
      gender: wanted.gender,
      priceMin: wanted.budgetMin,
      priceMax: wanted.budgetMax,
      inStock: true,
      sort: q ? 'relevance' : 'popular',
      page: 1,
      pageSize: 8,
      locale: input.locale,
      currency: input.currency,
    });
  // Likes are alternatives ("vanille or oud"): each word alone, best matches first, then the filters only.
  const seen = new Set<string>();
  const products = [];
  for (const like of wanted.likes) {
    for (const p of (await find(like)).results) if (!seen.has(p.id) && products.length < 8) seen.add(p.id), products.push(p);
  }
  const relaxed = products.length === 0;
  if (products.length < 4) for (const p of (await find('')).results) if (!seen.has(p.id) && products.length < 8) seen.add(p.id), products.push(p);
  return { understood: wanted, source, relaxed: wanted.likes.length > 0 && relaxed, products };
}
