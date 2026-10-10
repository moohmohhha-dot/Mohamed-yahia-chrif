import { useState } from 'react';
import { api } from '../api';
import { Card, ErrorBox, Loading, useLoad } from '../components/ui';
import { useI18n } from '../i18n';

type Day = { day: string; users: number; merchants: number; orders: number; cancelled: number; sales: Record<string, number> };
type Data = {
  days: Day[];
  ordersByStatus: Record<string, number>;
  ordersByPaymentMethod: Record<string, number>;
  topMerchants: { merchantId: string; name: string; currency: string; orders: number; totalMinor: number }[];
  refunded: { currency: string; refundedMinor: number }[];
};

function Bars({ values, title }: { values: { label: string; value: number }[]; title: string }) {
  const { t } = useI18n();
  const max = Math.max(1, ...values.map((v) => v.value));
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong className="small">{title}</strong>
        <span className="muted small">{t('analytics.max', { n: max })}</span>
      </div>
      <div className="bars" role="img" aria-label={title}>
        {values.map((v) => (
          <div key={v.label} className="bar" title={`${v.label}: ${v.value}`} style={{ height: `${(v.value / max) * 100}%` }} />
        ))}
      </div>
      <div className="row muted small" style={{ justifyContent: 'space-between' }}>
        <span>{values[0]?.label}</span>
        <span>{values.at(-1)?.label}</span>
      </div>
    </div>
  );
}

/** Real figures from orders, sign-ups and refunds. Amounts are kept per currency, never converted. */
export function AnalyticsPage() {
  const { t, money, label } = useI18n();
  const [days, setDays] = useState(30);
  const data = useLoad(() => api<Data>('GET', `/v1/admin/analytics?days=${days}`), [days]);
  const d = data.data;
  const currencies = d ? [...new Set(d.days.flatMap((x) => Object.keys(x.sales)))] : [];
  const sum = (f: (x: Day) => number) => (d ? d.days.reduce((a, x) => a + f(x), 0) : 0);

  return (
    <>
      <div className="topbar">
        <h1>{t('section.analytics')}</h1>
        <div className="row">
          {[7, 30, 90].map((n) => (
            <button key={n} className={days === n ? 'primary' : ''} onClick={() => setDays(n)}>
              {t('analytics.days', { n })}
            </button>
          ))}
        </div>
      </div>
      <ErrorBox error={data.error} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <div className="grid">
            <div className="stat">
              <div className="muted small">{t('overview.orders')}</div>
              <div className="value">{sum((x) => x.orders)}</div>
              <div className="small muted">{t('analytics.cancelled', { n: sum((x) => x.cancelled) })}</div>
            </div>
            {currencies.map((c) => (
              <div className="stat" key={c}>
                <div className="muted small">{t('analytics.sales', { currency: c })}</div>
                <div className="value" style={{ fontSize: '1.3rem' }}>
                  {money(sum((x) => x.sales[c] ?? 0), c)}
                </div>
              </div>
            ))}
            <div className="stat">
              <div className="muted small">{t('analytics.newUsers')}</div>
              <div className="value">{sum((x) => x.users)}</div>
              <div className="small muted">{t('analytics.newMerchants', { n: sum((x) => x.merchants) })}</div>
            </div>
          </div>
          <Card>
            <div className="stack">
              <Bars title={t('analytics.ordersPerDay')} values={d.days.map((x) => ({ label: x.day, value: x.orders }))} />
              {currencies.map((c) => (
                <Bars key={c} title={t('analytics.salesPerDay', { currency: c })} values={d.days.map((x) => ({ label: x.day, value: Math.round((x.sales[c] ?? 0) / 100) }))} />
              ))}
              <Bars title={t('analytics.signupsPerDay')} values={d.days.map((x) => ({ label: x.day, value: x.users }))} />
            </div>
          </Card>
          <div className="split">
            <Card title={t('analytics.byStatus')}>
              <table>
                <tbody>
                  {Object.entries(d.ordersByStatus).map(([k, v]) => (
                    <tr key={k}>
                      <td>{label('orderStatus', k)}</td>
                      <td className="num">{v}</td>
                    </tr>
                  ))}
                  {Object.entries(d.ordersByPaymentMethod).map(([k, v]) => (
                    <tr key={k}>
                      <td>{label('paymentMethod', k)}</td>
                      <td className="num">{v}</td>
                    </tr>
                  ))}
                  {d.refunded.map((r) => (
                    <tr key={r.currency}>
                      <td>{t('analytics.refunded')}</td>
                      <td className="num">{money(r.refundedMinor, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title={t('analytics.topMerchants')}>
              <table>
                <tbody>
                  {d.topMerchants.map((m) => (
                    <tr key={m.merchantId + m.currency}>
                      <td>{m.name}</td>
                      <td className="num">{m.orders}</td>
                      <td className="num">{money(m.totalMinor, m.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
