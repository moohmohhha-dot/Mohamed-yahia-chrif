/**
 * Search engine (PostgreSQL full-text + trigrams): Arabic, French, English, synonyms, typo correction,
 * autocomplete, filters, facets, sorting, natural-language queries (rules today; AI and voice ready).
 */
export { searchRoutes } from './routes.js';
export { processSearchQueue, queueAllProducts } from './indexer.js';
export { productCards, purgeOldQueries, search, type ProductCard, type SearchInput } from './service.js';
export { normalizeText, queryWords } from './normalize.js';
export { rulesInterpreter, type Interpretation, type QueryInterpreter, type SortKey } from './interpret.js';
