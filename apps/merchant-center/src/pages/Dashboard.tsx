import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, ErrorBox, Loading, StatusBadge, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { useMerchant } from '../merchant-context';

type Dashboard = {
  merchant: { canSell: boolean; verificationStatus: string };
  checks: { kind: string; status: string }[];
  stores: { storeSlug: string; storeName: string; commissionBps: number }[];
  products: Record<string, number>;
  offers: { active: number; archived: number; outOfStock: number; lowStock: number; units: number; reserved: number; available: number };
  recentMovements: { id: string; sku: string; delta: number; quantityAfter: number; reason: string; createdAt: string }[];
};

export function DashboardPage() {
  const { t, locale } = useI18n();
  const merchant = useMerchant();
  const { data, error } = useLoad(() => api<Dashboard>('GET', `/v1/merchants/${merchant.id}/dashboard`), [merchant.id]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const productTotal = Object.values(data.products).reduce((a, b) => a + b, 0);

  return (
    <>
      <h1>{t('section.dashboard')}</h1>
      <div className={`alert ${data.merchant.canSell ? 'alert-good' : 'alert-warn'}`}>
        {data.merchant.canSell ? t('dash.canSell') : t('dash.cannotSell')}{' '}
        {!data.merchant.canSell && <Link to={`/m/${merchant.id}/verification`}>{t('dash.verifyCta')}</Link>}
      </div>
      <div className="grid" style={{ marginBottom: 16 }}>
        <Stat label={t('dash.products')} value={productTotal} />
        <Stat label={t('dash.activeOffers')} value={data.offers.active} />
        <Stat label={t('dash.outOfStock')} value={data.offers.outOfStock} />
        <Stat label={t('dash.lowStock')} value={data.offers.lowStock} />
        <Stat label={t('dash.units')} value={data.offers.units} />
        <Stat label={t('dash.reserved')} value={data.offers.reserved} />
        <Stat label={t('dash.available')} value={data.offers.available} />
      </div>
      <Card title={t('section.verification')}>
        <div className="row">
          {data.checks.map((c) => (
            <span key={c.kind} className="row">
              {t(`check.${c.kind}` as MessageKey)} <StatusBadge status={c.status} />
            </span>
          ))}
        </div>
      </Card>
      <Card title={t('dash.stores')}>
        {data.stores.length === 0 ? (
          <p className="muted">{t('dash.noStores')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('products.store')}</th>
                <th className="num">{t('dash.commission')}</th>
              </tr>
            </thead>
            <tbody>
              {data.stores.map((s) => (
                <tr key={s.storeSlug}>
                  <td>{s.storeName}</td>
                  <td className="num">{(s.commissionBps / 100).toLocaleString(locale)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={t('dash.recent')}>
        {data.recentMovements.length === 0 ? (
          <p className="muted">{t('dash.noMovements')}</p>
        ) : (
          <table>
            <tbody>
              {data.recentMovements.map((m) => (
                <tr key={m.id}>
                  <td dir="ltr">{m.sku}</td>
                  <td>{t(`reason.${m.reason}` as MessageKey)}</td>
                  <td className="num" dir="ltr">{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                  <td className="num">{m.quantityAfter}</td>
                  <td className="muted small">{new Date(m.createdAt).toLocaleString(locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
