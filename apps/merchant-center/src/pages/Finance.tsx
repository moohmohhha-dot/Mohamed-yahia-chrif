import { api, ApiError, money } from '../api';
import { Card, ErrorBox, Loading, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';

type Balance = {
  currency: string;
  pendingMinor: number;
  availableMinor: number;
  settledMinor: number;
  totalOwedMinor: number;
  lifetime: { salesMinor: number; commissionMinor: number; feesMinor: number; refundsMinor: number; paidOutMinor: number };
};
type Line = { entryId: string; kind: string; account: string; currency: string; amountMinor: number; orderNumber: string | null; createdAt: string };
type Settlement = { id: string; number: string; currency: string; amountMinor: number; breakdown: Record<string, number>; createdAt: string };
type Payout = { id: string; amountMinor: number; currency: string; status: string; destination: Record<string, string>; externalReference: string | null; createdAt: string; paidAt: string | null };

const tone: Record<string, string> = { requested: 'warn', sent: 'warn', paid: 'good', failed: 'bad' };

function useFinance<T>(path: string) {
  const merchant = useMerchant();
  return useLoad(() => api<T>('GET', `/v1/merchants/${merchant.id}/finance/${path}`), [merchant.id, path]);
}

function Guard({ children, error }: { children: React.ReactNode; error: unknown }) {
  const { t } = useI18n();
  const merchant = useMerchant();
  if (!can(merchant.role, 'manageTeam') || (error instanceof ApiError && error.status === 403)) return <p className="muted">{t('finance.ownersOnly')}</p>;
  return <>{children}</>;
}

export function BalancePage() {
  const { t, locale } = useI18n();
  const balance = useFinance<Balance[]>('balance');
  const statement = useFinance<Line[]>('statement');
  const fmt = (v: number, c: string) => money.format(v, c, locale);
  return (
    <>
      <h1>{t('section.balance')}</h1>
      <Guard error={balance.error}>
        <div className="alert alert-warn">{t('finance.notMoney')}</div>
        {!balance.data ? (
          <Loading />
        ) : balance.data.length === 0 ? (
          <p className="muted">{t('finance.empty')}</p>
        ) : (
          balance.data.map((b) => (
            <div key={b.currency} className="stack" data-testid={`balance-${b.currency}`}>
              <div className="grid">
                {(
                  [
                    ['finance.pending', b.pendingMinor],
                    ['finance.available', b.availableMinor],
                    ['finance.settled', b.settledMinor],
                    ['finance.totalOwed', b.totalOwedMinor],
                  ] as [MessageKey, number][]
                ).map(([label, v]) => (
                  <div className="stat" key={label}>
                    <div className="muted small">{t(label)}</div>
                    <div className="value" dir="ltr" style={{ color: v < 0 ? 'var(--bad)' : undefined }}>
                      {fmt(v, b.currency)}
                    </div>
                  </div>
                ))}
              </div>
              <p className="muted small">
                {t('finance.pendingHint')} {t('finance.negativeHint')}
              </p>
              <Card title={t('finance.lifetime')}>
                <table>
                  <tbody>
                    {(
                      [
                        ['finance.sales', b.lifetime.salesMinor],
                        ['finance.commission', -b.lifetime.commissionMinor],
                        ['finance.fees', -b.lifetime.feesMinor],
                        ['finance.refunds', -b.lifetime.refundsMinor],
                        ['finance.paidOut', b.lifetime.paidOutMinor],
                      ] as [MessageKey, number][]
                    ).map(([label, v]) => (
                      <tr key={label}>
                        <td>{t(label)}</td>
                        <td className="num" dir="ltr">
                          {fmt(v, b.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ))
        )}
        <Card title={t('finance.statement')}>
          <p className="muted small">{t('finance.readOnly')}</p>
          <ErrorBox error={statement.error} />
          {statement.data && statement.data.length === 0 && <p className="muted">{t('finance.empty')}</p>}
          {statement.data && statement.data.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{t('finance.date')}</th>
                  <th>{t('inventory.reason')}</th>
                  <th>{t('orders.number')}</th>
                  <th>{t('finance.account')}</th>
                  <th className="num">{t('finance.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {statement.data.map((l, i) => (
                  <tr key={`${l.entryId}-${i}`}>
                    <td className="small">{new Date(l.createdAt).toLocaleString(locale)}</td>
                    <td>{t(`kind.${l.kind}` as MessageKey)}</td>
                    <td dir="ltr">{l.orderNumber ?? '—'}</td>
                    <td>{t(`acct.${l.account}` as MessageKey)}</td>
                    <td className="num" dir="ltr" style={{ color: l.amountMinor < 0 ? 'var(--bad)' : undefined }}>
                      {l.amountMinor > 0 ? '+' : ''}
                      {fmt(l.amountMinor, l.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </Guard>
    </>
  );
}

export function SettlementsPage() {
  const { t, locale } = useI18n();
  const settlements = useFinance<Settlement[]>('settlements');
  return (
    <>
      <h1>{t('section.settlements')}</h1>
      <Guard error={settlements.error}>
        {!settlements.data ? (
          <Loading />
        ) : settlements.data.length === 0 ? (
          <p className="muted">{t('finance.noSettlements')}</p>
        ) : (
          settlements.data.map((st) => (
            <Card key={st.id} title={<span dir="ltr">{st.number}</span>} actions={<strong dir="ltr">{money.format(st.amountMinor, st.currency, locale)}</strong>}>
              <p className="muted small">{new Date(st.createdAt).toLocaleString(locale)}</p>
              <table>
                <tbody>
                  {(
                    [
                      ['finance.sales', st.breakdown.salesMinor ?? 0],
                      ['finance.commission', -(st.breakdown.commissionMinor ?? 0)],
                      ['finance.fees', -(st.breakdown.feesMinor ?? 0)],
                      ['finance.refunds', -(st.breakdown.refundsMinor ?? 0)],
                    ] as [MessageKey, number][]
                  ).map(([label, v]) => (
                    <tr key={label}>
                      <td>{t(label)}</td>
                      <td className="num" dir="ltr">
                        {money.format(v, st.currency, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))
        )}
      </Guard>
    </>
  );
}

export function PayoutHistory() {
  const { t, locale } = useI18n();
  const payouts = useFinance<Payout[]>('payouts');
  if (payouts.error) return null;
  return (
    <Card title={t('section.payouts')}>
      {!payouts.data ? (
        <Loading />
      ) : payouts.data.length === 0 ? (
        <p className="muted">{t('finance.noPayouts')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('finance.date')}</th>
              <th className="num">{t('finance.amount')}</th>
              <th>{t('finance.destination')}</th>
              <th>{t('common.status')}</th>
              <th>{t('finance.reference')}</th>
            </tr>
          </thead>
          <tbody>
            {payouts.data.map((p) => (
              <tr key={p.id}>
                <td className="small">{new Date(p.createdAt).toLocaleString(locale)}</td>
                <td className="num" dir="ltr">
                  {money.format(p.amountMinor, p.currency, locale)}
                </td>
                <td>
                  {p.destination.holderName} · {t('verif.masked', { last4: p.destination.last4 ?? '' })}
                </td>
                <td>
                  <span className={`badge badge-${tone[p.status] ?? 'muted'}`}>{t(`payoutStatus.${p.status}` as MessageKey)}</span>
                </td>
                <td dir="ltr">{p.externalReference ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
