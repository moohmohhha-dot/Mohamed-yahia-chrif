import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs, STORE, type Product, type Recommendations, type Review, type ReviewSummary } from '../api';
import { Bottle, hueOf } from '../components/Bottle';
import { ErrorBox, Grid, Loading, Section, Stars } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useLoad, useShop } from '../store';

function Notes({ notes }: { notes: NonNullable<Product['attributes']['notes']> }) {
  const { t, note } = useI18n();
  const levels = (['top', 'heart', 'base'] as const).filter((l) => notes[l]?.length);
  if (!levels.length) return null;
  return (
    <div className="pyramid" data-testid="notes">
      {levels.map((l) => (
        <div key={l} className={`tier tier-${l}`}>
          <span className="tier-label">{t(`notes.${l}` as MessageKey)}</span>
          <span>{notes[l]!.map(note).join(' · ')}</span>
        </div>
      ))}
    </div>
  );
}

function Reviews({ productId, slug }: { productId: string; slug: string }) {
  const { t, locale, date } = useI18n();
  const summary = useLoad(() => api<ReviewSummary>('GET', `/v1/stores/${STORE}/products/${slug}/review-summary?${qs({ locale })}`), [slug, locale]);
  const list = useLoad(() => api<{ reviews: Review[] }>('GET', `/v1/products/${productId}/reviews?sort=helpful`), [productId]);
  const s = summary.data;
  return (
    <Section title={t('reviews.title')} id="reviews">
      {!s ? (
        <Loading />
      ) : s.count === 0 ? (
        <p className="muted">{t('reviews.none')}</p>
      ) : (
        <div className="reviews">
          <div className="review-summary">
            <div className="review-score">
              <strong>{s.average?.toFixed(1)}</strong>
              <Stars value={s.average} />
              <span className="muted small">{t('reviews.count', { n: s.count })}</span>
            </div>
            <div className="dist">
              {[5, 4, 3, 2, 1].map((n) => (
                <div key={n} className="dist-row">
                  <span>{n}★</span>
                  <span className="dist-bar">
                    <span style={{ width: `${s.count ? ((s.distribution[n] ?? 0) / s.count) * 100 : 0}%` }} />
                  </span>
                  <span className="muted small">{s.distribution[n] ?? 0}</span>
                </div>
              ))}
            </div>
            {s.summary && (
              <div className="ai-summary" data-testid="review-summary-ai">
                <p>{s.summary.summary}</p>
                <div className="pros-cons">
                  <ul>
                    {s.summary.pros.map((p) => (
                      <li key={p}>＋ {p}</li>
                    ))}
                  </ul>
                  <ul>
                    {s.summary.cons.map((c) => (
                      <li key={c}>－ {c}</li>
                    ))}
                  </ul>
                </div>
                <p className="muted tiny">{t('ai.label')}</p>
              </div>
            )}
          </div>
          <div className="review-list">
            {list.data?.reviews.slice(0, 6).map((r) => (
              <article key={r.id} className="review">
                <div className="row-between">
                  <Stars value={r.rating} small />
                  <span className="muted small">{date(r.publishedAt)}</span>
                </div>
                {r.title && <strong>{r.title}</strong>}
                {r.body && <p>{r.body}</p>}
                <span className="muted small">
                  {r.author} {r.verifiedPurchase && <span className="chip chip-good">{t('reviews.verified')}</span>}
                </span>
                {r.merchantReply && (
                  <p className="reply">
                    <strong>{t('reviews.sellerReply', { seller: r.seller })}</strong> {r.merchantReply.text}
                  </p>
                )}
              </article>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

export function ProductPage() {
  const { slug = '' } = useParams();
  const { t, locale, money, ml } = useI18n();
  const shop = useShop();
  const product = useLoad(() => api<Product>('GET', `/v1/stores/${STORE}/products/${slug}?${qs({ locale })}`), [slug, locale]);
  const recs = useLoad(() => api<Recommendations>('GET', `/v1/stores/${STORE}/products/${slug}/recommendations?${qs({ locale })}`), [slug, locale]);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  useEffect(() => {
    setVariantId(null);
    setQuantity(1);
  }, [slug]);

  if (product.error) return <ErrorBox error={product.error} />;
  const p = product.data;
  if (!p) return <Loading />;
  const sellable = p.variants.filter((v) => v.price && v.offer);
  const variant = sellable.find((v) => v.id === variantId) ?? sellable.find((v) => v.inStock) ?? sellable[0];
  const comparing = shop.compare.includes(p.slug);

  const addToCart = () => {
    if (!variant?.offer || !variant.price) return;
    shop.add(
      {
        offerId: variant.offer.id,
        productSlug: p.slug,
        names: { [locale]: p.name },
        name: p.name,
        brand: p.brand?.name ?? null,
        sizeMl: variant.options.sizeMl ?? null,
        unitPriceMinor: variant.price.amountMinor,
        merchant: variant.offer.merchant.name,
        hue: hueOf(p.slug),
      },
      quantity,
    );
    shop.notify(t('cart.added', { name: p.name }));
  };

  return (
    <>
      <nav className="crumbs">
        <Link to="/">{t('nav.home')}</Link> / <Link to="/shop">{t('nav.shop')}</Link> / <span>{p.name}</span>
      </nav>
      <div className="product">
        <div className="product-media">{p.images[0] ? <img src={p.images[0].url} alt={p.images[0].alt ?? p.name} /> : <Bottle seed={p.slug} label={p.brand?.name} size="lg" />}</div>
        <div className="product-info">
          {p.brand && (
            <Link to={`/shop?${qs({ brand: p.brand.slug })}`} className="brand-line">
              {p.brand.name}
            </Link>
          )}
          <h1>{p.name}</h1>
          <div className="row">
            <a href="#reviews" className="plain">
              <Stars value={p.rating.average} count={p.rating.count} />
            </a>
          </div>
          <div className="tags">
            {p.attributes.concentration && <span className="chip">{p.attributes.concentration.toUpperCase()}</span>}
            {p.attributes.gender && <span className="chip">{t(`gender.${p.attributes.gender}` as MessageKey)}</span>}
          </div>
          {p.description && <p className="description">{p.description}</p>}
          {p.attributes.notes && <Notes notes={p.attributes.notes} />}

          {sellable.length === 0 ? (
            <p className="alert alert-bad">{t('product.unavailable')}</p>
          ) : (
            <div className="buy-box">
              <div className="sizes" role="radiogroup" aria-label={t('product.size')}>
                {sellable.map((v) => (
                  <button key={v.id} role="radio" aria-checked={v.id === variant?.id} className={`size${v.id === variant?.id ? ' selected' : ''}`} onClick={() => setVariantId(v.id)} data-testid="size">
                    <strong>{v.options.sizeMl ? ml(v.options.sizeMl) : v.sku}</strong>
                    <span>{money(v.price!.amountMinor)}</span>
                    {!v.inStock && <span className="muted tiny">{t('product.outOfStock')}</span>}
                  </button>
                ))}
              </div>
              {variant?.price && (
                <div className="price-line">
                  <span className="price-big" data-testid="price">
                    {money(variant.price.amountMinor * quantity)}
                  </span>
                  {variant.compareAtPrice && <s className="muted">{money(variant.compareAtPrice.amountMinor * quantity)}</s>}
                  {variant.options.sizeMl && <span className="muted small">{t('product.per100', { price: money(Math.round((variant.price.amountMinor * 100) / variant.options.sizeMl)) })}</span>}
                </div>
              )}
              <div className="row">
                <div className="qty">
                  <button onClick={() => setQuantity(Math.max(1, quantity - 1))} aria-label="−">
                    −
                  </button>
                  <span aria-live="polite">{quantity}</span>
                  <button onClick={() => setQuantity(Math.min(10, quantity + 1))} aria-label="+">
                    +
                  </button>
                </div>
                <button className="btn btn-primary btn-lg grow" disabled={!variant?.inStock} onClick={addToCart} data-testid="add-to-cart">
                  {variant?.inStock ? t('product.addToCart') : t('product.outOfStock')}
                </button>
              </div>
              <button className={`link${comparing ? ' on' : ''}`} onClick={() => shop.toggleCompare(p.slug)}>
                {comparing ? t('compare.remove') : t('compare.add')}
              </button>
              <ul className="assurances">
                <li>{t('product.cod')}</li>
                <li>{t('product.delivery')}</li>
                {variant?.offer && (
                  <li>
                    {t('product.soldBy', { seller: variant.offer.merchant.name })}
                    {variant.offerCount > 1 && ` · ${t('product.otherSellers', { n: variant.offerCount - 1 })}`}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      </div>

      {recs.data?.bundle && (
        <Section title={t('bundle.title')}>
          <div className="bundle" data-testid="bundle">
            {recs.data.bundle.items.map((item, i) => (
              <div key={item.id} className="bundle-item">
                {i > 0 && <span className="plus">+</span>}
                <Link to={`/p/${item.slug}`} className="bundle-card">
                  <Bottle seed={item.slug} label={item.brand} size="sm" />
                  <span>{item.name}</span>
                  <strong>{money(item.priceFrom.amountMinor)}</strong>
                </Link>
              </div>
            ))}
            <div className="bundle-total">
              <span className="muted">{t(recs.data.bundle.basis === 'bought_together' ? 'bundle.together' : 'bundle.sameBrand')}</span>
              <strong>{money(recs.data.bundle.total.amountMinor)}</strong>
            </div>
          </div>
        </Section>
      )}
      <Reviews productId={p.id} slug={p.slug} />
      {recs.data && recs.data.similar.length > 0 && (
        <Section title={t('product.similar')}>
          <Grid products={recs.data.similar.slice(0, 4)} />
        </Section>
      )}
    </>
  );
}
