import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, ErrorBox, Field, Loading, StatusBadge, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';
import { can, useMerchant } from '../merchant-context';
import { loadStore, nameIn, sizeLabel, type Product, type StoreInfo } from './common';

type MerchantStore = { storeSlug: string; storeName: string; status: string };
type Category = { slug: string; name: string };

export function ProductsPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const products = useLoad(() => api<Product[]>('GET', `/v1/merchants/${merchant.id}/products`), [merchant.id]);
  const stores = useLoad(() => api<MerchantStore[]>('GET', `/v1/merchants/${merchant.id}/stores`), [merchant.id]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const status = useAction();
  const manage = can(merchant.role, 'manageProducts');

  const setStatus = (p: Product, next: Product['status']) =>
    status.run(async () => {
      await api('PATCH', `/v1/merchants/${merchant.id}/products/${p.id}`, { status: next });
      await products.reload();
    });

  const activeStores = (stores.data ?? []).filter((s) => s.status === 'active');
  return (
    <>
      <div className="topbar">
        <h1>{t('section.products')}</h1>
        {manage && activeStores.length > 0 && editing !== 'new' && (
          <button className="primary" onClick={() => setEditing('new')}>
            {t('products.new')}
          </button>
        )}
      </div>
      {stores.data && activeStores.length === 0 && <div className="alert alert-warn">{t('dash.noStores')}</div>}
      {editing === 'new' && (
        <ProductForm stores={activeStores} onDone={() => (setEditing(null), void products.reload())} onCancel={() => setEditing(null)} />
      )}
      <ErrorBox error={products.error ?? status.error} />
      {!products.data ? (
        <Loading />
      ) : products.data.length === 0 ? (
        <p className="muted">{t('products.empty')}</p>
      ) : (
        products.data.map((p) =>
          editing === p.id ? (
            <ProductForm key={p.id} product={p} stores={activeStores} onDone={() => (setEditing(null), void products.reload())} onCancel={() => setEditing(null)} />
          ) : (
            <Card
              key={p.id}
              title={nameIn(p.translations, locale)}
              actions={
                <>
                  <StatusBadge status={p.status} />
                  {manage && (
                    <>
                      <button onClick={() => setEditing(p.id)}>{t('common.edit')}</button>
                      {p.status !== 'active' && (
                        <button className="primary" disabled={status.pending} onClick={() => void setStatus(p, 'active')}>
                          {t('products.publish')}
                        </button>
                      )}
                      {p.status === 'active' && (
                        <button disabled={status.pending} onClick={() => void setStatus(p, 'draft')}>
                          {t('products.unpublish')}
                        </button>
                      )}
                      {p.status !== 'archived' && (
                        <button className="danger" disabled={status.pending} onClick={() => void setStatus(p, 'archived')}>
                          {t('products.archive')}
                        </button>
                      )}
                    </>
                  )}
                </>
              }
            >
              <p className="muted small">
                {p.storeSlug} · <span dir="ltr">{p.slug}</span> · {p.categories.join(', ')}
              </p>
              <p className="small">{p.variants.map((v) => `${v.sku} (${sizeLabel(v.options)})`).join(' · ')}</p>
            </Card>
          ),
        )
      )}
    </>
  );
}

type Draft = {
  storeSlug: string;
  slug: string;
  category: string;
  gender: string;
  concentration: string;
  notes: { top: string; heart: string; base: string };
  translations: Record<string, { name: string; description: string }>;
  variants: { id?: string; sku: string; sizeMl: string }[];
};

function toDraft(p: Product | undefined, storeSlug: string): Draft {
  const notes = (p?.attributes.notes ?? {}) as Record<string, string[]>;
  return {
    storeSlug: p?.storeSlug ?? storeSlug,
    slug: p?.slug ?? '',
    category: p?.categories[0] ?? '',
    gender: p?.attributes.gender ?? 'unisex',
    concentration: p?.attributes.concentration ?? 'EDP',
    notes: { top: (notes.top ?? []).join(', '), heart: (notes.heart ?? []).join(', '), base: (notes.base ?? []).join(', ') },
    translations: Object.fromEntries((p?.translations ?? []).map((tr) => [tr.locale, { name: tr.name, description: tr.description ?? '' }])),
    variants: p?.variants.map((v) => ({ id: v.id, sku: v.sku, sizeMl: String(v.options.sizeMl ?? '') })) ?? [{ sku: '', sizeMl: '' }],
  };
}

const splitNotes = (value: string) => value.split(/[,،]/).map((n) => n.trim()).filter(Boolean);

/** Create or edit a perfume. Store and address are fixed once created. */
function ProductForm({ product, stores, onDone, onCancel }: { product?: Product; stores: MerchantStore[]; onDone: () => void; onCancel: () => void }) {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const [draft, setDraft] = useState<Draft>(() => toDraft(product, stores[0]?.storeSlug ?? ''));
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const action = useAction();

  useEffect(() => {
    if (!draft.storeSlug) return;
    void loadStore(draft.storeSlug).then(setStore);
    void api<Category[]>('GET', `/v1/stores/${draft.storeSlug}/categories`).then(setCategories);
  }, [draft.storeSlug]);

  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setTranslation = (locale: string, field: 'name' | 'description', value: string) =>
    update({ translations: { ...draft.translations, [locale]: { name: '', description: '', ...draft.translations[locale], [field]: value } } });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const translations = Object.entries(draft.translations)
      .filter(([, v]) => v.name.trim())
      .map(([locale, v]) => ({ locale, name: v.name.trim(), ...(v.description.trim() ? { description: v.description.trim() } : {}) }));
    const attributes = {
      gender: draft.gender,
      concentration: draft.concentration,
      notes: { top: splitNotes(draft.notes.top), heart: splitNotes(draft.notes.heart), base: splitNotes(draft.notes.base) },
    };
    const base = `/v1/merchants/${merchant.id}/products`;
    void action.run(async () => {
      if (!product) {
        await api('POST', base, {
          storeSlug: draft.storeSlug,
          slug: draft.slug,
          categorySlugs: draft.category ? [draft.category] : [],
          attributes,
          translations,
          variants: draft.variants.map((v) => ({ sku: v.sku, options: { sizeMl: Number(v.sizeMl) } })),
        });
      } else {
        await api('PATCH', `${base}/${product.id}`, { attributes, translations, categorySlugs: draft.category ? [draft.category] : [] });
        for (const v of draft.variants.filter((v) => !v.id && v.sku)) {
          await api('POST', `${base}/${product.id}/variants`, { sku: v.sku, options: { sizeMl: Number(v.sizeMl) } });
        }
      }
      onDone();
    });
  };

  return (
    <Card title={product ? nameIn(product.translations, locale) : t('products.new')}>
      <form className="stack" onSubmit={submit}>
        {!product && <p className="muted small">{t('products.draftHint')}</p>}
        <div className="form-grid">
          <Field label={t('products.store')}>
            <select value={draft.storeSlug} disabled={!!product} onChange={(e) => update({ storeSlug: e.target.value })}>
              {stores.map((s) => (
                <option key={s.storeSlug} value={s.storeSlug}>
                  {s.storeName}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('products.slug')} hint={t('merchants.slugHint')}>
            <input required disabled={!!product} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={draft.slug} onChange={(e) => update({ slug: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('products.category')}>
            <select value={draft.category} onChange={(e) => update({ category: e.target.value })}>
              <option value="">—</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('products.gender')}>
            <select value={draft.gender} onChange={(e) => update({ gender: e.target.value })}>
              {(['men', 'women', 'unisex'] as const).map((g) => (
                <option key={g} value={g}>
                  {t(`products.gender.${g}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('products.concentration')}>
            <select value={draft.concentration} onChange={(e) => update({ concentration: e.target.value })}>
              {['Parfum', 'EDP', 'EDT', 'EDC'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-grid">
          {(['top', 'heart', 'base'] as const).map((level) => (
            <Field key={level} label={t(level === 'top' ? 'products.notesTop' : level === 'heart' ? 'products.notesHeart' : 'products.notesBase')} hint={t('products.notesHint')}>
              <input value={draft.notes[level]} onChange={(e) => update({ notes: { ...draft.notes, [level]: e.target.value } })} />
            </Field>
          ))}
        </div>
        <h3>{t('products.translations')}</h3>
        {store?.locales.map((l) => (
          <div className="form-grid" key={l.code}>
            <Field label={t('products.nameIn', { lang: l.name })}>
              <input
                required={l.code === store.defaultLocale}
                dir={l.code === 'ar' ? 'rtl' : 'ltr'}
                value={draft.translations[l.code]?.name ?? ''}
                onChange={(e) => setTranslation(l.code, 'name', e.target.value)}
              />
            </Field>
            <Field label={t('products.descriptionIn', { lang: l.name })}>
              <textarea
                rows={2}
                dir={l.code === 'ar' ? 'rtl' : 'ltr'}
                value={draft.translations[l.code]?.description ?? ''}
                onChange={(e) => setTranslation(l.code, 'description', e.target.value)}
              />
            </Field>
          </div>
        ))}
        <h3>{t('products.variants')}</h3>
        {draft.variants.map((v, i) => (
          <div className="form-grid" key={v.id ?? `new-${i}`}>
            <Field label={t('products.sku')}>
              <input
                required={!product || i === 0}
                disabled={!!v.id}
                pattern="[A-Za-z0-9._\-]+"
                value={v.sku}
                dir="ltr"
                onChange={(e) => update({ variants: draft.variants.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)) })}
              />
            </Field>
            <Field label={t('products.sizeMl')}>
              <input
                type="number"
                min={1}
                disabled={!!v.id}
                value={v.sizeMl}
                onChange={(e) => update({ variants: draft.variants.map((x, j) => (j === i ? { ...x, sizeMl: e.target.value } : x)) })}
              />
            </Field>
          </div>
        ))}
        <div>
          <button type="button" onClick={() => update({ variants: [...draft.variants, { sku: '', sizeMl: '' }] })}>
            {t('products.addVariant')}
          </button>
        </div>
        <ErrorBox error={action.error} />
        <div className="row">
          <button className="primary" disabled={action.pending}>
            {product ? t('common.save') : t('common.create')}
          </button>
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </Card>
  );
}
