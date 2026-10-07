/**
 * Natural-language search, rule-based today: understands price limits, gender, concentration, rating,
 * stock and "cheapest / newest / best sellers" in Arabic, French and English, and keeps the rest as the
 * words to search. "عطر رجالي أقل من 8000 دج" → words "عطر", gender men, price ≤ 8 000 DZD.
 *
 * It sits behind the `QueryInterpreter` interface: an AI interpreter (a language model turning any
 * sentence into the same structure) can replace or complete it later without touching the search itself.
 * Voice search uses it too: the phone turns speech into text, this turns text into a search.
 */
import { normalizeText } from './normalize.js';

export type SortKey = 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'newest' | 'popular';
export type Interpretation = {
  /** The words left to search. */
  text: string;
  priceMin?: number; // major units of the store currency
  priceMax?: number;
  gender?: 'men' | 'women' | 'unisex';
  concentration?: string;
  ratingMin?: number;
  inStock?: boolean;
  sort?: SortKey;
  /** What was understood, for the "chips" the shopper can remove. */
  understood: { kind: string; value: string | number; phrase: string }[];
};

export interface QueryInterpreter {
  interpret(text: string, context: { locale: string; currency: string }): Promise<Interpretation>;
}

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)\s*(k|الف|الاف|mille)?`;
const CURRENCY = String.raw`(?:\s*(?:da|dzd|dinars?|دج|دينار|دنانير|eur|euros?|€|usd|\$|dollars?))?`;
const toAmount = (n: string, k?: string) => Number(n.replace(',', '.')) * (k ? 1000 : 1);

type Rule = { re: RegExp; apply: (m: RegExpMatchArray, out: Interpretation) => void };
const rules: Rule[] = [
  {
    re: new RegExp(String.raw`(?:entre|between|بين)\s+${NUMBER}${CURRENCY}\s+(?:et|and|و)\s*${NUMBER}${CURRENCY}`),
    apply: (m, o) => {
      o.priceMin = toAmount(m[1]!, m[2]);
      o.priceMax = toAmount(m[3]!, m[4]);
      o.understood.push({ kind: 'price_range', value: `${o.priceMin}-${o.priceMax}`, phrase: m[0] });
    },
  },
  {
    re: new RegExp(String.raw`(?:moins de|moins que|max(?:imum)?|jusqu a|sous|pas plus de|under|less than|below|up to|cheaper than|اقل من|تحت|حتي|لا يتجاوز|اقصي)\s*${NUMBER}${CURRENCY}`),
    apply: (m, o) => {
      o.priceMax = toAmount(m[1]!, m[2]);
      o.understood.push({ kind: 'price_max', value: o.priceMax, phrase: m[0] });
    },
  },
  {
    re: new RegExp(String.raw`(?:plus de|au dessus de|a partir de|min(?:imum)?|over|more than|above|from|اكثر من|فوق|ابتداء من)\s*${NUMBER}${CURRENCY}`),
    apply: (m, o) => {
      o.priceMin = toAmount(m[1]!, m[2]);
      o.understood.push({ kind: 'price_min', value: o.priceMin, phrase: m[0] });
    },
  },
  {
    re: /(?:(\d)\s*(?:etoiles?|stars?|نجوم|نجمات|نجمه)(?:\s*(?:et plus|and up|او اكثر|\+))?)/,
    apply: (m, o) => {
      o.ratingMin = Number(m[1]);
      o.understood.push({ kind: 'rating_min', value: o.ratingMin, phrase: m[0] });
    },
  },
  {
    re: /\b(?:pour homme|pour hommes|hommes?|masculin|for men|men s|mens|men|man|male)\b|(?:رجاليه|رجالي|رجال)/,
    apply: (m, o) => {
      o.gender = 'men';
      o.understood.push({ kind: 'gender', value: 'men', phrase: m[0] });
    },
  },
  {
    re: /\b(?:pour femme|pour femmes|femmes?|feminin|for women|womens|women|woman|female)\b|(?:نساييه|نسايي|نساء|نسويه|نسوي)/,
    apply: (m, o) => {
      o.gender = 'women';
      o.understood.push({ kind: 'gender', value: 'women', phrase: m[0] });
    },
  },
  {
    re: /\b(?:mixte|unisexe|unisex)\b|(?:للجنسين|مشترك)/,
    apply: (m, o) => {
      o.gender = 'unisex';
      o.understood.push({ kind: 'gender', value: 'unisex', phrase: m[0] });
    },
  },
  {
    re: /\b(?:eau de parfum|edp)\b/,
    apply: (m, o) => {
      o.concentration = 'edp';
      o.understood.push({ kind: 'concentration', value: 'EDP', phrase: m[0] });
    },
  },
  {
    re: /\b(?:eau de toilette|edt)\b/,
    apply: (m, o) => {
      o.concentration = 'edt';
      o.understood.push({ kind: 'concentration', value: 'EDT', phrase: m[0] });
    },
  },
  {
    re: /\b(?:en stock|disponibles?|in stock|available)\b|(?:متوفر|متاح)/,
    apply: (m, o) => {
      o.inStock = true;
      o.understood.push({ kind: 'in_stock', value: 'yes', phrase: m[0] });
    },
  },
  {
    re: /\b(?:pas cher|moins cher|le moins cher|bon marche|cheapest|cheap|budget|affordable)\b|(?:الارخص|ارخص|رخيص)/,
    apply: (m, o) => {
      o.sort = 'price_asc';
      o.understood.push({ kind: 'sort', value: 'price_asc', phrase: m[0] });
    },
  },
  {
    re: /\b(?:le plus cher|most expensive|haut de gamme|premium)\b|(?:الاغلي|غالي)/,
    apply: (m, o) => {
      o.sort = 'price_desc';
      o.understood.push({ kind: 'sort', value: 'price_desc', phrase: m[0] });
    },
  },
  {
    re: /\b(?:mieux notes?|meilleurs? avis|best rated|top rated|highest rated)\b|(?:الاعلي تقييما|افضل تقييم)/,
    apply: (m, o) => {
      o.sort = 'rating';
      o.understood.push({ kind: 'sort', value: 'rating', phrase: m[0] });
    },
  },
  {
    re: /\b(?:nouveautes?|nouveaux?|nouvelles?|new arrivals?|newest|latest|new)\b|(?:جديد|احدث)/,
    apply: (m, o) => {
      o.sort = 'newest';
      o.understood.push({ kind: 'sort', value: 'newest', phrase: m[0] });
    },
  },
  {
    re: /\b(?:meilleures? ventes?|best sellers?|bestsellers?|populaires?|popular|trending)\b|(?:الاكثر مبيعا|الاكثر طلبا)/,
    apply: (m, o) => {
      o.sort = 'popular';
      o.understood.push({ kind: 'sort', value: 'popular', phrase: m[0] });
    },
  },
];

export const rulesInterpreter: QueryInterpreter = {
  async interpret(raw) {
    // "7 000" / "7.000" → "7000" (thousands written with a separator).
    let text = ` ${normalizeText(raw).replace(/(\d) (?=\d{3}\b)/g, '$1')} `;
    const out: Interpretation = { text: '', understood: [] };
    for (const rule of rules) {
      const m = text.match(rule.re);
      if (!m) continue;
      rule.apply(m, out);
      text = text.replace(m[0], ' ');
    }
    out.text = text.replace(/\s+/g, ' ').trim();
    return out;
  },
};
