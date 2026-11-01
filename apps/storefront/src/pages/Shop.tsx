import { useSearchParams } from 'react-router-dom';
import { api, qs, STORE, type SearchResult } from '../api';
import { ErrorBox, Grid, Loading } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useLoad } from '../store';

const SORTS = ['relevance', 'popular', 'price_asc', 'price_desc', 'rating', 'newest'] as const;
const KEYS = ['q', 'category', 'brand', 'gender', 'priceMax', 'inStock', 'sort', 'page'] as const;

/** Catalogue and search: words in any of the three languages, filters, sorting, typo correction. */
export function ShopPage() {
  const { t, tx, locale, money } = useI18n();
  const [params, setParams] = useSearchParams();
  const get = (k: (typeof KEYS)[number]) => params.get(k) ?? '';
  const query = Object.fromEntries(KEYS.map((k) => [k, get(k)]));
  const result = useLoad(() => api<SearchResult>('GET', `/v1/stores/${STORE}/search?${qs({ ...query, locale, pageSize: 24 })}`), [params.toString(), locale]);
  const set = (patch: Partial<Record<(typeof KEYS)[number], string>>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };
  const r = result.data;
  const active = KEYS.filter((k) => k !== 'page' && k !== 'sort' && get(k));

  return (
    <div className="shop">
      <div className="shop-head">
        <h1>{get('q') ? t('shop.resultsFor', { q: get('q') }) : t('shop.title')}</h1>
        {r && <span className="muted">{t('shop.count', { n: r.meta.total })}</span>}
      </div>
      {r?.query.correctedFrom && (
        <p className="note" data-testid="corrected">
          {t('shop.corrected', { q: r.query.words.join(' '), from: r.query.correctedFrom })}
        </p>
      )}
      {r?.query.suggestion && (
        <p className="note">
          {t('shop.didYouMean')}{' '}
          <button className="link" onClick={() => set({ q: r.query.suggestion! })}>
            {r.query.suggestion}
          </button>
        </p>
      )}
      {r && r.query.understood.length > 0 && (
        <div className="chips" data-testid="understood">
          <span className="muted small">{t('shop.understood')}</span>
          {r.query.understood.map((u, i) => (
            <span key={i} className="chip">
              {u.kind === 'gender' ? tx(`gender.${u.value}`, 'shop.filter') : u.kind === 'priceMax' ? t('shop.max', { price: money(Number(u.value) * 100) }) : u.kind === 'priceMin' ? t('shop.min', { price: money(Number(u.value) * 100) }) : u.kind === 'sort' ? tx(`sort.${u.value}`, 'shop.filter') : String(u.value)}
            </span>
          ))}
        </div>
      )}
      <div className="shop-body">
        <aside className="filters">
          <details open className="filter-box">
            <summary>{t('shop.filters')}</summary>
            {r && r.facets.categories.length > 0 && (
              <fieldset>
                <legend>{t('shop.family')}</legend>
                {r.facets.categories.map((c) => (
                  <label key={c.slug} className="check">
                    <input type="radio" name="category" checked={get('category') === c.slug} onChange={() => set({ category: c.slug })} />
                    {c.name} <span className="muted">({c.count})</span>
                  </label>
                ))}
              </fieldset>
            )}
            <fieldset>
              <legend>{t('shop.for')}</legend>
              {(['women', 'men', 'unisex'] as const).map((g) => (
                <label key={g} className="check">
                  <input type="radio" name="gender" checked={get('gender') === g} onChange={() => set({ gender: g })} />
                  {t(`gender.${g}`)}
                </label>
              ))}
            </fieldset>
            {r && r.facets.brands.length > 0 && (
              <fieldset>
                <legend>{t('shop.brand')}</legend>
                {r.facets.brands.map((b) => (
                  <label key={b.slug} className="check">
                    <input type="radio" name="brand" checked={get('brand') === b.slug} onChange={() => set({ brand: b.slug })} />
                    {b.name} <span className="muted">({b.count})</span>
                  </label>
                ))}
              </fieldset>
            )}
            <fieldset>
              <legend>{t('shop.budget')}</legend>
              {[6000, 9000, 12000, 18000].map((max) => (
                <label key={max} className="check">
                  <input type="radio" name="priceMax" checked={get('priceMax') === String(max)} onChange={() => set({ priceMax: String(max) })} />
                  {t('shop.max', { price: money(max * 100) })}
                </label>
              ))}
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={get('inStock') === 'true'} onChange={(e) => set({ inStock: e.target.checked ? 'true' : '' })} />
              {t('shop.inStock')}
            </label>
            {active.length > 0 && (
              <button className="link" onClick={() => setParams(new URLSearchParams(get('q') ? { q: get('q') } : {}))}>
                {t('shop.clear')}
              </button>
            )}
          </details>
        </aside>
        <div className="results">
          <div className="results-bar">
            <label className="sort">
              {t('shop.sort')}
              <select id="sort" value={get('sort') || (get('q') ? 'relevance' : 'popular')} onChange={(e) => set({ sort: e.target.value })}>
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`sort.${s}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ErrorBox error={result.error} />
          {!r ? (
            <Loading />
          ) : (
            <Grid products={r.results} empty={<p className="empty">{t('shop.none')}</p>} />
          )}
          {r && r.meta.totalPages > 1 && (
            <div className="pager">
              {Array.from({ length: r.meta.totalPages }, (_, i) => i + 1).map((n) => (
                <button key={n} className={n === r.meta.page ? 'active' : ''} onClick={() => set({ page: String(n) })}>
                  {n}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
