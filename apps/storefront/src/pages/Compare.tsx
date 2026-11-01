import { Link } from 'react-router-dom';
import { api, qs, STORE, type Card, type Money } from '../api';
import { Bottle } from '../components/Bottle';
import { ErrorBox, Loading, Stars } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useLoad, useShop } from '../store';

type Row = { product: Card; sizes: { sizeMl: number | null; price: Money; per100ml: Money | null; inStock: boolean }[]; notes: { top: string[]; heart: string[]; base: string[] }; gender: string | null; concentration: string | null };
type Comparison = { products: Row[]; highlights: { cheapest: string | null; bestValue: string | null; bestRated: string | null; inStock: string[] }; summary: { summary: string; bestFor: { slug: string; reason: string }[] } | null };

export function ComparePage() {
  const { t, locale, money, note, ml } = useI18n();
  const { compare, toggleCompare } = useShop();
  const enough = compare.length >= 2;
  const result = useLoad(() => (enough ? api<Comparison>('GET', `/v1/stores/${STORE}/compare?${qs({ products: compare.join(','), locale })}`) : Promise.resolve(null)), [compare.join(','), locale]);

  if (!enough)
    return (
      <div className="narrow">
        <h1>{t('compare.title')}</h1>
        <p className="lead">{t('compare.empty')}</p>
        <Link to="/shop" className="btn btn-primary">
          {t('home.shopAll')}
        </Link>
      </div>
    );
  const c = result.data;
  const badge = (slug: string) =>
    (['cheapest', 'bestValue', 'bestRated'] as const)
      .filter((k) => c?.highlights[k] === slug)
      .map((k) => (
        <span key={k} className="chip chip-accent">
          {t(`compare.${k}` as MessageKey)}
        </span>
      ));
  return (
    <>
      <h1>{t('compare.title')}</h1>
      <ErrorBox error={result.error} />
      {!c ? (
        <Loading />
      ) : (
        <>
          {c.summary && (
            <div className="ai-summary" data-testid="compare-summary">
              <p>{c.summary.summary}</p>
              <p className="muted tiny">{t('ai.label')}</p>
            </div>
          )}
          <div className="table-scroll">
            <table className="compare" data-testid="compare-table">
              <thead>
                <tr>
                  <th />
                  {c.products.map((r) => (
                    <th key={r.product.slug}>
                      <Link to={`/p/${r.product.slug}`} className="compare-head">
                        <Bottle seed={r.product.slug} label={r.product.brand} size="sm" />
                        <strong>{r.product.name}</strong>
                        <span className="muted small">{r.product.brand}</span>
                      </Link>
                      <div className="chips">{badge(r.product.slug)}</div>
                      <button className="link small" onClick={() => toggleCompare(r.product.slug)}>
                        {t('compare.remove')}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{t('compare.sizes')}</th>
                  {c.products.map((r) => (
                    <td key={r.product.slug}>
                      {r.sizes.map((s, i) => (
                        <div key={i}>
                          {s.sizeMl ? ml(s.sizeMl) : ''} · <strong>{money(s.price.amountMinor)}</strong>
                        </div>
                      ))}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>{t('compare.per100')}</th>
                  {c.products.map((r) => (
                    <td key={r.product.slug} className="num">
                      {r.sizes[0]?.per100ml ? money(Math.min(...r.sizes.map((s) => s.per100ml?.amountMinor ?? Infinity))) : '—'}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>{t('compare.type')}</th>
                  {c.products.map((r) => (
                    <td key={r.product.slug}>
                      {[r.concentration?.toUpperCase(), r.gender ? t(`gender.${r.gender}` as MessageKey) : null].filter(Boolean).join(' · ')}
                    </td>
                  ))}
                </tr>
                {(['top', 'heart', 'base'] as const).map((level) => (
                  <tr key={level}>
                    <th>{t(`notes.${level}` as MessageKey)}</th>
                    {c.products.map((r) => (
                      <td key={r.product.slug}>{r.notes[level].map(note).join(' · ') || '—'}</td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th>{t('compare.rating')}</th>
                  {c.products.map((r) => (
                    <td key={r.product.slug}>
                      <Stars value={r.product.rating.average} count={r.product.rating.count} small />
                      {r.product.rating.count === 0 && <span className="muted small">—</span>}
                    </td>
                  ))}
                </tr>
                {c.summary && c.summary.bestFor.length > 0 && (
                  <tr>
                    <th>{t('compare.bestFor')}</th>
                    {c.products.map((r) => (
                      <td key={r.product.slug}>{c.summary!.bestFor.find((b) => b.slug === r.product.slug)?.reason ?? '—'}</td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
