import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, ErrorBox, Loading, StatusBadge, useLoad } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { can, useMerchant } from '../merchant-context';

type Overview = { checks: { kind: string; status: string }[] };
type Profile = { payoutMethod: { type: string; holderName: string; accountNumberLast4: string; currency: string } | null };

/** Payout account status now; payout history arrives with the finance module (phase 2). */
export function PayoutsPage() {
  const { t } = useI18n();
  const merchant = useMerchant();
  const overview = useLoad(() => api<Overview>('GET', `/v1/merchants/${merchant.id}/verification`), [merchant.id]);
  const profile = useLoad(
    () => (can(merchant.role, 'manageTeam') ? api<Profile>('GET', `/v1/merchants/${merchant.id}/profile`) : Promise.resolve(null)),
    [merchant.id],
  );
  if (overview.error) return <ErrorBox error={overview.error} />;
  if (!overview.data) return <Loading />;
  const payout = overview.data.checks.find((c) => c.kind === 'payout');
  const method = profile.data?.payoutMethod;
  return (
    <>
      <h1>{t('section.payouts')}</h1>
      <Card title={t('payouts.method')} actions={payout && <StatusBadge status={payout.status} />}>
        {method ? (
          <p>
            {t(`payoutType.${method.type}` as MessageKey)} · {method.holderName} · {t('verif.masked', { last4: method.accountNumberLast4 })} · {method.currency}
          </p>
        ) : (
          <p className="muted">
            {t('payouts.none')} <Link to={`/m/${merchant.id}/verification`}>{t('section.verification')}</Link>
          </p>
        )}
      </Card>
      <Card title={t('soon.title', { phase: 2 })}>
        <p>{t('soon.payouts')}</p>
        <div className="alert alert-warn">{t('soon.rules')}</div>
      </Card>
    </>
  );
}
