/**
 * Natural-language search with AI: the rules (search/interpret.ts) answer first; the AI is asked only
 * for long sentences the rules did not understand ("un parfum frais pour l'été, pas trop cher, pour mon
 * père"). Whatever the AI says is checked against a strict shape; if it fails or is slow, the rules'
 * answer is used. The search itself never depends on the AI.
 */
import { z } from 'zod';
import { queryWords, rulesInterpreter, type Interpretation, type QueryInterpreter } from '../search/index.js';
import { data, type AiLayer } from './gateway.js';

const answer = z.object({
  words: z.string().max(200),
  priceMin: z.number().min(0).max(1e9).nullish(),
  priceMax: z.number().min(0).max(1e9).nullish(),
  gender: z.enum(['men', 'women', 'unisex']).nullish(),
  concentration: z.enum(['EDP', 'EDT', 'EDC', 'parfum', 'extrait']).nullish(),
  ratingMin: z.number().min(1).max(5).nullish(),
  inStock: z.boolean().nullish(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'newest', 'popular']).nullish(),
});

const SYSTEM = [
  'You turn a shopper\'s search sentence into search filters for a perfume store.',
  'Return: {"words": the product words to search (keep the shopper\'s language, drop filler words), "priceMin", "priceMax" (numbers in the store currency, major units), "gender" (men|women|unisex), "concentration" (EDP|EDT|EDC|parfum|extrait), "ratingMin" (1-5), "inStock" (boolean), "sort" (relevance|price_asc|price_desc|rating|newest|popular)}.',
  'Use null for anything the sentence does not say. A gift for a father, husband or brother means men; for a mother, wife or sister means women.',
].join('\n');

/** Long sentences: at least this many words, and nothing the rules understood. */
const MIN_WORDS = 4;

export function aiInterpreter(ai: AiLayer, storeId: string): QueryInterpreter {
  return {
    async interpret(text, context) {
      const rules = await rulesInterpreter.interpret(text, context);
      if (rules.understood.length > 0 || queryWords(text).length < MIN_WORDS) return rules;
      const out = await ai.json({
        feature: 'natural_language_search',
        scope: { storeId },
        system: SYSTEM,
        prompt: `Store currency: ${context.currency}.\n${data('search', text)}`,
        schema: answer,
        maxTokens: 300,
        skipEnabledCheck: true,
      });
      if (!out) return rules;
      const result: Interpretation = { text: out.words, understood: [] };
      const note = (kind: string, value: string | number) => result.understood.push({ kind, value, phrase: '' });
      if (out.priceMin != null) (result.priceMin = out.priceMin), note('priceMin', out.priceMin);
      if (out.priceMax != null) (result.priceMax = out.priceMax), note('priceMax', out.priceMax);
      if (out.gender) (result.gender = out.gender), note('gender', out.gender);
      if (out.concentration) (result.concentration = out.concentration), note('concentration', out.concentration);
      if (out.ratingMin != null) (result.ratingMin = out.ratingMin), note('ratingMin', out.ratingMin);
      if (out.inStock) (result.inStock = true), note('inStock', 'true');
      if (out.sort && out.sort !== 'relevance') (result.sort = out.sort), note('sort', out.sort);
      return result;
    },
  };
}

/** The interpreter for a store's searches: with AI when switched on for that store, otherwise the rules. */
export const interpreterFor = (ai: AiLayer) => async (storeId: string): Promise<QueryInterpreter> =>
  (await ai.enabled('natural_language_search', storeId)) ? aiInterpreter(ai, storeId) : rulesInterpreter;
