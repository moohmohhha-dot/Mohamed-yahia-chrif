import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type Card } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { Bottle } from './Bottle';

export function Stars({ value, count, small }: { value: number | null; count?: number; small?: boolean }) {
  const { t } = useI18n();
  if (value === null || count === 0) return small ? null : <span className="muted small">{t('product.noReviews')}</span>;
  const full = Math.round(value);
  return (
    <span className={`stars${small ? ' small' : ''}`} aria-label={t('product.ratingOf', { n: value.toFixed(1) })}>
      <span aria-hidden="true">{'★'.repeat(full)}<span className="stars-off">{'★'.repeat(5 - full)}</span></span>
      <span className="muted"> {value.toFixed(1)}{count !== undefined && ` (${count})`}</span>
    </span>
  );
}

export function ProductCard({ p }: { p: Card }) {
  const { t, money } = useI18n();
  return (
    <Link to={`/p/${p.slug}`} className="card-product" data-testid="product-card">
      <div className="card-media">
        {p.image ? <img src={p.image.url} alt={p.image.alt ?? p.name} /> : <Bottle seed={p.slug} label={p.brand} />}
        {!p.inStock && <span className="chip chip-muted">{t('product.outOfStock')}</span>}
      </div>
      <div className="card-body">
        <span className="brand-line">{p.brand}</span>
        <strong className="card-name">{p.name}</strong>
        <span className="card-meta">
          {p.attributes.concentration && <span>{String(p.attributes.concentration).toUpperCase()}</span>}
          {p.attributes.gender && <span>{t(`gender.${p.attributes.gender}` as MessageKey)}</span>}
        </span>
        <span className="card-foot">
          <span className="price">
            <span className="muted small">{t('product.from')} </span>
            {money(p.priceFrom.amountMinor, p.priceFrom.currency)}
          </span>
          <Stars value={p.rating.average} count={p.rating.count} small />
        </span>
      </div>
    </Link>
  );
}

export function Grid({ products, empty }: { products: Card[]; empty?: ReactNode }) {
  if (!products.length) return <>{empty ?? null}</>;
  return (
    <div className="product-grid">
      {products.map((p) => (
        <ProductCard key={p.id} p={p} />
      ))}
    </div>
  );
}

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="loading" role="status">
      {t('common.loading')}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : 'ERROR';
  const known = `err.${code}` as MessageKey;
  return (
    <p className="alert alert-bad" role="alert">
      {t(known) !== known ? t(known) : error instanceof ApiError ? error.message : t('err.generic')}
    </p>
  );
}

export function Section({ title, action, children, id }: { title: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" id={id}>
      <div className="section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
