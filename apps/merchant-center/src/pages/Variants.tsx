import { api } from '../api';
import { Card, ErrorBox, Loading, StatusBadge, useAction, useLoad } from '../components/ui';
import { useI18n } from '../i18n';
import { can, useMerchant } from '../merchant-context';
import { nameIn, sizeLabel, type Product } from './common';

export function VariantsPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const { data, error, reload } = useLoad(() => api<Product[]>('GET', `/v1/merchants/${merchant.id}/products`), [merchant.id]);
  const action = useAction();
  const toggle = (productId: string, variantId: string, isActive: boolean) =>
    action.run(async () => {
      await api('PATCH', `/v1/merchants/${merchant.id}/products/${productId}/variants/${variantId}`, { isActive });
      await reload();
    });

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const rows = data.flatMap((p) => p.variants.map((v) => ({ product: p, variant: v })));
  return (
    <>
      <h1>{t('section.variants')}</h1>
      <Card title={t('variants.title')}>
        <ErrorBox error={action.error} />
        {rows.length === 0 ? (
          <p className="muted">{t('products.empty')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('variants.product')}</th>
                <th>{t('products.sku')}</th>
                <th>{t('products.sizeMl')}</th>
                <th>{t('common.status')}</th>
                <th>{t('variants.offer')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ product, variant }) => (
                <tr key={variant.id}>
                  <td>{nameIn(product.translations, locale)}</td>
                  <td dir="ltr">{variant.sku}</td>
                  <td>{sizeLabel(variant.options)}</td>
                  <td>{variant.isActive ? t('variants.active') : t('variants.inactive')}</td>
                  <td>
                    {variant.myOffer ? (
                      <span className="row">
                        <StatusBadge status={variant.myOffer.status} /> {t('inventory.stock')}: {variant.myOffer.stock}
                      </span>
                    ) : (
                      <span className="muted">{t('variants.noOffer')}</span>
                    )}
                  </td>
                  <td className="num">
                    {can(merchant.role, 'manageProducts') && (
                      <button disabled={action.pending} onClick={() => void toggle(product.id, variant.id, !variant.isActive)}>
                        {variant.isActive ? t('variants.disable') : t('variants.enable')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
