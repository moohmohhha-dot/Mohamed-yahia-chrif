import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Card, ErrorBox, Loading, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';

type Overview = {
  queues: { key: string; section: string; count: number }[];
  numbers: {
    users?: { total: number; new7d: number };
    merchants?: Record<string, number>;
    orders?: { today: number; last7d: number; inProgress: number };
    sales7d?: { currency: string; totalMinor: number; orders: number }[];
  };
};

/** Home: the work waiting for this staff member's roles, then the key numbers. */
export function OverviewPage() {
  const { t, money, label } = useI18n();
  const { staff } = useAuth();
  const data = useLoad(() => api<Overview>('GET', '/v1/admin/overview'), []);
  if (data.error) return <ErrorBox error={data.error} />;
  if (!data.data) return <Loading />;
  const { queues, numbers } = data.data;
  const waiting = queues.filter((q) => q.count > 0);

  return (
    <>
      <h1>{t('overview.hello', { name: staff!.displayName })}</h1>
      <Card title={t('overview.waiting')}>
        {waiting.length === 0 ? (
          <p className="muted">{t('overview.nothingWaiting')}</p>
        ) : (
          <div className="grid" data-testid="queues">
            {waiting.map((q) => (
              <Link key={q.key} to={`/${q.section}`} className="stat queue">
                <div className="value">{q.count}</div>
                <div className="small">{t(`queue.${q.key}` as MessageKey)}</div>
              </Link>
            ))}
          </div>
        )}
      </Card>
      <div className="grid">
        {numbers.users && (
          <div className="stat">
            <div className="muted small">{t('overview.users')}</div>
            <div className="value">{numbers.users.total}</div>
            <div className="small muted">{t('overview.new7d', { n: numbers.users.new7d })}</div>
          </div>
        )}
        {numbers.orders && (
          <div className="stat">
            <div className="muted small">{t('overview.orders')}</div>
            <div className="value">{numbers.orders.today}</div>
            <div className="small muted">{t('overview.ordersDetail', { week: numbers.orders.last7d, open: numbers.orders.inProgress })}</div>
          </div>
        )}
        {numbers.sales7d?.map((s) => (
          <div className="stat" key={s.currency}>
            <div className="muted small">{t('overview.sales7d', { currency: s.currency })}</div>
            <div className="value" style={{ fontSize: '1.3rem' }}>
              {money(s.totalMinor, s.currency)}
            </div>
            <div className="small muted">{t('overview.ordersCount', { n: s.orders })}</div>
          </div>
        ))}
        {numbers.merchants && (
          <div className="stat">
            <div className="muted small">{t('overview.merchants')}</div>
            {Object.entries(numbers.merchants).map(([status, n]) => (
              <div key={status} className="small">
                {label('verificationStatus', status)}: <strong>{n}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
