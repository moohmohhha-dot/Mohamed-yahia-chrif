/**
 * One normalisation for indexing and for queries, so that the same word written differently matches:
 * - Arabic: diacritics (harakat) and tatweel removed; أ إ آ ٱ → ا; ة → ه; ى → ي; ؤ → و; ئ → ي;
 *   the article "ال" (and "وال", "بال", "لل"…) dropped from words; Arabic-Indic digits → 0-9.
 * - French / English: lower case, accents removed (é → e), œ → oe, æ → ae.
 * - Anything that is not a letter or a digit separates words.
 */
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const ARABIC_ARTICLE = /^(?:[وفبكل]?ال|لل)(?=\p{L}{3,})/u;

export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/ٱ/g, 'ا') // alef wasla
    .normalize('NFD') // أ = ا + hamza, é = e + accent…
    .replace(/\p{M}/gu, '') // …then every mark goes (Arabic harakat included)
    .replace(/ـ/g, '') // tatweel
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(ARABIC_ARTICLE, ''))
    .join(' ');
}

/** Words of a query, normalised, without words that carry no meaning in a search. */
export function queryWords(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 12);
}

export const isArabic = (text: string) => /\p{Script=Arabic}/u.test(text);

/** Common words of the three languages (already normalised). */
export const STOPWORDS = new Set([
  // fr
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'et', 'ou', 'a', 'au', 'aux', 'en', 'pour', 'par', 'avec', 'sans', 'sur', 'dans', 'je', 'veux', 'cherche', 'un', 'mon', 'ma', 'mes',
  // en
  'the', 'an', 'of', 'and', 'or', 'for', 'with', 'without', 'in', 'on', 'to', 'i', 'want', 'need', 'looking', 'my', 'some',
  // ar
  'في', 'من', 'علي', 'الي', 'عن', 'مع', 'او', 'و', 'ل', 'ب', 'هذا', 'هذه', 'اريد', 'ابحث', 'عايز', 'نحب', 'بغيت',
]);
